
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
            // Usar un error de Multer para un mejor manejo posterior
            cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'pdf'));
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
    } catch (error: any) {
        console.error('Error en /send-text:', error.message);
        if (error.message.includes('no existe en WhatsApp')) {
            return res.status(404).json({ status: 'error', message: error.message });
        }
        res.status(500).json({ status: 'error', message: 'Error al enviar el mensaje.', details: error.message });
    }
});

router.post('/send-pdf', upload.single('pdf'), async (req: Request, res: Response) => {
    const { to, caption } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ status: 'error', message: 'El archivo PDF es requerido.' });
    }

    try {
        if (!to) {
            return res.status(400).json({ status: 'error', message: 'El campo "to" es requerido.' });
        }
        if (!whatsappClient.isReady()) {
            return res.status(500).json({ status: 'error', message: 'El cliente de WhatsApp no está listo.' });
        }

        await whatsappClient.sendPdfMessage(to, file.path, caption || '');
        res.status(200).json({ status: 'ok', message: 'Mensaje con PDF enviado.' });
    } catch (error: any) {
        console.error('Error en /send-pdf:', error.message);
        if (error.message.includes('no existe en WhatsApp')) {
            res.status(404).json({ status: 'error', message: error.message });
        } else {
            res.status(500).json({ status: 'error', message: 'Error al enviar el PDF.', details: error.message });
        }
    } finally {
        // Aseguramos que el archivo se elimine siempre, tanto en éxito como en error.
        if (file) {
            fs.unlink(file.path, (err) => {
                if (err) console.error(`Error al eliminar el archivo temporal: ${file.path}`, err);
            });
        }
    }
});

export default router;
