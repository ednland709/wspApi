import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    proto,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

class WhatsAppClient {
    public sock: WASocket | null = null;
    private connectionState: 'connecting' | 'open' | 'close' = 'close';
    private reconnectAttempts = 0;

    constructor() {}

    /**
     * Inicia la conexión con WhatsApp.
     * Debe ser llamado desde el archivo principal de tu aplicación.
     */
    public async connect() {
        if (this.sock || this.connectionState === 'open' || this.connectionState === 'connecting') {
            console.log('El cliente ya está conectado o conectándose.');
            return;
        }

        this.connectionState = 'connecting';
        const authDir = path.join(__dirname, '../../auth_info_baileys');
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        // fetchLatestBaileysVersion asegura que estás usando la última versión de la API de WhatsApp Web
        const { version, isLatest } = await fetchLatestBaileysVersion();
		console.log(`Usando la versión de WA v${version.join('.')}, ¿es la última?: ${isLatest}`);

        console.log('Iniciando WhatsApp Client...');
        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            // Configura un logger para no llenar la consola de ruido
            logger: pino({ level: 'silent' })
        });

        // Guardar credenciales cada vez que se actualizan
        this.sock.ev.on('creds.update', saveCreds);

        // Manejar actualizaciones de la conexión
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('------------------------------------------------------');
                console.log('¡Nuevo código QR! Por favor, escanéalo con tu teléfono:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                this.connectionState = 'close';
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect && this.reconnectAttempts < 5) {
                    this.reconnectAttempts++;
                    const delay = Math.pow(2, this.reconnectAttempts) * 1000;
                    console.log(`Conexión cerrada. Reintentando en ${delay / 1000} segundos... (Intento ${this.reconnectAttempts})`);
                    setTimeout(() => this.connect(), delay);
                } else {
                    console.error('Conexión cerrada permanentemente.', lastDisconnect?.error);
                    // Aquí podrías añadir lógica para notificar a un administrador.
                }
            } else if (connection === 'open') {
                // Reseteamos los intentos al conectar exitosamente
                this.reconnectAttempts = 0;
                this.connectionState = 'open';
                console.log('¡Conexión abierta y cliente listo!');
            }
        });
    }

    public isReady(): boolean {
        return this.connectionState === 'open';
    }

    private formatJid(to: string): string {
        if (to.endsWith('@s.whatsapp.net')) {
            return to;
        }
        const number = to.replace(/\D/g, '');
        return `${number}@s.whatsapp.net`;
    }

    private async prepareMessage(to: string): Promise<string> {
        if (!this.isReady() || !this.sock) throw new Error('El cliente de WhatsApp no está listo.');
        
        const jid = this.formatJid(to);
        const [result] = (await this.sock.onWhatsApp(jid)) || [];
        if (!result?.exists) throw new Error(`El número ${to} no existe en WhatsApp.`);
        return jid;
    }

    public async sendTextMessage(to: string, message: string): Promise<proto.WebMessageInfo | undefined> {
	if (!to) {
		to = "573169918917";
	}
        const jid = await this.prepareMessage(to);
        return this.sock!.sendMessage(jid, { text: message });
    }

    public async sendPdfMessage(to: string, pdfPath: string, caption: string): Promise<proto.WebMessageInfo | undefined> {
        const jid = await this.prepareMessage(to);
        return this.sock!.sendMessage(jid, {
            document: { url: pdfPath },
            mimetype: 'application/pdf',
            fileName: path.basename(pdfPath),
            caption: caption
        });
    }
}

export const whatsappClient = new WhatsAppClient();
