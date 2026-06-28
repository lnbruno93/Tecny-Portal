/**
 * Red B2B — config del tenant (F4 #457).
 *
 * Endpoints bajo /api/red-b2b/config.
 *
 * Endpoints:
 *   GET    /                       → devuelve la config Red B2B del tenant
 *   PATCH  /caja-default           → actualiza red_b2b_caja_default_id
 *
 * La caja default cross-tenant se usa cuando recibimos un pago propagado
 * desde un partner (POST /operations/:id/pagos del OTRO lado) — para
 * registrar el cobro/pago del lado nuestro automáticamente.
 *
 * Si la caja default es NULL, el sistema usa la primera caja con moneda
 * compatible (fallback en lib/crossTenantPagos.js#resolveCajaParaTenant).
 *
 * Multi-tenant:
 *   GET usa withTenant (lee tenants.red_b2b_caja_default_id + metodos_pago).
 *   PATCH usa adminQuery porque la tabla `tenants` no es RLS-scoped al
 *   tenant_id de ella misma (es la tabla raíz). Validamos inline que el
 *   tenant_id matchee al caller.
 */

const router = require('express').Router();
const db = require('../../config/database');
const logger = require('../../lib/logger');
const validate = require('../../lib/validate');
const { setCajaDefaultSchema, setEmailPrefsSchema } = require('../../schemas/redB2b');

