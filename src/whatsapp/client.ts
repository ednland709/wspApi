import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    proto,
    fetchLatestBaileysVersion,
    AnyMessageContent,
    generateMessageIDV2
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as fs from 'fs-extra';
import pino from 'pino';
import { EventEmitter } from 'events';

import { io } from '../index'; // Importar la instancia de socket.io

const SESSIONS_DIR = path.join(__dirname, '../../auth_info_baileys');
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
const MESSAGE_STATUS_TTL_MS = 24 * 60 * 60 * 1000;

export type OutgoingMessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed';

export interface OutgoingMessage {
    messageId: string;
    chatId: string;
    status: OutgoingMessageStatus;
    sentAt: string;
    updatedAt: string;
}

// Asegurarse de que el directorio de sesiones exista
fs.ensureDirSync(SESSIONS_DIR);

export class WhatsAppClient extends EventEmitter {
    public sock: WASocket | null = null;
    public connectionState: 'connecting' | 'open' | 'close' = 'close';
    public qr: string | null = null;
    private sessionTimeout: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0; // Añadir esta línea
    private readonly sessionPath: string;
    private isIntentionalDisconnect = false;
    private outgoingMessages = new Map<string, OutgoingMessage>();

    constructor(public readonly sessionId: string) {
        super();
        this.sessionPath = path.join(SESSIONS_DIR, sessionId);
        this.resetTimeout();
    }

