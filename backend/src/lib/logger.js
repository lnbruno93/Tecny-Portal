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
      // Campos 2FA (auditoría 2026-06-06 Sec M3): el código TOTP en texto plano,
      // los recovery codes (incluso si son hash bcrypt) y el secret cifrado no
      // deben terminar en logs si un error arrastra el req.body o el row de
      // user_2fa al logger.
      '*.code',
      '*.totp_code',
      '*.recovery_code',
      '*.recovery_codes',
      '*.recovery_codes_hash',
      '*.secret',
      '*.secret_encrypted',
      '*.TWOFA_ENCRYPTION_KEY',
    ],
    censor: '[REDACTED]',
  },

  // Auto-format en local, JSON en producción
  transport: process.stdout.isTTY
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});

module.exports = logger;
