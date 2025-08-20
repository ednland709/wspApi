
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
    Asegúrate de tener Node.js (v16 o superior) instalado.
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

### GET /api/status

Verifica si el cliente de WhatsApp está conectado y listo para enviar mensajes.

**Respuesta de ejemplo:**
```json
{
    "status": "ok",
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
    "to": "521XXXXXXXXXX",
    "message": "Hola, esto es una prueba desde la API."
}
```
*   `to`: Número de teléfono en formato internacional, incluyendo el código de país y el `1` después del código si es un móvil de México. No incluyas `+` o `00`.

**Ejemplo con `curl`:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"to": "521...", "message": "Hola mundo"}' http://localhost:3000/api/send-text
```

### POST /api/send-pdf

Envía un archivo PDF con un pie de foto opcional.

**Headers:**
*   `Content-Type: multipart/form-data`

**Body (form-data):**
*   `to` (texto): El número de teléfono del destinatario.
*   `pdf` (archivo): El archivo PDF que deseas enviar.
*   `caption` (texto, opcional): Un texto que se enviará junto al PDF.

**Ejemplo con `curl`:**
```bash
curl -X POST -F "to=521..." -F "caption=Factura de este mes" -F "pdf=@/ruta/a/tu/archivo.pdf" http://localhost:3000/api/send-pdf
```