// Defaults idénticos al JSONB default de la migration 20260629000001. Si el
// tenant fue creado pre-F5 y la columna no se backfilleó (no debería pasar —
// la migration mete DEFAULT), devolvemos estos al frontend.
const DEFAULT_EMAIL_PREFS = Object.freeze({
  invitation_received:  true,
  invitation_accepted:  true,
  operation_received:   true,
  operation_cancelled:  true,
  payment_received:     true,
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/config
//
// Devuelve la config del tenant. F4 solo incluye caja_default; futuras
// fases pueden extender con notif preferences (F5), etc.
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const myTenantId = req.tenantId;
  try {
    const data = await db.adminQuery(async (client) => {
      const tQ = await client.query(
        `SELECT id, red_b2b_caja_default_id, red_b2b_email_prefs FROM tenants WHERE id = $1`,
        [myTenantId]
      );
      const t = tQ.rows[0];
      if (!t) return { notFound: true };
      let caja = null;
      if (t.red_b2b_caja_default_id) {
        const cQ = await client.query(
          `SELECT id, nombre, moneda, activo
             FROM metodos_pago
             WHERE id = $1 AND deleted_at IS NULL`,
          [t.red_b2b_caja_default_id]
        );
        caja = cQ.rows[0] || null;
      }
      return {
        caja_default_id: t.red_b2b_caja_default_id,
        caja_default: caja,
        email_prefs: { ...DEFAULT_EMAIL_PREFS, ...(t.red_b2b_email_prefs || {}) },
      };
    });
    if (data.notFound) {
      return res.status(404).json({ error: 'Tenant no encontrado', reason: 'not_found' });
    }
    return res.json({
      red_b2b: {
        caja_default_id: data.caja_default_id,
        caja_default: data.caja_default,
        email_prefs: data.email_prefs,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /api/red-b2b/config/caja-default
//
// Body: { caja_id: number|null }
//
// Validaciones:
//   - caja_id existe + activo (si no null)
//   - caja_id ∈ catálogo global (metodos_pago es catálogo, no tenant-scoped)
// ──────────────────────────────────────────────────────────────────────────
router.patch('/caja-default', validate(setCajaDefaultSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const { caja_id } = req.body;
  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // Validar caja existe + activa si no null.
        if (caja_id != null) {
          const cQ = await client.query(
            `SELECT id, nombre, moneda FROM metodos_pago
               WHERE id = $1 AND activo = true AND deleted_at IS NULL`,
            [caja_id]
          );
          if (!cQ.rows[0]) {
            await client.query('ROLLBACK');
            return { error: 'caja_not_found', status: 404 };
          }
        }
        // UPDATE tenant.
        const upd = await client.query(
          `UPDATE tenants SET red_b2b_caja_default_id = $1
             WHERE id = $2
             RETURNING red_b2b_caja_default_id`,
          [caja_id, myTenantId]
        );
        await client.query('COMMIT');
        return { ok: true, caja_default_id: upd.rows[0]?.red_b2b_caja_default_id };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
    if (result.error) {
      return res.status(result.status).json({
        error: result.error === 'caja_not_found'
          ? 'La caja indicada no existe o está inactiva.'
          : 'Acción inválida.',
        reason: result.error,
      });
    }
    logger.info({
      tenant_id: myTenantId, user_id: userId, caja_default_id: result.caja_default_id,
    }, '[red-b2b/F4] caja default actualizada');
    return res.json({ ok: true, caja_default_id: result.caja_default_id });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/config/email-prefs
//
// Devuelve solo las prefs (subset de GET / above). Útil para que la UI de
// Config → "Avisos por email" pueda cargar el form sin pedir todo el config.
// ──────────────────────────────────────────────────────────────────────────
router.get('/email-prefs', async (req, res, next) => {
  const myTenantId = req.tenantId;
  try {
    const prefs = await db.adminQuery(async (client) => {
      const q = await client.query(
        `SELECT red_b2b_email_prefs FROM tenants WHERE id = $1`,
        [myTenantId]
      );
      return { ...DEFAULT_EMAIL_PREFS, ...(q.rows[0]?.red_b2b_email_prefs || {}) };
    });
    return res.json({ email_prefs: prefs });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /api/red-b2b/config/email-prefs
//
// Body: { invitation_received?: bool, invitation_accepted?: bool, ... }
// Merge semánticamente con el JSONB existente — solo los flags presentes se
// pisan; los que no se mandan quedan tal cual.
//
// Implementation: jsonb_set chain en SQL (más atómico que read-modify-write
// en aplicación + más resistente a writes concurrentes — si el owner cambia
// un flag y un vendedor cambia otro a la vez, no se pisan).
// ──────────────────────────────────────────────────────────────────────────
router.patch('/email-prefs', validate(setEmailPrefsSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const updates = req.body; // { flag: bool, ... } — schema garantiza tipos

  try {
    const newPrefs = await db.adminQuery(async (client) => {
      // Construye una expresión `jsonb_set(jsonb_set(... , '{k1}', 'v1'::jsonb), '{k2}', 'v2'::jsonb)`
      // para mergear solo los flags presentes. Más limpio que CASE WHEN o
      // que serializar todo el jsonb desde JS.
      const keys = Object.keys(updates);
      // Defensive: schema ya garantiza >=1 key, pero re-checheamos para no
      // generar SQL inválido si algo cambia.
      if (keys.length === 0) {
        return null;
      }
      let expr = 'COALESCE(red_b2b_email_prefs, \'{}\'::jsonb)';
      const params = [];
      for (const k of keys) {
        params.push(JSON.stringify(updates[k]));
        // ${} interpolation de `k` aceptable porque schema .strict() lo limita
        // a la whitelist de 5 keys (no es input arbitrario del user).
        expr = `jsonb_set(${expr}, '{${k}}', $${params.length}::jsonb, true)`;
      }
      params.push(myTenantId);
      const q = await client.query(
        `UPDATE tenants
            SET red_b2b_email_prefs = ${expr}
          WHERE id = $${params.length}
          RETURNING red_b2b_email_prefs`,
        params
      );
      return { ...DEFAULT_EMAIL_PREFS, ...(q.rows[0]?.red_b2b_email_prefs || {}) };
    });

    logger.info(
      { tenant_id: myTenantId, user_id: userId, updated_keys: Object.keys(updates) },
      '[red-b2b/F5] email prefs actualizado'
    );
    return res.json({ ok: true, email_prefs: newPrefs });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
