# wspApi (Migración a Go + whatsmeow)

Implementación equivalente del servicio multi-sesión de envío de mensajes de WhatsApp usando **Go**, **`whatsmeow`** y **SQLite embebido en archivo** (`modernc.org/sqlite`, sin CGO y sin base de datos externa).

## Ventajas respecto a la versión anterior (Node + Baileys)

- **Protocolo Signal y LIDs más estables:** `whatsmeow` maneja internamente el caché de mensajes salientes para responder `retry receipts` y reduce drásticamente el error *"Esperando el mensaje. Esto puede tomar tiempo"*.
- **Persistencia en archivo transaccional (SQLite):** cada sesión guarda sus llaves en `sessions_db/<sessionId>.db` con modo `WAL`, evitando la corrupción de archivos JSON de `useMultiFileAuthState`.
- **Binario único y bajo consumo:** no requiere instalar Go ni Node.js en el servidor de producción.
- **Compatibilidad 100% REST:** conserva las mismas rutas, parámetros y respuestas JSON que la versión en TypeScript.
- **WebSocket nativo (`/ws`):** reemplaza Socket.IO por WebSocket estándar (ver [FRONTEND_MIGRATION.md](./FRONTEND_MIGRATION.md)).

## Requisitos para compilar

- **Go 1.24 o superior** en la máquina donde compiles (no hace falta instalarlo en el servidor si compilas el binario para Linux).

## Instalación de dependencias y compilación

Desde la carpeta `migration/`:

```bash
# Resolver últimas versiones compatibles de whatsmeow, sqlite y websocket
go get go.mau.fi/whatsmeow@latest modernc.org/sqlite@latest github.com/gorilla/websocket@latest google.golang.org/protobuf@latest
go mod tidy

# Compilar para tu máquina actual
go build -o wsp-api ./cmd/server
```

### Compilar binario para servidor Linux (desde macOS/Windows)

Gracias a `modernc.org/sqlite` (100% Go puro), no necesitas `gcc` ni CGO:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o wsp-api-linux ./cmd/server
```

*(Si tu servidor Linux es ARM64, cambia `GOARCH=amd64` por `GOARCH=arm64`.)*

## Variables de entorno

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `PORT` | `7080` | Puerto de escucha |
| `USE_HTTPS` | `true` | `true` para HTTPS, `false` para HTTP (ej. desarrollo local) |
| `TLS_CERT_FILE` | `../cert/app_desystemsoft_com.crt` | Ruta al certificado TLS |
| `TLS_KEY_FILE` | `../cert/app.desystemsoft.com.key` | Ruta a la llave privada TLS |
| `SESSIONS_DIR` | `sessions_db` | Carpeta donde se guardan los archivos `.db` de cada sesión |
| `ALLOWED_ORIGINS` | *(los mismos de `src/index.ts`)* | Lista separada por comas de orígenes CORS permitidos |
| `SESSION_TIMEOUT_MINUTES` | `60` | Minutos de inactividad antes de cerrar la conexión WebSocket con WhatsApp |
| `ADMIN_GROUP_NAME` | `DataE-Admin` | Nombre del grupo usado en `POST /api/messages/send-admin` |
| `MAX_UPLOAD_MB` | `25` | Tamaño máximo permitido para PDFs |

## Ejecución con PM2 (opcional)

Puedes seguir usando PM2 ejecutando directamente el binario compilado:

```bash
pm2 start ./wsp-api-linux --name wsp-api
pm2 save
```

> **Nota importante de migración:** las sesiones antiguas de Baileys (`auth_info_baileys/`) no son compatibles con el formato SQLite de `whatsmeow`. Al activar este servicio, cada cliente deberá escanear el código QR una única vez para generar su archivo en `sessions_db/`.
