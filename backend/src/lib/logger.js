const pino = require('pino');

/**
 * Logger centralizado — Pino
 *
 * - En local (TTY detectado): usa pino-pretty para output legible
 * - En Railway/CI (no TTY):   JSON estructurado, listo para indexar
 * - En tests:                 nivel "warn" para no ensuciar el output
 */
const logger = pino({
  level: process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'warn' : 'info'),

  base: { service: 'ipro-backend' },

  timestamp: pino.stdTimeFunctions.isoTime,

  // Redacción de PII/secretos: evita que credenciales o datos sensibles
  // terminen en texto plano en los logs (ej. si un error arrastra el body
  // de un request o parámetros de una query de pg).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.password_hash',
      '*.newPassword',
      '*.currentPassword',
      '*.token',
      '*.DATABASE_URL',
      '*.JWT_SECRET',
    ],
    censor: '[REDACTED]',
  },

  // Auto-format en local, JSON en producción
  transport: process.stdout.isTTY
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});

module.exports = logger;
