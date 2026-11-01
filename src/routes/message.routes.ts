import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { whatsappClientManager, WhatsAppClient } from '../whatsapp/client';
import { body, param } from 'express-validator';
import { validateRequest } from '../middlewares/validator';

const router = Router();

// --- Configuración de Multer para la subida de archivos ---
const uploadsDir = path.join(__dirname, '../../uploads');
fs.ensureDirSync(uploadsDir);

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'pdf'));
        }
    }
});

const waitForSessionReady = (session: WhatsAppClient, timeout = 30000): Promise<void> => {
    return new Promise((resolve, reject) => {
        if (session.isReady()) {
            return resolve();
        }

        const onReady = () => {
            clearTimeout(timer);
            session.removeListener('disconnected', onDisconnect);
            resolve();
        };

        const onDisconnect = () => {
            clearTimeout(timer);
            session.removeListener('ready', onReady);
            reject(new Error('La sesión se desconectó durante la espera.'));
        };

        const timer = setTimeout(() => {
            session.removeListener('ready', onReady);
            session.removeListener('disconnected', onDisconnect);
            reject(new Error('Timeout esperando que la sesión esté lista.'));
        }, timeout);

        session.once('ready', onReady);
        session.once('disconnected', onDisconnect);
    });
};

// --- Rutas de la API ---

router.get(
    '/:sessionId/:messageId/status',
    [
        param('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.'),
        param('messageId').isString().notEmpty().withMessage('El messageId es requerido.')
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId, messageId } = req.params;
        if (!sessionId || !messageId) {
            return res.status(400).json({ status: 'error', message: 'sessionId y messageId son requeridos.' });
        }
        const session = await whatsappClientManager.getSession(sessionId);

        if (!session) {
            return res.status(404).json({ status: 'error', message: 'La sesión no existe.' });
        }

        const message = session.getOutgoingMessage(messageId);
        if (!message) {
            return res.status(404).json({
                status: 'error',
                message: 'No se encontró el mensaje en el registro de esta sesión.'
            });
        }

        return res.status(200).json({ status: 'ok', message });
    }
);

router.post('/send-text', 
    [
        body('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.'),
        body('to').isString().notEmpty().withMessage('El destinatario (to) es requerido.'),
        body('message').isString().notEmpty().withMessage('El mensaje (message) es requerido.')
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId, to, message } = req.body;
        try {
            const session = await whatsappClientManager.getSession(sessionId);

            if (!session) {
                return res.status(404).json({ status: 'error', message: 'La sesión no existe.' });
            }

            await waitForSessionReady(session);

            const sentMessage = await session.sendTextMessage(to, message);
            const delivery = sentMessage?.key.id && session.getOutgoingMessage(sentMessage.key.id);
            res.status(200).json({
                status: 'ok',
                message: 'Mensaje aceptado por WhatsApp.',
                messageId: sentMessage?.key.id,
                delivery
            });
        } catch (error: any) {
            console.error(`[${sessionId}] Error en /send-text:`, error.message);
            if (error.message.includes('no existe en WhatsApp')) {
                return res.status(404).json({ status: 'error', message: error.message });
            }
            res.status(500).json({ status: 'error', message: 'Error al enviar el mensaje.', details: error.message });
        }
    }
);

router.post('/send-pdf', 
    upload.single('pdf'), 
    [
        body('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.'),
        body('to').isString().notEmpty().withMessage('El destinatario (to) es requerido.')
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId, to, caption } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ status: 'error', message: 'El archivo PDF es requerido.' });
        }

        try {
            const session = await whatsappClientManager.getSession(sessionId);

            if (!session) {
                return res.status(404).json({ status: 'error', message: 'Inicie sesion en configuracion general.' });
            }

            await waitForSessionReady(session);

            const sentMessage = await session.sendPdfMessage(to, file.path, caption || '');
            const delivery = sentMessage?.key.id && session.getOutgoingMessage(sentMessage.key.id);
            res.status(200).json({
                status: 'ok',
                message: 'PDF aceptado por WhatsApp.',
                messageId: sentMessage?.key.id,
                delivery
            });
        } catch (error: any) {
            console.error(`[${sessionId}] Error en /send-pdf:`, error.message);
            if (error.message.includes('no existe en WhatsApp')) {
                res.status(404).json({ status: 'error', message: error.message });
            } else {
                res.status(500).json({ status: 'error', message: 'Error al enviar el PDF.', details: error.message });
            }
        } finally {
            fs.unlink(file.path, (err: NodeJS.ErrnoException | null) => {
                if (err) console.error(`Error al eliminar el archivo temporal: ${file.path}`, err);
            });
        }
    }
);

router.post('/send-contact', 
    [
        body('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.'),
        body('to').isString().notEmpty().withMessage('El destinatario (to) es requerido.'),
        body('message').isString().notEmpty().withMessage('El mensaje (message) es requerido.')
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId, to, message } = req.body; 
        try {
            const session = await whatsappClientManager.getSession(sessionId);

            if (!session) {
                return res.status(404).json({ status: 'error', message: 'La sesión no existe.' });
            }

            await waitForSessionReady(session);

            const sentMessage = await session.sendTextMessage(to, message);
            const delivery = sentMessage?.key.id && session.getOutgoingMessage(sentMessage.key.id);
            res.status(200).json({
                status: 'ok',
                message: 'Mensaje aceptado por WhatsApp.',
                messageId: sentMessage?.key.id,
                delivery
            });
        } catch (error: any) {
            console.error(`[${sessionId}] Error en /send-text:`, error.message);
            if (error.message.includes('no existe en WhatsApp')) {
                return res.status(404).json({ status: 'error', message: error.message });
            }
            res.status(500).json({ status: 'error', message: 'Error al enviar el mensaje.', details: error.message });
        }
    }
);

router.post('/send-admin', 
    upload.single('pdf'), 
    [
        body('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.')
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId, to, caption } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ status: 'error', message: 'El archivo PDF es requerido.' });
        }

        try {
            const session = await whatsappClientManager.getSession(sessionId);

            if (!session) {
                return res.status(400).json({ status: 'error', message: 'Inicie sesion en configuracion general.' });
            }

            await waitForSessionReady(session);

            const groupJid = await session.getGroupJidByName('DataE-Admin');

            if (!groupJid) {
                return res.status(400).json({ status: 'error', message: 'El grupo "DataE-Admin" no fue encontrado.' });
            }

            const sentMessage = await session.sendGroupPdfMessage(groupJid, file.path, caption || '');
            const delivery = sentMessage?.key.id && session.getOutgoingMessage(sentMessage.key.id);

            res.status(200).json({
                status: 'ok',
                message: 'PDF aceptado por WhatsApp.',
                messageId: sentMessage?.key.id,
                delivery
            });
        } catch (error: any) {
            console.error(`[${sessionId}] Error en /send-pdf:`, error.message);
            if (error.message.includes('no existe en WhatsApp')) {
                res.status(200).json({ status: 'error', message: error.message });
            } else {
                res.status(500).json({ status: 'error', message: 'Error al enviar el PDF.', details: error.message });
            }
        } finally {
            fs.unlink(file.path, (err: NodeJS.ErrnoException | null) => {
                if (err) console.error(`Error al eliminar el archivo temporal: ${file.path}`, err);
            });
        }
    }
);

export default router;