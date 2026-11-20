package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port              string
	UseHTTPS          bool
	CertFile          string
	KeyFile           string
	SessionsDir       string
	AllowedOrigins    []string
	SessionTimeout    time.Duration
	MessageStatusTTL  time.Duration
	AdminGroupName    string
	MaxUploadBytes    int64
}

func Load() Config {
	port := getEnv("PORT", "7080")
	useHTTPS := strings.ToLower(getEnv("USE_HTTPS", "true")) != "false"

	certFile := getEnv("TLS_CERT_FILE", filepath.Join("..", "cert", "app_desystemsoft_com.crt"))
	keyFile := getEnv("TLS_KEY_FILE", filepath.Join("..", "cert", "app.desystemsoft.com.key"))
	sessionsDir := getEnv("SESSIONS_DIR", "sessions_db")
	adminGroupName := getEnv("ADMIN_GROUP_NAME", "DataE-Admin")

	timeoutMinutes := getEnvInt("SESSION_TIMEOUT_MINUTES", 60)
	maxUploadMB := getEnvInt("MAX_UPLOAD_MB", 25)

	defaultOrigins := []string{
		"https://www.desystemsoft.com",
		"http://localhost:4200",
		"https://app2.desystemsoft.com",
		"https://app2.desystemsoft.com:907",
		"https://dian.desystemsoft.com",
	}

	origins := defaultOrigins
	if raw := strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS")); raw != "" {
		parts := strings.Split(raw, ",")
		origins = make([]string, 0, len(parts))
		for _, p := range parts {
			if trimmed := strings.TrimSpace(p); trimmed != "" {
				origins = append(origins, trimmed)
			}
		}
	}

	return Config{
		Port:             port,
		UseHTTPS:         useHTTPS,
		CertFile:         certFile,
		KeyFile:          keyFile,
		SessionsDir:      sessionsDir,
		AllowedOrigins:   origins,
		SessionTimeout:   time.Duration(timeoutMinutes) * time.Minute,
		MessageStatusTTL: 24 * time.Hour,
		AdminGroupName:   adminGroupName,
		MaxUploadBytes:   int64(maxUploadMB) << 20,
	}
}

func (c Config) IsOriginAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	for _, allowed := range c.AllowedOrigins {
		if allowed == origin {
			return true
		}
	}
	return false
}

func getEnv(key, fallback string) string {
	if val := strings.TrimSpace(os.Getenv(key)); val != "" {
		return val
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	val, err := strconv.Atoi(raw)
	if err != nil || val <= 0 {
		return fallback
	}
	return val
}
