import { Router, Request, Response } from 'express';
import { whatsappClientManager } from '../whatsapp/client';
import { body, param } from 'express-validator';
import { validateRequest } from '../middlewares/validator';

const router = Router();

// Iniciar una nueva sesión y obtener el QR
router.post(
    '/',
    [body('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.')],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId } = req.body; // Ahora se obtiene del body

        if (typeof sessionId !== 'string') {
            return res.status(400).json({ status: 'error', message: 'sessionId debe ser un string.' });
        }

        try {
            const session = whatsappClientManager.createSession(sessionId);

            // Si la sesión ya está lista, no hagas nada más.
            if (session.isReady()) {
                return res.status(200).json({ 
                    status: 'ok', 
                    message: 'La sesión ya está activa.',
                    sessionId
                });
            }

            // Si ya hay un QR, devuélvelo
            if (session.qr) {
                return res.status(200).json({ 
                    status: 'qr', 
                    qr: session.qr, 
                    message: 'Escanea el código QR para iniciar sesión.',
                    sessionId
                });
            }

            // Esperar por el evento QR con un timeout
            const qrPromise = new Promise((resolve, reject) => {
                session.once('qr', (qr) => resolve(qr));
                session.once('ready', () => resolve(null)); // Se conectó sin QR (ya tenía sesión)
                setTimeout(() => reject(new Error('Timeout esperando el código QR')), 60000); // 60s timeout
            });

            // Iniciar la conexión
            session.connect().catch(err => console.error(`[${sessionId}] Error al conectar:`, err));

            const qr = await qrPromise;

            if (qr) {
                res.status(200).json({ 
                    status: 'qr', 
                    qr: qr, 
                    message: 'Escanea el código QR para iniciar sesión.',
                    sessionId
                });
            } else {
                res.status(200).json({ 
                    status: 'ok', 
                    message: 'La sesión se ha activado correctamente (sin necesidad de QR).',
                    sessionId
                });
            }

        } catch (error: any) {
            console.error(`Error en /start para ${sessionId}:`, error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
);

// Cerrar una sesión
router.delete(
    '/:sessionId',
    [param('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.')],
    validateRequest,
    async (req: Request, res: Response) => {
        const { sessionId } = req.params;
        if (typeof sessionId !== 'string') {
            return res.status(400).json({ status: 'error', message: 'sessionId debe ser un string.' });
        }
        try {
            await whatsappClientManager.deleteSession(sessionId);
            res.status(200).json({ status: 'ok', message: `Sesión ${sessionId} cerrada.` });
        } catch (error: any) {
            console.error(`Error en /logout para ${sessionId}:`, error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
);

// Obtener el estado detallado de una sesión (consolidado)
router.get(
    '/:sessionId',
    [param('sessionId').isString().notEmpty().withMessage('El sessionId es requerido.')],
    validateRequest,
    (req: Request, res: Response) => {
        const { sessionId } = req.params;
        if (typeof sessionId !== 'string') {
            return res.status(400).json({ status: 'error', message: 'sessionId debe ser un string.' });
        }
        const session = whatsappClientManager.getSession(sessionId);

        if (!session) {
            return res.status(200).json({ status: 'nd' });
        }

        const isReady = session.isReady();
        let phoneNumber: string | undefined;

        if (isReady && session?.sock?.user?.id) {
            phoneNumber = session.sock.user.id.split(':')[0];
        }

        res.status(200).json({
            status: 'ok',
            sessionId,
            isReady,
            connectionState: session.connectionState,
            phoneNumber: phoneNumber,
            message: isReady ? 'Cliente de WhatsApp listo.' : 'Cliente de WhatsApp no está listo.'
        });
    }
);

export default router;