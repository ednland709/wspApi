package hub

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 45 * time.Second
)

type OutgoingEvent struct {
	Event string `json:"event"`
	Data  any    `json:"data"`
}

type incomingMessage struct {
	Event     string `json:"event"`
	SessionID string `json:"sessionId"`
}

type clientConn struct {
	conn     *websocket.Conn
	send     chan []byte
	sessions map[string]struct{}
}

type Hub struct {
	mu          sync.RWMutex
	rooms       map[string]map[*clientConn]struct{}
	checkOrigin func(origin string) bool
	upgrader    websocket.Upgrader
}

func New(checkOrigin func(origin string) bool) *Hub {
	h := &Hub{
		rooms:       make(map[string]map[*clientConn]struct{}),
		checkOrigin: checkOrigin,
	}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			return h.checkOrigin(r.Header.Get("Origin"))
		},
	}
	return h
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Error actualizando conexión WebSocket: %v", err)
		return
	}

	c := &clientConn{
		conn:     conn,
		send:     make(chan []byte, 64),
		sessions: make(map[string]struct{}),
	}

	if sessionID := strings.TrimSpace(r.URL.Query().Get("sessionId")); sessionID != "" {
		h.join(c, sessionID)
	}

	go h.writePump(c)
	h.readPump(c)
}

func (h *Hub) Emit(sessionID, event string, data any) {
	payload, err := json.Marshal(OutgoingEvent{
		Event: event,
		Data:  data,
	})
	if err != nil {
		log.Printf("[WS] Error serializando evento %s: %v", event, err)
		return
	}

	h.mu.RLock()
	room := h.rooms[sessionID]
	targets := make([]*clientConn, 0, len(room))
	for c := range room {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		select {
		case c.send <- payload:
		default:
			log.Printf("[WS] Buffer lleno para cliente en sala %s, descartando evento %s", sessionID, event)
		}
	}
}

func (h *Hub) join(c *clientConn, sessionID string) {
	if sessionID == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.rooms[sessionID] == nil {
		h.rooms[sessionID] = make(map[*clientConn]struct{})
	}
	h.rooms[sessionID][c] = struct{}{}
	c.sessions[sessionID] = struct{}{}
	log.Printf("[WS] Cliente unido a la sala %s", sessionID)
}

func (h *Hub) leaveAll(c *clientConn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for sessionID := range c.sessions {
		if room, ok := h.rooms[sessionID]; ok {
			delete(room, c)
			if len(room) == 0 {
				delete(h.rooms, sessionID)
			}
		}
	}
	c.sessions = make(map[string]struct{})
	close(c.send)
}

func (h *Hub) readPump(c *clientConn) {
	defer func() {
		h.leaveAll(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(4096)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg incomingMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		if msg.Event == "join-session" && strings.TrimSpace(msg.SessionID) != "" {
			h.join(c, strings.TrimSpace(msg.SessionID))
		}
	}
}

func (h *Hub) writePump(c *clientConn) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
