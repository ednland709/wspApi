
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import messageRoutes from './routes/message.routes';
import { whatsappClient } from './whatsapp/client';

const app = express();
const PORT = process.env.PORT || 7080;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rutas de la API
app.use('/api', messageRoutes);

// Ruta raíz para un simple health check
app.get('/', (req, res) => {
    res.send('Servidor de WhatsApp API está funcionando.');
});

// Middleware de manejo de errores (debe ir después de las rutas)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ status: 'error', message: `Tipo de archivo incorrecto. Solo se aceptan archivos PDF en el campo '${err.field}'.` });
        }
    }
    res.status(500).json({ status: 'error', message: 'Algo salió mal en el servidor.' });
});

// Iniciar el cliente de WhatsApp y luego el servidor Express
async function start() {
    console.log('Inicializando cliente de WhatsApp...');
    await whatsappClient.connect();
    
    app.listen(PORT, () => {
        console.log(`Servidor escuchando en el puerto ${PORT}`);
        console.log(`Para ver el estado, visita http://localhost:${PORT}/api/status`);
    });
}

start().catch(error => {
    console.error('Error al iniciar la aplicación:', error);
});
