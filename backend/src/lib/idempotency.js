/**
 * Helper compartido para Idempotency-Key en endpoints POST del módulo Financiero.
 *
 * 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
 *
 * Motivación: 5 endpoints POST del portal principal (ventas, cuentas/movimientos,
 * proveedores/movimientos, tarjetas/movimientos, cambios/movimientos) necesitan
 * el mismo pattern Idempotency-Key ya probado en Red B2B (COR-1 audit 2026-07-06,
 * lib/routes/redB2b/pagos.js). Este helper centraliza el pattern.
 *
 * Uso típico dentro del handler:
 *
 *   const idempotency = parseIdempotencyKey(req);
 *   if (idempotency.error) {
 *     return res.status(400).json({ error: idempotency.error, reason: 'idempotency_key_invalid' });
 *   }
 *   const { key } = idempotency;
 *
 *   // ... dentro de db.withTenant() BEGIN ...
 *   if (key) {
 *     const existing = await findExistingByIdempotencyKey(client, 'ventas', key);
 *     if (existing) {
 *       await client.query('ROLLBACK');
 *       return res.json({ ...existing, idempotent_replay: true });
 *     }
 *   }
 *   // Continuar con INSERT + side effects, incluir `client_generated_id: key`
 *
 * Race window residual: 2 requests entran a la tx en paralelo, ambos hacen
 * findExisting() y no encuentran → ambos intentan INSERT. El UNIQUE index parcial
 * atrapa al 2do en el commit (SQLSTATE 23505). El caller debe wrappear el
 * INSERT en try/catch y devolver 409 idempotency_conflict cuando eso ocurra.
 */

// UUID v1-v8 (RFC 9562). Aceptamos cualquier variante estándar.
// Formato: 8-4-4-4-12 hex, con la version en el 3er grupo (1-8) y el
// variant en el 4to grupo (89ab).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extrae + valida el header `Idempotency-Key` del request.
 *
 * @param {import('express').Request} req
 * @returns {{ key: string|null, error?: string }} — Si error está presente,
 *          el caller debe responder 400. Si key es null, el caller sigue el
 *          flow sin idempotency (backwards compat con clientes viejos).
 */
function parseIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  if (!raw) return { key: null };
  if (!UUID_RE.test(raw)) {
    return {
      key: null,
      error: 'Idempotency-Key debe ser UUID v1-8 (RFC 9562)',
    };
  }
  // Lowercase para normalizar — dos clientes que mandan el mismo UUID con
  // distinto casing deben resolver a la misma key en DB.
  return { key: raw.toLowerCase() };
}

/**
 * Busca una fila existente por (tenant_id implícito via RLS, client_generated_id).
 * Debe correr DENTRO de la tx del handler y bajo `db.withTenant()` para que RLS
 * filtre por tenant automáticamente.
 *
 * @param {import('pg').PoolClient} client - pg client dentro de la tx.
 * @param {string} tabla - Nombre de la tabla (ventas, movimientos_cc, etc.).
 *   Whitelisted contra las 5 tablas del Pattern G para evitar SQL injection
 *   accidental si un caller pasa string dinámico.
 * @param {string} key - UUID lowercase (viene de parseIdempotencyKey).
 * @returns {Promise<object|null>} - Fila existente completa (SELECT *) o null.
 */
async function findExistingByIdempotencyKey(client, tabla, key) {
  const TABLAS_PERMITIDAS = new Set([
    'ventas',
    'movimientos_cc',
    'proveedor_movimientos',
    'tarjeta_movimientos',
    'cambio_movimientos',
  ]);
  if (!TABLAS_PERMITIDAS.has(tabla)) {
    throw new Error(`Idempotency findExisting: tabla "${tabla}" no está en la whitelist`);
  }
  const { rows } = await client.query(
    `SELECT * FROM ${tabla} WHERE client_generated_id = $1 LIMIT 1`,
    [key]
  );
  return rows[0] || null;
}

/**
 * Detecta si un error de pg es de conflicto de UNIQUE index de idempotency.
 * Útil para el catch del INSERT — si dos requests llegan al INSERT en paralelo
 * (race window), el 2do falla con 23505 sobre `idx_<tabla>_idempotency`.
 *
 * @param {Error} err - Error de pg
 * @returns {boolean}
 */
function isIdempotencyConflict(err) {
  if (err?.code !== '23505') return false;
  const c = err.constraint || '';
  // Match cualquier constraint que termine en `_idempotency` — cubre las 5
  // tablas del Pattern G + el legacy `idx_ct_pagos_idempotency` de Red B2B.
  return c.endsWith('_idempotency');
}

module.exports = {
  UUID_RE,
  parseIdempotencyKey,
  findExistingByIdempotencyKey,
  isIdempotencyConflict,
};
