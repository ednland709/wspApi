package whatsapp

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"wspapi-go/internal/hub"
)

var validSessionIDRegex = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

type Manager struct {
	mu               sync.Mutex
	sessions         map[string]*Session
	sessionsDir      string
	sessionTimeout   time.Duration
	messageStatusTTL time.Duration
	hub              *hub.Hub
}

func NewManager(sessionsDir string, sessionTimeout, messageStatusTTL time.Duration, wsHub *hub.Hub) (*Manager, error) {
	if err := os.MkdirAll(sessionsDir, 0o750); err != nil {
		return nil, fmt.Errorf("no se pudo crear directorio de sesiones: %w", err)
	}
	return &Manager{
		sessions:         make(map[string]*Session),
		sessionsDir:      sessionsDir,
		sessionTimeout:   sessionTimeout,
		messageStatusTTL: messageStatusTTL,
		hub:              wsHub,
	}, nil
}

func ValidateSessionID(sessionID string) error {
	if !validSessionIDRegex.MatchString(sessionID) {
		return fmt.Errorf("sessionId inválido: solo se permiten letras, números, '.', '_' y '-'")
	}
	return nil
}

func (m *Manager) dbPathFor(sessionID string) string {
	return filepath.Join(m.sessionsDir, sessionID+".db")
}

func (m *Manager) CreateSession(sessionID string) (*Session, error) {
	if err := ValidateSessionID(sessionID); err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[sessionID]; ok {
		return existing, nil
	}

	log.Printf("[Manager] Creando nueva sesión para %s", sessionID)
	s := newSession(
		sessionID,
		m.dbPathFor(sessionID),
		m.sessionTimeout,
		m.messageStatusTTL,
		m.hub,
		func(id string) {
			m.DisconnectIdle(id)
		},
		func(id string) {
			_ = m.DeleteSession(context.Background(), id)
		},
	)
	m.sessions[sessionID] = s
	return s, nil
}

func (m *Manager) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	if err := ValidateSessionID(sessionID); err != nil {
		return nil, err
	}

	m.mu.Lock()
	s, existsInMem := m.sessions[sessionID]
	m.mu.Unlock()

	if existsInMem && s.IsReady() {
		return s, nil
	}

	dbPath := m.dbPathFor(sessionID)
	if _, err := os.Stat(dbPath); err == nil {
		if !existsInMem {
			var createErr error
			s, createErr = m.CreateSession(sessionID)
			if createErr != nil {
				return nil, createErr
			}
		}
		log.Printf("[Manager] Restaurando sesión %s desde SQLite...", sessionID)
		if err := s.Connect(ctx); err != nil {
			log.Printf("[%s] Error al restaurar sesión desde disco: %v", sessionID, err)
			return nil, nil
		}
		return s, nil
	}

	if existsInMem {
		return s, nil
	}
	return nil, nil
}

func (m *Manager) DisconnectIdle(sessionID string) {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if ok {
		s.Disconnect()
	}
}

func (m *Manager) DeleteSession(ctx context.Context, sessionID string) error {
	if err := ValidateSessionID(sessionID); err != nil {
		return err
	}

	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if ok {
		log.Printf("[Manager] Cerrando y eliminando sesión %s", sessionID)
		logoutCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		s.Logout(logoutCtx)
	}

	basePath := m.dbPathFor(sessionID)
	for _, path := range []string{basePath, basePath + "-wal", basePath + "-shm"} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			log.Printf("[Manager] Error eliminando archivo %s: %v", path, err)
		}
	}
	return nil
}

func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range sessions {
		s.Disconnect()
	}
}
