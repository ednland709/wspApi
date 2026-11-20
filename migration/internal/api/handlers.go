package api

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"wspapi-go/internal/config"
	"wspapi-go/internal/whatsapp"
)

type Handler struct {
	manager *whatsapp.Manager
	cfg     config.Config
}

func NewHandler(manager *whatsapp.Manager, cfg config.Config) *Handler {
	return &Handler{
		manager: manager,
		cfg:     cfg,
	}
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /", h.healthCheck)

	// Sesiones
	mux.HandleFunc("POST /api/sessions", h.createSession)
	mux.HandleFunc("DELETE /api/sessions/{sessionId}", h.deleteSession)
	mux.HandleFunc("GET /api/sessions/{sessionId}", h.getSessionStatus)

	// Mensajes
	mux.HandleFunc("GET /api/messages/{sessionId}/{messageId}/status", h.getMessageStatus)
	mux.HandleFunc("POST /api/messages/send-text", h.sendText)
	mux.HandleFunc("POST /api/messages/send-pdf", h.sendPDF)
	mux.HandleFunc("POST /api/messages/send-contact", h.sendText)
	mux.HandleFunc("POST /api/messages/send-admin", h.sendAdminPDF)
}

func (h *Handler) healthCheck(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "error", "message": "Ruta no encontrada."})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("Servidor de WhatsApp API (Multi-sesión con WebSockets - Go/whatsmeow) está funcionando."))
}

// POST /api/sessions
func (h *Handler) createSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.SessionID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "El sessionId es requerido."})
		return
	}
	sessionID := strings.TrimSpace(body.SessionID)

	session, err := h.manager.CreateSession(sessionID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}

	if session.IsReady() {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "ok",
			"message":   "La sesión ya está activa.",
			"sessionId": sessionID,
		})
		return
	}

	if qr := session.CurrentQR(); qr != "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "qr",
			"qr":        qr,
			"message":   "Escanea el código QR para iniciar sesión.",
			"sessionId": sessionID,
		})
		return
	}

	if err := session.Connect(r.Context()); err != nil {
		log.Printf("[%s] Error al conectar: %v", sessionID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": err.Error()})
		return
	}

	waitCtx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	qr, err := session.WaitForQR(waitCtx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": err.Error()})
		return
	}

	if qr != "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "qr",
			"qr":        qr,
			"message":   "Escanea el código QR para iniciar sesión.",
			"sessionId": sessionID,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"message":   "La sesión se ha activado correctamente (sin necesidad de QR).",
		"sessionId": sessionID,
	})
}

// DELETE /api/sessions/{sessionId}
func (h *Handler) deleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("sessionId"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "El sessionId es requerido."})
		return
	}

	if err := h.manager.DeleteSession(r.Context(), sessionID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"message": "Sesión " + sessionID + " cerrada.",
	})
}

// GET /api/sessions/{sessionId}
func (h *Handler) getSessionStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("sessionId"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "El sessionId es requerido."})
		return
	}

	session, err := h.manager.GetSession(r.Context(), sessionID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}
	if session == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "nd"})
		return
	}

	isReady := session.IsReady()
	msg := "Cliente de WhatsApp no está listo."
	if isReady {
		msg = "Cliente de WhatsApp listo."
	}

	resp := map[string]any{
		"status":          "ok",
		"sessionId":       sessionID,
		"isReady":         isReady,
		"connectionState": session.State(),
		"message":         msg,
	}
	if phone := session.PhoneNumber(); isReady && phone != "" {
		resp["phoneNumber"] = phone
	}

	writeJSON(w, http.StatusOK, resp)
}

// GET /api/messages/{sessionId}/{messageId}/status
func (h *Handler) getMessageStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("sessionId"))
	messageID := strings.TrimSpace(r.PathValue("messageId"))
	if sessionID == "" || messageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "sessionId y messageId son requeridos."})
		return
	}

	session, err := h.manager.GetSession(r.Context(), sessionID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}
	if session == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "error", "message": "La sesión no existe."})
		return
	}

	msg, ok := session.GetOutgoingMessage(messageID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"status":  "error",
			"message": "No se encontró el mensaje en el registro de esta sesión.",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"message": msg,
	})
}

