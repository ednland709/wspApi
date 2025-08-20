
import express from 'express';
import bodyParser from 'body-parser';
import messageRoutes from './routes/message.routes';
import { whatsappClient } from './whatsapp/client';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rutas de la API
app.use('/api', messageRoutes);

// Ruta raíz para un simple health check
app.get('/', (req, res) => {
    res.send('Servidor de WhatsApp API está funcionando.');
});

// Iniciar el cliente de WhatsApp y luego el servidor Express
async function start() {
    console.log('Inicializando cliente de WhatsApp...');
    await whatsappClient.initialize();
    
    app.listen(PORT, () => {
        console.log(`Servidor escuchando en el puerto ${PORT}`);
        console.log(`Para ver el estado, visita http://localhost:${PORT}/api/status`);
    });
}

start().catch(error => {
    console.error('Error al iniciar la aplicación:', error);
});
