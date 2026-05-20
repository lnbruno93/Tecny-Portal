const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes        = require('./routes/auth');
const vendedoresRoutes  = require('./routes/vendedores');
const comprobantesRoutes= require('./routes/comprobantes');
const pagosRoutes       = require('./routes/pagos');
const historialRoutes   = require('./routes/historial');
const configRoutes      = require('./routes/config');
const ocrRoutes         = require('./routes/ocr');
const contactosRoutes   = require('./routes/contactos');
const cajasRoutes       = require('./routes/cajas');
const enviosRoutes      = require('./routes/envios');
const usuariosRoutes    = require('./routes/usuarios');

const app = express();

// Trust Railway's load balancer so rate limiting uses the real client IP
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

// General rate limit: 300 req / 15 min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intentá de nuevo en 15 minutos' },
}));

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Strict login rate limit: 10 failed attempts / 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login, esperá 15 minutos' },
  skipSuccessfulRequests: true,
});
app.use('/api/auth/login', loginLimiter);

// Financiera
app.use('/api/auth',          authRoutes);
app.use('/api/vendedores',    vendedoresRoutes);
app.use('/api/comprobantes',  comprobantesRoutes);
app.use('/api/pagos',         pagosRoutes);
app.use('/api/historial',     historialRoutes);
app.use('/api/config',        configRoutes);
app.use('/api/ocr',           ocrRoutes);

// Cajas
app.use('/api/contactos',     contactosRoutes);
app.use('/api/cajas',         cajasRoutes);

// Envíos
app.use('/api/envios',        enviosRoutes);

// Usuarios (admin)
app.use('/api/usuarios',      usuariosRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});

module.exports = app;