    public async connect() {
        if (this.sock || this.connectionState === 'open' || this.connectionState === 'connecting') {
            console.log(`[${this.sessionId}] El cliente ya está conectado o conectándose.`);
            return;
        }

        this.isIntentionalDisconnect = false;
        this.connectionState = 'connecting';
        await fs.ensureDir(this.sessionPath);
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[${this.sessionId}] Usando la versión de WA v${version.join('.')}, ¿es la última?: ${isLatest}`);

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'info' }) // Cambiado a 'info' para depuración
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.update', (updates) => {
            for (const { key, update } of updates) {
                if (!key.fromMe || !key.id || update.status == null) continue;
                this.updateOutgoingMessageStatus(key.id, update.status);
            }
        });
        this.sock.ev.on('message-receipt.update', (updates) => {
            for (const { key, receipt } of updates) {
                if (!key.fromMe || !key.id) continue;
                if (receipt.readTimestamp) {
                    this.updateOutgoingMessageStatus(key.id, proto.WebMessageInfo.Status.READ);
                } else if (receipt.receiptTimestamp) {
                    this.updateOutgoingMessageStatus(key.id, proto.WebMessageInfo.Status.DELIVERY_ACK);
                }
            }
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qr = qr;
                this.emit('qr', qr); // Emitir evento con el QR
            }

            if (connection === 'close') {
                this.connectionState = 'close';
                this.sock = null; // Asegurarse de que el socket se nulifique al cerrar la conexión
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const errorMessage = (lastDisconnect?.error as Boom)?.message || '';
                const invalidSession = statusCode === DisconnectReason.loggedOut ||
                    errorMessage.includes('Bad MAC') ||
                    errorMessage.toLowerCase().includes('session');

                if (invalidSession) {
                    console.log(`[${this.sessionId}] Sesión inválida o cerrada permanentemente (${errorMessage || statusCode}).`);
                    this.emit('session-invalid');
                    this.emit('disconnected');
                } else if (!this.isIntentionalDisconnect) {
                    console.log(`[${this.sessionId}] Conexión cerrada, intentando reconectar...`);
                    if (this.reconnectAttempts < 5) { // Limitar intentos de reconexión
                        this.reconnectAttempts++;
                        const delay = Math.pow(2, this.reconnectAttempts) * 1000; // Backoff exponencial
                        console.log(`[${this.sessionId}] Reintentando en ${delay / 1000} segundos... (Intento ${this.reconnectAttempts})`);
                        setTimeout(() => this.connect(), delay);
                    } else {
                        console.error(`[${this.sessionId}] Máximo de intentos de reconexión alcanzado. Sesión cerrada.`);
                        this.emit('disconnected'); // Emitir desconexión permanente
                    }
                }
            } else if (connection === 'open') {
                this.reconnectAttempts = 0; // Resetear intentos al conectar exitosamente
                this.connectionState = 'open';
                this.qr = null;
                console.log(`[${this.sessionId}] Conexión abierta y cliente listo!`);
                this.emit('ready');
                io.to(this.sessionId).emit('session-ready', { sessionId: this.sessionId }); // Emitir evento WebSocket
            }
        });
        this.resetTimeout();
    }

    public isReady(): boolean {
        this.resetTimeout();
        return this.connectionState === 'open';
    }

    public async disconnect() {
        console.log(`[${this.sessionId}] Desconectando cliente (desconexión suave)...`);
        this.isIntentionalDisconnect = true;
        if (this.sessionTimeout) clearTimeout(this.sessionTimeout);
        if (this.sock) {
            await this.sock.ws.close();
            this.sock = null;
        }
        this.connectionState = 'close';
    }

    private resetTimeout() {
        if (this.sessionTimeout) clearTimeout(this.sessionTimeout);
        this.sessionTimeout = setTimeout(() => {
            console.log(`[${this.sessionId}] Sesión inactiva, desconectando...`);
            this.emit('timeout');
        }, SESSION_TIMEOUT_MS);
    }

    private formatJid(to: string): string {
        if (to.endsWith('@s.whatsapp.net')) return to;
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
        const jid = await this.prepareMessage(to);
        return this.sendTrackedMessage(jid, { text: message });
    }

    public async sendPdfMessage(to: string, pdfPath: string, caption: string): Promise<proto.WebMessageInfo | undefined> {
        const jid = await this.prepareMessage(to);
        return this.sendTrackedMessage(jid, {
            document: { url: pdfPath },
            mimetype: 'application/pdf',
            fileName: path.basename(pdfPath),
            caption: caption
        });
    }

    public async sendGroupTextMessage(groupId: string, message: string): Promise<proto.WebMessageInfo | undefined> {
        if (!this.isReady() || !this.sock) throw new Error('El cliente de WhatsApp no está listo.');
        // Simple check for group id format
        if (!groupId.endsWith('@g.us')) throw new Error('Invalid group ID.');
        return this.sendTrackedMessage(groupId, { text: message });
    }

    public async getAllGroups() {
        if (!this.isReady() || !this.sock) throw new Error('El cliente de WhatsApp no está listo.');
        const groups = await this.sock.groupFetchAllParticipating();
        return groups;
    }

    public async getGroupJidByName(name: string): Promise<string | undefined> {
        const groups = await this.getAllGroups();
        const group = Object.values(groups).find(group => group.subject === name);
        return group?.id;
    }

    public async sendGroupPdfMessage(groupId: string, pdfPath: string, caption: string): Promise<proto.WebMessageInfo | undefined> {
        if (!this.isReady() || !this.sock) throw new Error('El cliente de WhatsApp no está listo.');
        if (!groupId.endsWith('@g.us')) throw new Error('Invalid group ID.');
        return this.sendTrackedMessage(groupId, {
            document: { url: pdfPath },
            mimetype: 'application/pdf',
            fileName: path.basename(pdfPath),
            caption: caption
        });
    }

    public getOutgoingMessage(messageId: string): OutgoingMessage | undefined {
        this.pruneOutgoingMessages();
        return this.outgoingMessages.get(messageId);
    }

    private async sendTrackedMessage(jid: string, content: AnyMessageContent): Promise<proto.WebMessageInfo | undefined> {
        const sock = this.sock;
        if (!this.isReady() || !sock) throw new Error('El cliente de WhatsApp no está listo.');
        const messageId = generateMessageIDV2(sock.user?.id);
        const now = new Date().toISOString();
        const record: OutgoingMessage = {
            messageId,
            chatId: jid,
            status: 'pending',
            sentAt: now,
            updatedAt: now
        };
        this.outgoingMessages.set(messageId, record);
        this.pruneOutgoingMessages();
        io.to(this.sessionId).emit('message-status', record);

        try {
            const sentMessage = await sock.sendMessage(jid, content, { messageId });
            if (!sentMessage?.key.id || sentMessage.key.id !== messageId) {
                throw new Error('WhatsApp no devolvió el ID esperado para el mensaje enviado.');
            }
            this.updateOutgoingMessageStatus(messageId, proto.WebMessageInfo.Status.SERVER_ACK);
            return sentMessage;
        } catch (error) {
            this.updateOutgoingMessageStatus(messageId, proto.WebMessageInfo.Status.ERROR);
            throw error;
        }
    }

    private updateOutgoingMessageStatus(messageId: string, status: number): void {
        const message = this.outgoingMessages.get(messageId);
        if (!message) return;

        const statusByBaileys: Partial<Record<number, OutgoingMessageStatus>> = {
            [proto.WebMessageInfo.Status.ERROR]: 'failed',
            [proto.WebMessageInfo.Status.SERVER_ACK]: 'sent',
            [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'delivered',
            [proto.WebMessageInfo.Status.READ]: 'read',
            [proto.WebMessageInfo.Status.PLAYED]: 'played'
        };
        const nextStatus = statusByBaileys[status];
        if (!nextStatus) return;
        if (nextStatus === 'failed') {
            if (message.status !== 'pending') return;
        } else if (message.status === 'failed' || this.statusRank(nextStatus) <= this.statusRank(message.status)) {
            return;
        }

        const updatedMessage = { ...message, status: nextStatus, updatedAt: new Date().toISOString() };
        this.outgoingMessages.set(messageId, updatedMessage);
        io.to(this.sessionId).emit('message-status', updatedMessage);
    }

    private statusRank(status: OutgoingMessageStatus): number {
        return {
            pending: 0,
            sent: 1,
            delivered: 2,
            read: 3,
            played: 4,
            failed: -1
        }[status];
    }

    private pruneOutgoingMessages(): void {
        const expiryTime = Date.now() - MESSAGE_STATUS_TTL_MS;
        for (const [messageId, message] of this.outgoingMessages) {
            if (Date.parse(message.sentAt) < expiryTime) {
                this.outgoingMessages.delete(messageId);
            }
        }
    }
}

class WhatsAppClientManager {
    private sessions = new Map<string, WhatsAppClient>();

    createSession(sessionId: string): WhatsAppClient {
        if (this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId)!;
        }

        console.log(`[Manager] Creando nueva sesión para ${sessionId}`);
        const client = new WhatsAppClient(sessionId);

        client.on('timeout', () => {
            console.log(`[Manager] Sesión ${sessionId} inactiva, desconectando.`);
            client.disconnect();
        });

        client.on('disconnected', () => {
            console.log(`[Manager] Sesión ${sessionId} desconectada, eliminando...`);
            this.deleteSession(sessionId);
        });

        this.sessions.set(sessionId, client);
        return client;
    }

    async getSession(sessionId: string): Promise<WhatsAppClient | undefined> {
        let session = this.sessions.get(sessionId);
        if (session?.isReady()) {
            return session;
        }

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const sessionExistsOnDisk = await fs.pathExists(sessionPath);

        if (sessionExistsOnDisk) {
            if (!session) {
                session = this.createSession(sessionId);
            }
            
            console.log(`[Manager] Intentando restaurar sesión ${sessionId} desde el disco...`);
            try {
                await session.connect();
                return session;
            } catch (error: any) {
                console.error(`[${sessionId}] Error al restaurar sesión desde disco:`, error.message);
                return undefined;
            }
        }
        return session;
    }

    async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            console.log(`[Manager] Eliminando sesión para ${sessionId}`);
            await session.disconnect(); // Disconnect before deleting files
            this.sessions.delete(sessionId);
        }

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (await fs.pathExists(sessionPath)) {
            console.log(`[Manager] Eliminando archivos de sesión para ${sessionId}`);
            await fs.remove(sessionPath);
        }
    }
}

export const whatsappClientManager = new WhatsAppClientManager();
