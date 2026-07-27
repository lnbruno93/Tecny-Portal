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
      // PII/email (auditoría 2026-06-30 Q-01): los emails de usuarios finales
      // y URLs con token (verify, reset, etc.) NO deben quedar en logs en
      // texto plano. lib/email.js loguea `{to, verifyUrl, resetUrl, ...}` en
      // stub mode y en sends fallidos. Si los logs van a Sentry/Railway con
      // ACL laxo, un atacante con acceso a logs ve tokens activos + emails.
      // Cubrimos paths wildcard porque el field aparece en varios contextos
      // (req.body.email, args.to, opts.verifyUrl, etc.).
      '*.to',
      '*.email',
      '*.cliente_email',
      '*.verifyUrl',
      '*.resetUrl',
    ],
    censor: '[REDACTED]',
  },

  // Auto-format en local, JSON en producción.
  //
  // 2026-07-27 (audit 07-25 Plataforma P2-1 fix): antes el check era
  // `process.stdout.isTTY && NODE_ENV !== 'production'`. En Railway hoy
  // NODE_ENV=production en TODOS los envs (prod + staging), así que el
  // check funciona por accidente feliz. Pero si algún día alguien setea
  // NODE_ENV=staging en Railway staging (razonable), pino intentaría
  // cargar pino-pretty en un container donde NO está instalado (es
  // devDependency) y throwaría al boot.
  //
  // El check nuevo es más robusto: solo activa pino-pretty si el módulo
  // está disponible (`require.resolve` sin throw). En prod pino-pretty
  // NO está instalado → resolve throwea → transport=undefined → JSON
  // logs, independiente del valor de NODE_ENV.
  //
  // Bonus: en local (dev con devDeps instaladas) sigue funcionando igual
  // porque require.resolve succeeds → sale pino-pretty.
  transport: (() => {
    if (!process.stdout.isTTY) return undefined;
    try {
      require.resolve('pino-pretty');
      return { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } };
    } catch {
      return undefined;
    }
  })(),
});

module.exports = logger;
