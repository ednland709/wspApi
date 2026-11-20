# Guía de Migración del Frontend (Socket.IO → WebSocket Nativo)

La migración del backend a **Go + `whatsmeow`** mantiene **100% intactos todos los endpoints REST** (`/api/sessions`, `/api/messages/*`).

El **único cambio necesario en el frontend** es reemplazar el cliente de `socket.io-client` por el **WebSocket nativo del navegador** (`WebSocket`), que no requiere librerías externas.

---

## 1. Qué cambia y qué NO cambia

### No cambia (0 modificaciones en el frontend)
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `DELETE /api/sessions/:sessionId`
- `POST /api/messages/send-text`
- `POST /api/messages/send-pdf`
- `POST /api/messages/send-contact`
- `POST /api/messages/send-admin`
- `GET /api/messages/:sessionId/:messageId/status`

### Sí cambia (solo tiempo real)

| Concepto | Antes (Socket.IO v4) | Ahora (WebSocket nativo) |
| :--- | :--- | :--- |
| **Librería** | `socket.io-client` | `WebSocket` nativo del navegador |
| **URL** | `https://tu-dominio:7080` (ruta interna `/socket.io/`) | `wss://tu-dominio:7080/ws` *(o `ws://` en local sin HTTPS)* |
| **Unirse a sesión** | `socket.emit('join-session', sessionId)` | Al conectar: `wss://tu-dominio:7080/ws?sessionId=<id>` **y/o** enviar `JSON.stringify({ event: 'join-session', sessionId })` |
| **Evento sesión lista** | `socket.on('session-ready', (data) => ...)` | Mensaje JSON: `{ "event": "session-ready", "data": { "sessionId": "..." } }` |
| **Evento estado mensaje** | `socket.on('message-status', (data) => ...)` | Mensaje JSON: `{ "event": "message-status", "data": { "messageId": "...", "chatId": "...", "status": "...", "sentAt": "...", "updatedAt": "..." } }` |

---

## 2. Contrato de mensajes WebSocket

### Cliente → Servidor (opcional si ya pasaste `?sessionId=` en la URL)
```json
{
  "event": "join-session",
  "sessionId": "mi-empresa-01"
}
```

### Servidor → Cliente

**1. Sesión vinculada / lista (`session-ready`):**
```json
{
  "event": "session-ready",
  "data": {
    "sessionId": "mi-empresa-01"
  }
}
```

**2. Actualización de estado de mensaje (`message-status`):**
```json
{
  "event": "message-status",
  "data": {
    "messageId": "3EB0...",
    "chatId": "573001234567@s.whatsapp.net",
    "status": "delivered",
    "sentAt": "2026-11-19T20:00:00.000Z",
    "updatedAt": "2026-11-19T20:00:02.150Z"
  }
}
```
Valores posibles de `status`: `'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed'`.

---

## 3. Ejemplo de implementación en Angular / TypeScript

Puedes reemplazar tu servicio actual de Socket.IO por este servicio equivalente (con reconexión automática):

```typescript
import { Injectable, OnDestroy } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface OutgoingMessageStatus {
  messageId: string;
  chatId: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed';
  sentAt: string;
  updatedAt: string;
}

interface WsIncomingPayload {
  event: 'session-ready' | 'message-status';
  data: any;
}

@Injectable({
  providedIn: 'root',
})
export class WhatsappSocketService implements OnDestroy {
  private ws: WebSocket | null = null;
  private currentSessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  private readonly sessionReady$ = new Subject<{ sessionId: string }>();
  private readonly messageStatus$ = new Subject<OutgoingMessageStatus>();

  /**
   * Conecta al WebSocket y se une automáticamente a la sala de la sesión.
   * Ejemplo de baseUrl: 'wss://app.desystemsoft.com:7080'
   */
  connect(baseUrl: string, sessionId: string): void {
    this.disconnect();
    this.currentSessionId = sessionId;
    this.shouldReconnect = true;

    const wsUrl = this.buildWsUrl(baseUrl, sessionId);
    this.openSocket(wsUrl);
  }

  /**
   * Permite suscribirse a una sesión adicional sobre la conexión abierta.
   */
  joinSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'join-session', sessionId }));
    }
  }

  onSessionReady(): Observable<{ sessionId: string }> {
    return this.sessionReady$.asObservable();
  }

  onMessageStatus(): Observable<OutgoingMessageStatus> {
    return this.messageStatus$.asObservable();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  ngOnDestroy(): void {
    this.disconnect();
    this.sessionReady$.complete();
    this.messageStatus$.complete();
  }

  private openSocket(wsUrl: string): void {
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.onopen = () => {
      if (this.currentSessionId) {
        socket.send(
          JSON.stringify({
            event: 'join-session',
            sessionId: this.currentSessionId,
          })
        );
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      try {
        const parsed: WsIncomingPayload = JSON.parse(event.data);
        if (parsed.event === 'session-ready') {
          this.sessionReady$.next(parsed.data);
        } else if (parsed.event === 'message-status') {
          this.messageStatus$.next(parsed.data);
        }
      } catch (err) {
        console.error('[WS] Mensaje no válido:', err);
      }
    };

    socket.onclose = () => {
      this.ws = null;
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.openSocket(wsUrl), 3000);
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private buildWsUrl(baseUrl: string, sessionId: string): string {
    const normalized = baseUrl
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://')
      .replace(/\/+$/, '');
    return `${normalized}/ws?sessionId=${encodeURIComponent(sessionId)}`;
  }
}
```

### Ejemplo de uso en un componente Angular (antes vs. después)

**Antes (Socket.IO):**
```typescript
this.socket = io('https://app.desystemsoft.com:7080');
this.socket.emit('join-session', this.sessionId);
this.socket.on('session-ready', (data) => {
  this.qrCode = null;
  this.isConnected = true;
});
this.socket.on('message-status', (status) => {
  console.log('Estado del mensaje:', status);
});
```

**Después (WebSocket nativo):**
```typescript
this.wsService.connect('https://app.desystemsoft.com:7080', this.sessionId);

this.wsService.onSessionReady().subscribe((data) => {
  this.qrCode = null;
  this.isConnected = true;
});

this.wsService.onMessageStatus().subscribe((status) => {
  console.log('Estado del mensaje:', status);
});
```

---

## 4. Checklist rápido de migración en Frontend

1. Buscar en el proyecto del frontend referencias a `socket.io-client`, `join-session`, `session-ready` y `message-status`.
2. Reemplazar la conexión de `io(...)` por el servicio de WebSocket nativo apuntando a `wss://<host>:7080/ws?sessionId=<sessionId>`.
3. Si ya no usas Socket.IO para ningún otro módulo, puedes desinstalar `socket.io-client` (`npm uninstall socket.io-client`) para reducir el bundle del frontend.
4. Verificar que el origen del frontend esté incluido en `ALLOWED_ORIGINS` del backend (por defecto ya están `www.desystemsoft.com`, `app2.desystemsoft.com`, `app2.desystemsoft.com:907`, `dian.desystemsoft.com` y `http://localhost:4200`).
5. Al pasar a producción, recuerda que los clientes deberán **escanear el QR una vez** para crear su nueva sesión en SQLite (`sessions_db/`).
