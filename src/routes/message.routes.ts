import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { whatsappClientManager, WhatsAppClient } from '../whatsapp/client';
import { body } from 'express-validator';
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

            await session.sendTextMessage(to, message);
            res.status(200).json({ status: 'ok', message: 'Mensaje de texto enviado.' });
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
                fs.unlink(file.path);
                return res.status(404).json({ status: 'error', message: 'La sesión no existe.' });
            }

            await waitForSessionReady(session);

            await session.sendPdfMessage(to, file.path, caption || '');
            res.status(200).json({ status: 'ok', message: 'Mensaje con PDF enviado.' });
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

            await session.sendTextMessage(to, message);
            res.status(200).json({ status: 'ok', message: 'Mensaje de texto enviado.' });
        } catch (error: any) {
            console.error(`[${sessionId}] Error en /send-text:`, error.message);
            if (error.message.includes('no existe en WhatsApp')) {
                return res.status(404).json({ status: 'error', message: error.message });
            }
            res.status(500).json({ status: 'error', message: 'Error al enviar el mensaje.', details: error.message });
        }
    }
);

export default router;