package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	"wspapi-go/internal/hub"
)

const postConnectWarmup = 1500 * time.Millisecond

var nonDigitsRegex = regexp.MustCompile(`\D+`)

type OutgoingMessageStatus string

const (
	StatusPending   OutgoingMessageStatus = "pending"
	StatusSent      OutgoingMessageStatus = "sent"
	StatusDelivered OutgoingMessageStatus = "delivered"
	StatusRead      OutgoingMessageStatus = "read"
	StatusPlayed    OutgoingMessageStatus = "played"
	StatusFailed    OutgoingMessageStatus = "failed"
)

type OutgoingMessage struct {
	MessageID string                `json:"messageId"`
	ChatID    string                `json:"chatId"`
	Status    OutgoingMessageStatus `json:"status"`
	SentAt    string                `json:"sentAt"`
	UpdatedAt string                `json:"updatedAt"`
}

type ConnectionState string

const (
	StateClose      ConnectionState = "close"
	StateConnecting ConnectionState = "connecting"
	StateOpen       ConnectionState = "open"
)

type Session struct {
	ID string

	mu               sync.RWMutex
	dbPath           string
	container        *sqlstore.Container
	client           *whatsmeow.Client
	state            ConnectionState
	currentQR        string
	connectedAt      time.Time
	idleTimer        *time.Timer
	idleTimeout      time.Duration
	messageStatusTTL time.Duration

	outgoingMessages map[string]OutgoingMessage

	readyWaiters  []chan error
	qrWaiters     []chan qrResult
	hub           *hub.Hub
	onIdle        func(sessionID string)
	onLoggedOut   func(sessionID string)
}

type qrResult struct {
	qr  string
	err error
}

func newSession(
	sessionID string,
	dbPath string,
	idleTimeout time.Duration,
	messageStatusTTL time.Duration,
	wsHub *hub.Hub,
	onIdle func(string),
	onLoggedOut func(string),
) *Session {
	s := &Session{
		ID:               sessionID,
		dbPath:           dbPath,
		state:            StateClose,
		idleTimeout:      idleTimeout,
		messageStatusTTL: messageStatusTTL,
		outgoingMessages: make(map[string]OutgoingMessage),
		hub:              wsHub,
		onIdle:           onIdle,
		onLoggedOut:      onLoggedOut,
	}
	s.resetIdleTimerLocked()
	return s
}

func (s *Session) Connect(ctx context.Context) error {
	s.mu.Lock()
	if s.client != nil && (s.state == StateOpen || s.state == StateConnecting) {
		s.resetIdleTimerLocked()
		s.mu.Unlock()
		return nil
	}
	s.state = StateConnecting
	s.resetIdleTimerLocked()
	s.mu.Unlock()

	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", s.dbPath)
	dbLogger := waLog.Stdout("DB-"+s.ID, "WARN", true)
	container, err := sqlstore.New(ctx, "sqlite", dsn, dbLogger)
	if err != nil {
		s.setClosed(err)
		return fmt.Errorf("error abriendo SQLite de sesión: %w", err)
	}

	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		_ = container.Close()
		s.setClosed(err)
		return fmt.Errorf("error obteniendo dispositivo de SQLite: %w", err)
	}

	clientLogger := waLog.Stdout("WA-"+s.ID, "INFO", true)
	cli := whatsmeow.NewClient(deviceStore, clientLogger)
	cli.AddEventHandler(s.handleEvent)

	s.mu.Lock()
	s.container = container
	s.client = cli
	s.mu.Unlock()

	if cli.Store.ID == nil {
		qrChan, err := cli.GetQRChannel(context.Background())
		if err != nil {
			s.Disconnect()
			return fmt.Errorf("error iniciando canal QR: %w", err)
		}
		if err := cli.Connect(); err != nil {
			s.Disconnect()
			return fmt.Errorf("error conectando cliente WhatsApp: %w", err)
		}
		go s.consumeQRChannel(qrChan)
		return nil
	}

	if err := cli.Connect(); err != nil {
		s.Disconnect()
		return fmt.Errorf("error reconectando sesión existente: %w", err)
	}
	return nil
}

