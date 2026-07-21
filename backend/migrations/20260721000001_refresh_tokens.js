/**
 * Refresh token pattern — Fase 1 backend (Task #190, 2026-07-21).
 *
 * Contexto:
 *   Los JWT actuales duran 8h (SE-01 2026-06-10 los bajó de 7d por XSS).
 *   Sin refresh token, los usuarios tienen que re-loguear cada 8h — UX
 *   incómodo. Reportado por clientes (Tek Haus, iOStoreUY).
 *
 * Diseño:
 *   Access token (JWT) sigue en localStorage con vida CORTA (15min).
 *   Refresh token en httpOnly cookie con vida LARGA (30 días).
 *   El frontend hace refresh silencioso ante 401 antes de mostrar login.
 *
 *   Cookie httpOnly = inaccesible desde JS = inmune a XSS. Un atacante que
 *   compromete una lib solo obtiene el access token (15min de ventana en
 *   lugar de 8h/7d).
 *
 * Modelo de datos:
 *   - `id` UUID PK (para revocación selectiva).
 *   - `user_id` FK a users con CASCADE (si borramos user, sus refresh
 *     tokens se limpian solos).
 *   - `token_hash` SHA-256 del token real (jamás guardamos plaintext —
 *     si la DB se compromete, el token no se puede reusar).
 *   - `expires_at` para expiración natural.
 *   - `revoked_at` NULL para revocación explícita sin borrar (mantiene
 *     historial forense de rotaciones + attack detection).
 *   - `ip` + `user_agent` para forense (compliance Ley 25.326 + GDPR).
 *   - `rotated_from_id` FK self-referencial: si un refresh se usa para
 *     emitir otro, guardamos la cadena. Attack detection: si alguien usa
 *     un refresh YA rotado, sabemos que hubo robo → revocar toda la cadena
 *     de refresh de ese user.
 *
 * Sin RLS: es tabla operativa (auth infra), no data de negocio. El acceso
 * es solo desde el backend con contexto de user_id de la request.
 *
 * Índices:
 *   - `token_hash` UNIQUE — lookup O(1) en cada refresh.
 *   - `user_id` — para revocar todos los tokens de un user (password change).
 *   - `expires_at` — para el purge job de tokens expirados.
 */

exports.up = (pgm) => {
  pgm.createTable('refresh_tokens', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'integer',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    token_hash: {
      type: 'text',
      notNull: true,
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    revoked_at: {
      type: 'timestamptz',
      notNull: false,
    },
    ip: {
      type: 'text',
      notNull: false,
    },
    user_agent: {
      type: 'text',
      notNull: false,
    },
    rotated_from_id: {
      type: 'uuid',
      references: '"refresh_tokens"(id)',
      onDelete: 'SET NULL',
      notNull: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Índices críticos para performance de refresh (endpoint hot-path):
  //  · token_hash UNIQUE — lookup del refresh en cada refresh call.
  //  · user_id — mass revoke al password change.
  //  · expires_at — purge job (cron mensual similar a audit_logs).
  pgm.createIndex('refresh_tokens', 'token_hash', { unique: true });
  pgm.createIndex('refresh_tokens', 'user_id');
  pgm.createIndex('refresh_tokens', 'expires_at');
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
};
