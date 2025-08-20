
import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket, proto } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import * as path from 'path';

class WhatsAppClient {
    private socket: WASocket | undefined;
    private isInitialized = false;

    async initialize() {
        if (this.isInitialized) {
            return;
        }

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        this.socket = makeWASocket({
            auth: state,
            printQRInTerminal: true,
        });

        this.socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('Escanea este código QR con tu teléfono:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Conexión cerrada debido a', lastDisconnect?.error, ', reconectando:', shouldReconnect);
                if (shouldReconnect) {
                    this.initialize();
                }
            } else if (connection === 'open') {
                console.log('¡Conexión con WhatsApp abierta!');
            }
        });

        this.socket.ev.on('creds.update', saveCreds);
        this.isInitialized = true;
    }

    public isReady(): boolean {
        return this.socket?.user !== undefined;
    }

    private formatPhoneNumber(number: string): string {
        if (number.endsWith('@s.whatsapp.net')) {
            return number;
        }
        return `${number}@s.whatsapp.net`;
    }

    async sendTextMessage(to: string, message: string) {
        if (!this.isReady() || !this.socket) {
            throw new Error('WhatsApp client no está listo.');
        }
        const jid = this.formatPhoneNumber(to);
        await this.socket.sendMessage(jid, { text: message });
    }

    async sendPdfMessage(to: string, pdfPath: string, caption: string = '') {
        if (!this.isReady() || !this.socket) {
            throw new Error('WhatsApp client no está listo.');
        }
        const jid = this.formatPhoneNumber(to);
        const messageContent = {
            document: { url: pdfPath },
            mimetype: 'application/pdf',
            fileName: path.basename(pdfPath),
            caption: caption,
        };

        await this.socket.sendMessage(jid, messageContent);
    }
}

// Exportamos una única instancia (Singleton)
export const whatsappClient = new WhatsAppClient();