func (s *Session) consumeQRChannel(qrChan <-chan whatsmeow.QRChannelItem) {
	for evt := range qrChan {
		switch evt.Event {
		case "code":
			s.mu.Lock()
			s.currentQR = evt.Code
			waiters := s.qrWaiters
			s.qrWaiters = nil
			s.mu.Unlock()
			for _, ch := range waiters {
				ch <- qrResult{qr: evt.Code}
			}
		case "success":
			s.mu.Lock()
			s.currentQR = ""
			waiters := s.qrWaiters
			s.qrWaiters = nil
			s.mu.Unlock()
			for _, ch := range waiters {
				ch <- qrResult{qr: ""}
			}
		case "timeout", "err-client-outdated", "err-scanned-without-multidevice":
			err := fmt.Errorf("evento QR fallido: %s", evt.Event)
			s.mu.Lock()
			s.currentQR = ""
			waiters := s.qrWaiters
			s.qrWaiters = nil
			s.mu.Unlock()
			for _, ch := range waiters {
				ch <- qrResult{err: err}
			}
		}
	}
}

func (s *Session) handleEvent(rawEvt any) {
	switch evt := rawEvt.(type) {
	case *events.Connected:
		s.mu.Lock()
		s.state = StateOpen
		s.currentQR = ""
		s.connectedAt = time.Now()
		s.resetIdleTimerLocked()
		readyWaiters := s.readyWaiters
		s.readyWaiters = nil
		qrWaiters := s.qrWaiters
		s.qrWaiters = nil
		s.mu.Unlock()

		log.Printf("[%s] Conexión abierta y cliente listo!", s.ID)
		for _, ch := range readyWaiters {
			ch <- nil
		}
		for _, ch := range qrWaiters {
			ch <- qrResult{qr: ""}
		}
		s.hub.Emit(s.ID, "session-ready", map[string]string{"sessionId": s.ID})

	case *events.Disconnected:
		s.mu.Lock()
		s.state = StateClose
		s.mu.Unlock()
		log.Printf("[%s] Conexión cerrada temporalmente.", s.ID)

	case *events.LoggedOut:
		log.Printf("[%s] Sesión cerrada desde el dispositivo (LoggedOut): %v", s.ID, evt.Reason)
		s.setClosed(errors.New("sesión cerrada desde WhatsApp"))
		if s.onLoggedOut != nil {
			go s.onLoggedOut(s.ID)
		}

	case *events.Receipt:
		var nextStatus OutgoingMessageStatus
		switch evt.Type {
		case types.ReceiptTypeDelivered:
			nextStatus = StatusDelivered
		case types.ReceiptTypeRead, types.ReceiptTypeReadSelf:
			nextStatus = StatusRead
		case types.ReceiptTypePlayed, types.ReceiptTypePlayedSelf:
			nextStatus = StatusPlayed
		default:
			return
		}
		for _, msgID := range evt.MessageIDs {
			s.updateOutgoingStatus(string(msgID), nextStatus)
		}
	}
}

func (s *Session) WaitForQR(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.state == StateOpen {
		s.mu.Unlock()
		return "", nil
	}
	if s.currentQR != "" {
		qr := s.currentQR
		s.mu.Unlock()
		return qr, nil
	}
	ch := make(chan qrResult, 1)
	s.qrWaiters = append(s.qrWaiters, ch)
	s.mu.Unlock()

	select {
	case res := <-ch:
		return res.qr, res.err
	case <-ctx.Done():
		return "", errors.New("Timeout esperando el código QR")
	}
}

func (s *Session) WaitForReady(ctx context.Context) error {
	s.mu.Lock()
	if s.state == StateOpen && s.client != nil && s.client.IsConnected() {
		s.resetIdleTimerLocked()
		s.mu.Unlock()
		return nil
	}
	ch := make(chan error, 1)
	s.readyWaiters = append(s.readyWaiters, ch)
	s.mu.Unlock()

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		return errors.New("Timeout esperando que la sesión esté lista.")
	}
}

func (s *Session) IsReady() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resetIdleTimerLocked()
	return s.state == StateOpen && s.client != nil && s.client.IsConnected()
}

func (s *Session) State() ConnectionState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state
}

func (s *Session) CurrentQR() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentQR
}

func (s *Session) PhoneNumber() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.client != nil && s.client.Store != nil && s.client.Store.ID != nil {
		return s.client.Store.ID.User
	}
	return ""
}