// POST /api/messages/send-text y /api/messages/send-contact
func (h *Handler) sendText(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		To        string `json:"to"`
		Message   string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "JSON inválido."})
		return
	}
	if strings.TrimSpace(body.SessionID) == "" || strings.TrimSpace(body.To) == "" || strings.TrimSpace(body.Message) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "sessionId, to y message son requeridos."})
		return
	}

	session, err := h.manager.GetSession(r.Context(), strings.TrimSpace(body.SessionID))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}
	if session == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "error", "message": "La sesión no existe."})
		return
	}

	readyCtx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := session.WaitForReady(readyCtx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error al enviar el mensaje.", "details": err.Error()})
		return
	}

	delivery, err := session.SendTextMessage(r.Context(), body.To, body.Message)
	if err != nil {
		log.Printf("[%s] Error enviando texto: %v", body.SessionID, err)
		if strings.Contains(err.Error(), "no existe en WhatsApp") {
			writeJSON(w, http.StatusNotFound, map[string]any{"status": "error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error al enviar el mensaje.", "details": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"message":   "Mensaje aceptado por WhatsApp.",
		"messageId": delivery.MessageID,
		"delivery":  delivery,
	})
}

// POST /api/messages/send-pdf
func (h *Handler) sendPDF(w http.ResponseWriter, r *http.Request) {
	pdfBytes, fileName, err := h.readPDFUpload(w, r)
	if err != nil {
		return
	}

	sessionID := strings.TrimSpace(r.FormValue("sessionId"))
	to := strings.TrimSpace(r.FormValue("to"))
	caption := r.FormValue("caption")
	if sessionID == "" || to == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "sessionId y to son requeridos."})
		return
	}

	session, err := h.manager.GetSession(r.Context(), sessionID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}
	if session == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "error", "message": "Inicie sesion en configuracion general."})
		return
	}

	readyCtx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := session.WaitForReady(readyCtx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error al enviar el PDF.", "details": err.Error()})
		return
	}

	delivery, err := session.SendPDFMessage(r.Context(), to, pdfBytes, fileName, caption)
	if err != nil {
		log.Printf("[%s] Error en /send-pdf: %v", sessionID, err)
		if strings.Contains(err.Error(), "no existe en WhatsApp") {
			writeJSON(w, http.StatusNotFound, map[string]any{"status": "error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error al enviar el PDF.", "details": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"message":   "PDF aceptado por WhatsApp.",
		"messageId": delivery.MessageID,
		"delivery":  delivery,
	})
}

// POST /api/messages/send-admin
func (h *Handler) sendAdminPDF(w http.ResponseWriter, r *http.Request) {
	pdfBytes, fileName, err := h.readPDFUpload(w, r)
	if err != nil {
		return
	}

	sessionID := strings.TrimSpace(r.FormValue("sessionId"))
	caption := r.FormValue("caption")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "El sessionId es requerido."})
		return
	}

	session, err := h.manager.GetSession(r.Context(), sessionID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": err.Error()})
		return
	}
	if session == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "Inicie sesion en configuracion general."})
		return
	}

	readyCtx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := session.WaitForReady(readyCtx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error al enviar el PDF.", "details": err.Error()})
		return
	}

	groupJID, err := session.GetGroupJIDByName(r.Context(), h.cfg.AdminGroupName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error consultando grupos.", "details": err.Error()})
		return
	}
	if groupJID.IsEmpty() {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"status":  "error",
			"message": `El grupo "` + h.cfg.AdminGroupName + `" no fue encontrado.`,
		})
		return
	}

	delivery, err := session.SendGroupPDFMessage(r.Context(), groupJID, pdfBytes, fileName, caption)
	if err != nil {
		log.Printf("[%s] Error en /send-admin: %v", sessionID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error al enviar el PDF.", "details": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"message":   "PDF aceptado por WhatsApp.",
		"messageId": delivery.MessageID,
		"delivery":  delivery,
	})
}

func (h *Handler) readPDFUpload(w http.ResponseWriter, r *http.Request) ([]byte, string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	if err := r.ParseMultipartForm(h.cfg.MaxUploadBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "Error procesando el formulario multipart."})
		return nil, "", err
	}

	file, header, err := r.FormFile("pdf")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "El archivo PDF es requerido."})
		return nil, "", err
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": "Error leyendo el archivo PDF."})
		return nil, "", err
	}

	contentType := header.Header.Get("Content-Type")
	detectedType := http.DetectContentType(data)
	isPDF := strings.Contains(strings.ToLower(contentType), "application/pdf") ||
		strings.Contains(strings.ToLower(detectedType), "application/pdf") ||
		strings.EqualFold(filepath.Ext(header.Filename), ".pdf")
	if !isPDF {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"status":  "error",
			"message": "Tipo de archivo incorrecto. Solo se aceptan archivos PDF en el campo 'pdf'.",
		})
		return nil, "", http.ErrNotSupported
	}

	fileName := filepath.Base(header.Filename)
	if fileName == "" || fileName == "." {
		fileName = "documento.pdf"
	}
	return data, fileName, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
