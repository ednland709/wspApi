
import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { whatsappClient } from '../whatsapp/client';

const router = Router();

// --- Configuración de Multer para la subida de archivos ---
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        // Conservar el nombre original del archivo
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos PDF.'));
        }
    }
});

// --- Rutas de la API ---

router.get('/status', (req: Request, res: Response) => {
    const isReady = whatsappClient.isReady();
    res.status(200).json({
        status: 'ok',
        isReady: isReady,
        message: isReady ? 'Cliente de WhatsApp listo.' : 'Cliente de WhatsApp no está listo.'
    });
});

router.post('/send-text', async (req: Request, res: Response) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ status: 'error', message: 'Los campos "to" y "message" son requeridos.' });
    }

    if (!whatsappClient.isReady()) {
        return res.status(500).json({ status: 'error', message: 'El cliente de WhatsApp no está listo.' });
    }

    try {
        await whatsappClient.sendTextMessage(to, message);
        res.status(200).json({ status: 'ok', message: 'Mensaje de texto enviado.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: 'error', message: 'Error al enviar el mensaje.', details: error });
    }
});

router.post('/send-pdf', upload.single('pdf'), async (req: Request, res: Response) => {
    const { to, caption } = req.body;

    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'El archivo PDF es requerido.' });
    }
    if (!to) {
        // Si falta el destinatario, eliminamos el archivo subido para no dejar basura
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ status: 'error', message: 'El campo "to" es requerido.' });
    }

    if (!whatsappClient.isReady()) {
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ status: 'error', message: 'El cliente de WhatsApp no está listo.' });
    }

    try {
        const pdfPath = req.file.path;
        await whatsappClient.sendPdfMessage(to, pdfPath, caption || '');
        // Opcional: eliminar el archivo después de enviarlo
        fs.unlinkSync(pdfPath);
        res.status(200).json({ status: 'ok', message: 'Mensaje con PDF enviado.' });
    } catch (error) {
        console.error(error);
        // Si hay un error, también eliminamos el archivo
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ status: 'error', message: 'Error al enviar el PDF.', details: error });
    }
});

export default router;