func (s *Session) Disconnect() {
	s.mu.Lock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	cli := s.client
	container := s.container
	s.client = nil
	s.container = nil
	s.state = StateClose
	s.currentQR = ""
	s.mu.Unlock()

	if cli != nil {
		cli.Disconnect()
	}
	if container != nil {
		_ = container.Close()
	}
}

func (s *Session) Logout(ctx context.Context) {
	s.mu.RLock()
	cli := s.client
	s.mu.RUnlock()

	if cli != nil && cli.IsConnected() {
		_ = cli.Logout(ctx)
	}
	s.Disconnect()
}

func (s *Session) setClosed(err error) {
	s.mu.Lock()
	s.state = StateClose
	readyWaiters := s.readyWaiters
	s.readyWaiters = nil
	qrWaiters := s.qrWaiters
	s.qrWaiters = nil
	s.mu.Unlock()

	for _, ch := range readyWaiters {
		ch <- err
	}
	for _, ch := range qrWaiters {
		ch <- qrResult{err: err}
	}
}

func (s *Session) resetIdleTimerLocked() {
	if s.idleTimeout <= 0 {
		return
	}
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.idleTimer = time.AfterFunc(s.idleTimeout, func() {
		log.Printf("[%s] Sesión inactiva, desconectando...", s.ID)
		if s.onIdle != nil {
			s.onIdle(s.ID)
		}
	})
}

func (s *Session) resolveUserJID(ctx context.Context, to string) (types.JID, error) {
	s.mu.RLock()
	cli := s.client
	s.mu.RUnlock()
	if cli == nil || !s.IsReady() {
		return types.EmptyJID, errors.New("El cliente de WhatsApp no está listo.")
	}

	raw := strings.TrimSpace(to)
	if strings.HasSuffix(raw, "@s.whatsapp.net") {
		raw = strings.TrimSuffix(raw, "@s.whatsapp.net")
	}
	digits := nonDigitsRegex.ReplaceAllString(raw, "")
	if digits == "" {
		return types.EmptyJID, fmt.Errorf("El número %s no existe en WhatsApp.", to)
	}

	resp, err := cli.IsOnWhatsApp(ctx, []string{"+" + digits})
	if err != nil {
		return types.EmptyJID, fmt.Errorf("error validando número en WhatsApp: %w", err)
	}
	if len(resp) == 0 || !resp[0].IsIn {
		return types.EmptyJID, fmt.Errorf("El número %s no existe en WhatsApp.", to)
	}
	return resp[0].JID, nil
}

func (s *Session) SendTextMessage(ctx context.Context, to, message string) (OutgoingMessage, error) {
	jid, err := s.resolveUserJID(ctx, to)
	if err != nil {
		return OutgoingMessage{}, err
	}
	return s.sendTracked(ctx, jid, &waE2E.Message{
		Conversation: proto.String(message),
	})
}

func (s *Session) SendPDFMessage(ctx context.Context, to string, pdfBytes []byte, fileName, caption string) (OutgoingMessage, error) {
	jid, err := s.resolveUserJID(ctx, to)
	if err != nil {
		return OutgoingMessage{}, err
	}
	return s.sendPDFToJID(ctx, jid, pdfBytes, fileName, caption)
}

func (s *Session) GetGroupJIDByName(ctx context.Context, name string) (types.JID, error) {
	s.mu.RLock()
	cli := s.client
	s.mu.RUnlock()
	if cli == nil || !s.IsReady() {
		return types.EmptyJID, errors.New("El cliente de WhatsApp no está listo.")
	}

	groups, err := cli.GetJoinedGroups(ctx)
	if err != nil {
		return types.EmptyJID, err
	}
	for _, g := range groups {
		if g.Name == name {
			return g.JID, nil
		}
	}
	return types.EmptyJID, nil
}

func (s *Session) SendGroupPDFMessage(ctx context.Context, groupJID types.JID, pdfBytes []byte, fileName, caption string) (OutgoingMessage, error) {
	return s.sendPDFToJID(ctx, groupJID, pdfBytes, fileName, caption)
}

