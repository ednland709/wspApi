package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"wspapi-go/internal/api"
	"wspapi-go/internal/config"
	"wspapi-go/internal/hub"
	"wspapi-go/internal/whatsapp"
)

func main() {
	cfg := config.Load()

	wsHub := hub.New(cfg.IsOriginAllowed)

	manager, err := whatsapp.NewManager(
		cfg.SessionsDir,
		cfg.SessionTimeout,
		cfg.MessageStatusTTL,
		wsHub,
	)
	if err != nil {
		log.Fatalf("Error inicializando gestor de sesiones: %v", err)
	}

	mux := http.NewServeMux()
	handler := api.NewHandler(manager, cfg)
	handler.RegisterRoutes(mux)
	mux.HandleFunc("GET /ws", wsHub.ServeWS)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           corsMiddleware(cfg, mux),
		ReadHeaderTimeout: 15 * time.Second,
	}

	go func() {
		if cfg.UseHTTPS {
			log.Printf("Servidor HTTPS (Go/whatsmeow) escuchando en el puerto %s", cfg.Port)
			if err := server.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile); err != nil && err != http.ErrServerClosed {
				log.Fatalf("Error en servidor HTTPS: %v", err)
			}
		} else {
			log.Printf("Servidor HTTP (Go/whatsmeow) escuchando en el puerto %s", cfg.Port)
			if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("Error en servidor HTTP: %v", err)
			}
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("Deteniendo servidor...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	manager.CloseAll()
	log.Println("Servidor detenido correctamente.")
}

func corsMiddleware(cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !cfg.IsOriginAllowed(origin) {
				http.Error(w, "Not allowed by CORS", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
