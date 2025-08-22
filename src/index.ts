import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import messageRoutes from './routes/message.routes';
import sessionRoutes from './routes/session.routes';
import cors from 'cors';
import https from 'https'; // Solo importar https
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 7080; // El puerto 7080 seguirá siendo el puerto de escucha, pero ahora para HTTPS

// Orígenes permitidos para CORS
const allowedOrigins = [
    'https://www.desystemsoft.com',
    'http://localhost:4200',
    'https://app2.desystemsoft.com',
    'https://dian.desystemsoft.com'
];

// Rutas a los archivos del certificado
const privateKeyPath = path.join(__dirname, '../cert', 'app.desystemsoft.com.key');
const certificatePath = path.join(__dirname, '../cert', 'app_desystemsoft_com.crt');

// Leer los archivos del certificado
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
const certificate = fs.readFileSync(certificatePath, 'utf8');

const credentials = { key: privateKey, cert: certificate };

// Crear servidor HTTPS
const httpsServer = https.createServer(credentials, app);

// Crear servidor Socket.IO y adjuntarlo al servidor HTTPS
export const io = new Server(httpsServer, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST']
    }
});

// Middleware CORS para Express
const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};
app.use(cors(corsOptions));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rutas de la API
app.use('/api/messages', messageRoutes);
app.use('/api/sessions', sessionRoutes);

// Ruta raíz para un simple health check
app.get('/', (req, res) => {
    res.send('Servidor de WhatsApp API (Multi-sesión con WebSockets) está funcionando.');
});

// Middleware de manejo de errores
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ status: 'error', message: `Tipo de archivo incorrecto. Solo se aceptan archivos PDF en el campo '${err.field}'.` });
        }
    }
    if (Array.isArray(err.errors)) {
        return res.status(400).json({ status: 'error', errors: err.errors });
    }

    res.status(500).json({ status: 'error', message: 'Algo salió mal en el servidor.' });
});

// Manejar conexiones de Socket.IO
io.on('connection', (socket) => {
    console.log('Cliente conectado por WebSocket:', socket.id);

    socket.on('join-session', (sessionId: string) => {
        socket.join(sessionId); // Unir el socket a una sala específica para el sessionId
        console.log(`Socket ${socket.id} unido a la sala ${sessionId}`);
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado de WebSocket:', socket.id);
    });
});

// Iniciar el servidor HTTPS
async function start() {
    httpsServer.listen(PORT, () => { // Ahora solo escucha en el puerto definido por PORT (o 7080)
        console.log(`Servidor HTTPS escuchando en el puerto ${PORT}`);
    });
}

start().catch(error => {
    console.error('Error al iniciar la aplicación:', error);
});