func (s *Session) sendPDFToJID(ctx context.Context, jid types.JID, pdfBytes []byte, fileName, caption string) (OutgoingMessage, error) {
	s.mu.RLock()
	cli := s.client
	s.mu.RUnlock()
	if cli == nil || !s.IsReady() {
		return OutgoingMessage{}, errors.New("El cliente de WhatsApp no está listo.")
	}

	uploaded, err := cli.Upload(ctx, pdfBytes, whatsmeow.MediaDocument)
	if err != nil {
		return OutgoingMessage{}, fmt.Errorf("error subiendo PDF a WhatsApp: %w", err)
	}

	doc := &waE2E.DocumentMessage{
		URL:           proto.String(uploaded.URL),
		DirectPath:    proto.String(uploaded.DirectPath),
		MediaKey:      uploaded.MediaKey,
		Mimetype:      proto.String("application/pdf"),
		Title:         proto.String(fileName),
		FileName:      proto.String(fileName),
		FileLength:    proto.Uint64(uploaded.FileLength),
		FileSHA256:    uploaded.FileSHA256,
		FileEncSHA256: uploaded.FileEncSHA256,
	}
	if caption != "" {
		doc.Caption = proto.String(caption)
	}

	return s.sendTracked(ctx, jid, &waE2E.Message{DocumentMessage: doc})
}

func (s *Session) sendTracked(ctx context.Context, jid types.JID, msg *waE2E.Message) (OutgoingMessage, error) {
	s.mu.RLock()
	connectedAt := s.connectedAt
	cli := s.client
	s.mu.RUnlock()

	if !connectedAt.IsZero() {
		if elapsed := time.Since(connectedAt); elapsed < postConnectWarmup {
			select {
			case <-time.After(postConnectWarmup - elapsed):
			case <-ctx.Done():
				return OutgoingMessage{}, ctx.Err()
			}
		}
	}

	if cli == nil || !s.IsReady() {
		return OutgoingMessage{}, errors.New("El cliente de WhatsApp no está listo.")
	}

	msgID := cli.GenerateMessageID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	record := OutgoingMessage{
		MessageID: string(msgID),
		ChatID:    jid.String(),
		Status:    StatusPending,
		SentAt:    now,
		UpdatedAt: now,
	}

	s.mu.Lock()
	s.outgoingMessages[record.MessageID] = record
	s.pruneOutgoingLocked()
	s.mu.Unlock()
	s.hub.Emit(s.ID, "message-status", record)

	_, err := cli.SendMessage(ctx, jid, msg, whatsmeow.SendRequestExtra{ID: msgID})
	if err != nil {
		s.updateOutgoingStatus(record.MessageID, StatusFailed)
		return OutgoingMessage{}, err
	}

	updated := s.updateOutgoingStatus(record.MessageID, StatusSent)
	return updated, nil
}

func (s *Session) GetOutgoingMessage(messageID string) (OutgoingMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneOutgoingLocked()
	msg, ok := s.outgoingMessages[messageID]
	return msg, ok
}

func (s *Session) updateOutgoingStatus(messageID string, nextStatus OutgoingMessageStatus) OutgoingMessage {
	s.mu.Lock()
	current, ok := s.outgoingMessages[messageID]
	if !ok {
		s.mu.Unlock()
		return OutgoingMessage{}
	}

	if nextStatus == StatusFailed {
		if current.Status != StatusPending {
			s.mu.Unlock()
			return current
		}
	} else if current.Status == StatusFailed || statusRank(nextStatus) <= statusRank(current.Status) {
		s.mu.Unlock()
		return current
	}

	current.Status = nextStatus
	current.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.outgoingMessages[messageID] = current
	s.mu.Unlock()

	s.hub.Emit(s.ID, "message-status", current)
	return current
}

func (s *Session) pruneOutgoingLocked() {
	cutoff := time.Now().UTC().Add(-s.messageStatusTTL)
	for id, msg := range s.outgoingMessages {
		sentAt, err := time.Parse(time.RFC3339Nano, msg.SentAt)
		if err == nil && sentAt.Before(cutoff) {
			delete(s.outgoingMessages, id)
		}
	}
}

func statusRank(st OutgoingMessageStatus) int {
	switch st {
	case StatusPending:
		return 0
	case StatusSent:
		return 1
	case StatusDelivered:
		return 2
	case StatusRead:
		return 3
	case StatusPlayed:
		return 4
	default:
		return -1
	}
}
