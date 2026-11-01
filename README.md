
# API de WhatsApp con Node.js, Express y Baileys

Este proyecto proporciona una API RESTful para enviar mensajes de texto y documentos PDF a través de WhatsApp, utilizando la librería `@whiskeysockets/baileys`.

## Características

- Envío de mensajes de texto plano.
- Envío de documentos PDF con un pie de foto (caption).
- Autenticación persistente (no es necesario escanear el QR en cada reinicio).
- Gestión de procesos con PM2 para producción.
- Endpoints para verificar el estado de la conexión con WhatsApp.

---

## 1. Instalación

1.  **Clona el repositorio (o descarga los archivos):**
    ```bash
    # git clone <tu-repositorio>
    # cd <nombre-del-directorio>
    ```

2.  **Instala las dependencias:**
    Asegúrate de tener Node.js (v20 o superior) instalado.
    ```bash
    npm install
    ```

---

## 2. Proceso de Inicio de Sesión (¡MUY IMPORTANTE!)

Para que el servicio pueda enviar mensajes, debe estar vinculado a una cuenta de WhatsApp. Este proceso solo se realiza una vez.

1.  **Ejecuta la aplicación en modo de desarrollo por primera vez:**
    ```bash
    npm run dev
    ```

2.  **Escanea el Código QR:**
    Al iniciar, la aplicación detectará que no hay una sesión guardada y mostrará un **código QR** en tu terminal.

    ![Ejemplo de QR en terminal](https://i.imgur.com/sB66S6G.png)

3.  **Abre WhatsApp en tu teléfono móvil:**
    *   Ve a **Configuración** > **Dispositivos vinculados**.
    *   Toca el botón **"Vincular un dispositivo"**.
    *   Escanea el código QR que apareció en tu terminal.

4.  **¡Listo!**
    Una vez que escanees el código, la aplicación se conectará y creará una carpeta llamada `auth_info_baileys` en la raíz del proyecto. Esta carpeta contiene tu sesión de autenticación. **Mientras no borres esta carpeta, no necesitarás volver a escanear el QR.**

    Puedes detener la aplicación (Ctrl+C) y volver a iniciarla. Verás que se conecta directamente sin pedir el QR.

---

## 3. Uso

### Modo de Desarrollo

Para ejecutar la aplicación con recarga automática al guardar cambios:

```bash
npm run dev
```

La API estará disponible en `http://localhost:3000`.

### Modo de Producción con PM2

Para un entorno de producción, es recomendable usar PM2 para mantener la aplicación siempre en ejecución.

1.  **Compila el código de TypeScript a JavaScript:**
    ```bash
    npm run build
    ```
    Esto creará una carpeta `dist/` con los archivos JavaScript.

2.  **Inicia la aplicación con PM2:**
    ```bash
    pm2 start ecosystem.config.js
    ```

**Comandos útiles de PM2:**
*   `pm2 list`: Lista todas las aplicaciones en ejecución.
*   `pm2 stop wsp-api`: Detiene la aplicación.
*   `pm2 restart wsp-api`: Reinicia la aplicación.
*   `pm2 logs wsp-api`: Muestra los logs (registros) de la aplicación.

---

## 4. API Endpoints

### Estado de entrega de mensajes

Los endpoints de envío responden cuando Baileys acepta el mensaje, no cuando el destinatario ya lo recibió o descifró. La respuesta incluye `messageId` y un estado inicial `sent`. Consulta el estado con:

```http
GET /api/messages/{sessionId}/{messageId}/status
```

Los cambios también se emiten por Socket.IO en el evento `message-status` dentro de la sala de la sesión. Los estados posibles son `pending`, `sent`, `delivered`, `read`, `played` y `failed`. Para grupos, `delivered`/`read` indica que se recibió un acuse de al menos un participante.

El registro de estados vive en memoria y se conserva hasta 24 horas mientras la sesión permanezca registrada en el proceso. Se pierde al reiniciar, al eliminar/desconectar permanentemente la sesión o al vencer ese plazo; tampoco se comparte entre instancias. Para despliegues con varias instancias se necesita persistirlo en una base de datos compartida y mantener una sola instancia propietaria de cada sesión.

### GET /api/sessions/{sessionId}

Verifica si el cliente de WhatsApp está conectado y listo para enviar mensajes.

**Respuesta de ejemplo:**
```json
{
    "status": "ok",
    "sessionId": "empresa-123",
    "isReady": true,
    "message": "Cliente de WhatsApp listo."
}
```

### POST /api/send-text

Envía un mensaje de texto plano.

**Headers:**
*   `Content-Type: application/json`

**Body (JSON):**
```json
{
    "sessionId": "empresa-123",
    "to": "521XXXXXXXXXX",
    "message": "Hola, esto es una prueba desde la API."
}
```
La ruta real está bajo el prefijo `/api/messages`:

```text
POST /api/messages/send-text
```
La respuesta incluye el ID de WhatsApp y el estado actual del envío. Usa el endpoint de estado anterior para seguir las confirmaciones; un estado `sent` no confirma la entrega al destinatario.

*   `sessionId`: Identificador de la sesión de WhatsApp ya conectada.
*   `to`: Número de teléfono en formato internacional, incluyendo el código de país y el `1` después del código si es un móvil de México. No incluyas `+` o `00`.

**Respuesta de ejemplo:**
```json
{
    "status": "ok",
    "message": "Mensaje aceptado por WhatsApp.",
    "messageId": "3EB0...",
    "delivery": {
        "messageId": "3EB0...",
        "chatId": "521...@s.whatsapp.net",
        "status": "sent",
        "sentAt": "2026-10-23T17:00:00.000Z",
        "updatedAt": "2026-10-23T17:00:00.100Z"
    }
}
```

**Ejemplo con `curl`:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"sessionId":"empresa-123","to":"521...","message":"Hola mundo"}' https://localhost:7080/api/messages/send-text
```

### POST /api/send-pdf

Envía un archivo PDF con un pie de foto opcional.

**Headers:**
*   `Content-Type: multipart/form-data`

**Body (form-data):**
*   `sessionId` (texto): El identificador de la sesión conectada.
*   `to` (texto): El número de teléfono del destinatario.
*   `pdf` (archivo): El archivo PDF que deseas enviar.
*   `caption` (texto, opcional): Un texto que se enviará junto al PDF.

**Ejemplo con `curl`:**
```bash
curl -X POST -F "sessionId=empresa-123" -F "to=521..." -F "caption=Factura de este mes" -F "pdf=@/ruta/a/tu/archivo.pdf" https://localhost:7080/api/messages/send-pdf
```

### Operación de sesiones y actualización

- Mantén una sola instancia de la aplicación escribiendo cada carpeta de `auth_info_baileys/{sessionId}`. La configuración PM2 incluida usa una instancia; no habilites modo clúster ni réplicas que compartan esas carpetas.
- Conserva y respalda de forma segura `auth_info_baileys`. No borres credenciales para resolver un mensaje pendiente salvo que se haya confirmado que la sesión está dañada y se pueda volver a vincular la cuenta.
- La aplicación usa Baileys 6.7.24. Prueba futuras actualizaciones primero en staging; Baileys 7 incluye cambios incompatibles y no se actualiza automáticamente a esa versión.
- El aviso “Esperando el mensaje” está relacionado con el descifrado/sincronización entre dispositivos del destinatario. Los estados de entrega ayudan a detectar el problema, pero no permiten reparar las claves del teléfono del destinatario.
