const pino = require('pino');

/**
 * Logger centralizado — Pino
 *
 * - En dev local (TTY + NODE_ENV != production): pino-pretty para output legible
 * - En Railway/CI (no TTY) o cualquier prod:    JSON estructurado, listo para indexar
 * - En tests:                                    nivel "warn" para no ensuciar el output
 *
 * El check de pretty exige TTY *y* NODE_ENV != 'production'. Solo TTY no alcanza:
 * la Console interactiva de Railway en prod/staging tiene stdout como TTY, pero
 * `pino-pretty` vive en devDependencies y los deploys de prod las saltean. Si
 * activáramos pretty ahí, pino throwearía al cargar el transport
 * ("unable to determine transport target for 'pino-pretty'"). Detectado
 * 2026-06-13 corriendo el backfill Tema C.2 desde la Console de staging.
 */
const logger = pino({
  level: process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'warn' : 'info'),

  base: { service: 'tecny-backend' },

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

  // Auto-format en local, JSON en producción. Ver razón del doble check
  // (TTY && !production) en el JSDoc de arriba.
  transport: (process.stdout.isTTY && process.env.NODE_ENV !== 'production')
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});

module.exports = logger;
