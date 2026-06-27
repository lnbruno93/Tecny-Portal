/**
 * Red B2B — partnerships lifecycle (F1).
 *
 * Endpoints bajo /api/red-b2b/partnerships. Diseño completo en
 * docs/design/red-b2b-cross-tenant.md sección 5.1 + 6.1.
 *
 * Lifecycle:
 *   POST   /invite        → crea partnership status='pending'
 *   POST   /:id/accept    → status='active' + crea contactos linkeados
 *   POST   /:id/reject    → status='revoked' con motivo='rechazado'
 *   POST   /:id/revoke    → status='revoked' (cualquier lado)
 *   GET    /              → lista partnerships del tenant actual (con counts)
 *   GET    /:id           → detalle (stats vacías en F1 — F3+ las llena)
 *
 * Multi-tenant strict + cross-tenant escape hatch:
 *   - tenant_partnerships y cross_tenant_notifications son las únicas tablas
 *     que esta route toca. Las primeras tienen RLS dual (visible a ambos
 *     tenants); las segundas tienen RLS estándar por tenant_id receptor.
 *   - Para ESCRIBIR cross-tenant (notification al partner, etc.) usamos
 *     `db.adminQuery()` (BYPASSRLS / role tecny_admin). La defensa real
 *     contra leak está en la validación INLINE del partnership_id contra
 *     el tenant del caller, ANTES de cualquier escritura.
 *   - Convención de tenant_a < tenant_b: helpers `orderTenantIds` y
 *     `getActivePartnership` en lib/partnership.js — siempre usar para
 *     evitar el bug clásico de buscar (B,A) cuando guardamos (A,B).
 *
 * Audit:
 *   POST /invite y POST /:id/revoke escriben a tenant_admin_actions con
 *   action='cross_tenant_partnership_created' o '_revoked' respectivamente
 *   (migration 20260627000002 agregó los valores al CHECK).
 *   accept/reject NO escriben acá — son acciones del lado receptor y
 *   bastan las notifications + la fila de partnership con accepted_*.
 *
 * Rate limit:
 *   POST /invite: 10/hora/user, con PostgresRateLimitStore (consistente
 *   entre réplicas). Por user_id, no IP — un NAT compartido no penaliza
 *   a otros users del mismo tenant.
 *
 * Cooldown anti-spam:
 *   Si A revoca a B, A no puede re-invitar a B por 24h. Enforced inline en
 *   POST /invite buscando el último revoke entre los mismos dos tenants.
 */

const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../../config/database');
const logger = require('../../lib/logger');
const validate = require('../../lib/validate');
const parseId = require('../../lib/parseId');
const PostgresRateLimitStore = require('../../lib/postgresRateLimitStore');
const {
  orderTenantIds,
  getActivePartnershipById,
} = require('../../lib/partnership');
const {
  inviteSchema,
  revokeSchema,
  rejectSchema,
} = require('../../schemas/redB2b');

const isTestEnv = process.env.NODE_ENV === 'test';
const COOLDOWN_HOURS = 24;

// Rate limit store lazy-init — mismo patrón que chat.js. En tests se skipea
// (los limiters tienen skip: isTestEnv) así que la store nunca se materializa.
let _inviteStore = null;
function getInviteStore() {
  if (isTestEnv) return undefined;
  if (!_inviteStore) {
    _inviteStore = new PostgresRateLimitStore({
      db,
      prefix: 'red-b2b-invite',
      logger,
    });
  }
  return _inviteStore;
}

// 10 invitaciones/hora/user. Sobre el mismo limiter del global (300/15min
// authenticated bypass), esto solo aplica a /invite — el resto de los
// endpoints son baratos.
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Pasaste el límite de 10 invitaciones por hora. Esperá un momento.',
  },
  keyGenerator: (req) =>
    req.user?.id != null ? `u${req.user.id}` : ipKeyGenerator(req),
  skip: () => isTestEnv,
  ...(getInviteStore() && { store: getInviteStore() }),
});

// ──────────────────────────────────────────────────────────────────────────
// Helper: notify(client, tenantId, type, payload, opts)
//
// Inserta una fila en cross_tenant_notifications. tenant_id es el RECEPTOR.
// Como la tabla tiene FORCE RLS, necesitamos setear el contexto del receptor
// antes del INSERT (incluso con BYPASSRLS de tecny_admin, los WITH CHECK
// chequean el setting). Lo hacemos con SET LOCAL dentro de la tx.
// ──────────────────────────────────────────────────────────────────────────
async function notify(client, tenantId, type, payload, opts = {}) {
  await client.query(`SET LOCAL app.current_tenant = ${Number(tenantId)}`);
  await client.query(
    `INSERT INTO cross_tenant_notifications
       (tenant_id, partnership_id, cross_tenant_operation_id, type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      tenantId,
      opts.partnershipId || null,
      opts.operationId || null,
      type,
      JSON.stringify(payload),
    ]
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: audit(client, tenantId, userId, action, payload)
//
// Escribe a tenant_admin_actions (audit del super-admin / acciones admin
// del tenant). El super_admin_user_id queda con el user_id del invocador
// — el nombre del campo es histórico, en práctica es "quien actuó".
// ──────────────────────────────────────────────────────────────────────────
async function audit(client, { tenantId, userId, action, payload }) {
  await client.query(
    `INSERT INTO tenant_admin_actions
       (tenant_id, super_admin_user_id, action, before_state, after_state, reason)
     VALUES ($1, $2, $3, NULL, $4::jsonb, NULL)`,
    [tenantId, userId, action, JSON.stringify(payload || {})]
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: tenantSnapshot(row) — proyecta los fields públicos del tenant
// que devolvemos en responses (sin datos sensibles internos).
// ──────────────────────────────────────────────────────────────────────────
function tenantSnapshot(row) {
  if (!row) return null;
  return {
    id:     row.id,
    nombre: row.nombre,
    slug:   row.slug,
    plan:   row.plan,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/partnerships/invite
//
// Crea una partnership status='pending' invitando al tenant identificado
// por slug. El caller debe tener cap cross_tenant.write (gateado al mount).
//
// Validaciones:
//   1. Target tenant existe + no suspended + no deleted.
//   2. No existe ya partnership ACTIVA o PENDING entre los dos.
//   3. Cooldown 24h desde el último revoke entre estos dos tenants.
//   4. Rate limit 10/hora/user (middleware).
//
// Side effects (todo en una tx):
//   - INSERT tenant_partnerships(status='pending')
//   - INSERT cross_tenant_notifications type='invitation_received' al target
//   - INSERT tenant_admin_actions del invitador
// ──────────────────────────────────────────────────────────────────────────
router.post('/invite', inviteLimiter, validate(inviteSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const { target_tenant_slug, message } = req.body;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // 1. Lookup target tenant (BYPASSRLS — necesitamos ver tenants
        // de cualquier slug, no solo el mío). Defensive: chequeamos
        // deleted_at y suspended_at separados para mensajes claros.
        const targetQ = await client.query(
          `SELECT id, nombre, slug, plan, suspended_at, deleted_at
             FROM tenants
            WHERE slug = $1
            LIMIT 1`,
          [target_tenant_slug]
        );
        const target = targetQ.rows[0];

        if (!target || target.deleted_at) {
          await client.query('ROLLBACK');
          return { error: 'target_not_found', status: 404 };
        }
        if (target.id === myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'cannot_invite_self', status: 400 };
        }
        if (target.suspended_at) {
          await client.query('ROLLBACK');
          return { error: 'target_suspended', status: 409 };
        }

        // 2. Existe ya partnership pending o active entre nosotros?
        const [a, b] = orderTenantIds(myTenantId, target.id);
        const existingQ = await client.query(
          `SELECT id, status FROM tenant_partnerships
             WHERE tenant_a_id = $1 AND tenant_b_id = $2
               AND status IN ('pending', 'active')
             LIMIT 1`,
          [a, b]
        );
        if (existingQ.rows[0]) {
          await client.query('ROLLBACK');
          return {
            error: existingQ.rows[0].status === 'active'
              ? 'already_active'
              : 'already_pending',
            status: 409,
          };
        }

        // 3. Cooldown: si hay un revoke reciente (<24h) entre los mismos
        // dos tenants, bloqueamos re-invite. Anti-spam: el operador no
        // puede martillar al partner con invitaciones tras revocar.
        const cooldownQ = await client.query(
          `SELECT id, revoked_at FROM tenant_partnerships
             WHERE tenant_a_id = $1 AND tenant_b_id = $2
               AND status = 'revoked'
               AND revoked_at > NOW() - INTERVAL '${COOLDOWN_HOURS} hours'
             ORDER BY revoked_at DESC
             LIMIT 1`,
          [a, b]
        );
        if (cooldownQ.rows[0]) {
          await client.query('ROLLBACK');
          return {
            error: 'cooldown_active',
            status: 409,
            details: { revoked_at: cooldownQ.rows[0].revoked_at },
          };
        }

        // 4. INSERT partnership pending.
        const ins = await client.query(
          `INSERT INTO tenant_partnerships
             (tenant_a_id, tenant_b_id, status,
              invited_by_tenant_id, invited_by_user_id,
              invitation_message)
           VALUES ($1, $2, 'pending', $3, $4, $5)
           RETURNING *`,
          [a, b, myTenantId, userId, message || null]
        );
        const partnership = ins.rows[0];

        // 5. Lookup nuestro propio tenant para el payload de la notif.
        const meQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
          [myTenantId]
        );
        const me = meQ.rows[0];

        // 6. Notif al target.
        await notify(
          client,
          target.id,
          'invitation_received',
          {
            from_tenant: tenantSnapshot(me),
            invited_by_user_id: userId,
            invited_by_username: req.user.username,
            invitation_message: message || null,
          },
          { partnershipId: partnership.id }
        );

        // 7. Audit (acción del invitador).
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_partnership_created',
          payload: {
            partnership_id: partnership.id,
            target_tenant: tenantSnapshot(target),
          },
        });

        await client.query('COMMIT');
        return { ok: true, partnership, target };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
        ...(result.details ? { details: result.details } : {}),
      });
    }

    logger.info(
      {
        actor_user_id: userId,
        actor_tenant_id: myTenantId,
        target_tenant_id: result.target.id,
        partnership_id: result.partnership.id,
      },
      '[red-b2b] partnership invite creado'
    );

    return res.status(201).json({
      partnership: {
        id: result.partnership.id,
        status: result.partnership.status,
        invited_at: result.partnership.invited_at,
        partner: tenantSnapshot(result.target),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/partnerships/:id/accept
//
// Cambia status='pending' → 'active'. Solo el lado TARGET puede aceptar
// (no el que invitó). Crea contactos linkeados en ambos tenants.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/accept', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const partnershipId = parseId(req.params.id);
  if (!partnershipId) return res.status(400).json({ error: 'id inválido' });

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // Lookup + autoridad: el caller participa en la partnership?
        const partnership = await getActivePartnershipById(client, partnershipId, myTenantId);
        if (!partnership) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (partnership.status !== 'pending') {
          await client.query('ROLLBACK');
          return { error: `cannot_accept_status_${partnership.status}`, status: 409 };
        }
        // Solo el lado target (NO el invitador) puede aceptar.
        if (partnership.invited_by_tenant_id === myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'cannot_accept_own_invite', status: 403 };
        }

        // Update a active.
        const updQ = await client.query(
          `UPDATE tenant_partnerships
              SET status='active', accepted_by_user_id=$1, accepted_at=NOW()
            WHERE id=$2 AND status='pending'
            RETURNING *`,
          [userId, partnershipId]
        );
        const updated = updQ.rows[0];
        if (!updated) {
          // Race: alguien aceptó/revocó en paralelo.
          await client.query('ROLLBACK');
          return { error: 'race_condition', status: 409 };
        }

        // Cargar datos de ambos tenants para snapshots + contactos.
        const tenantsQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = ANY($1::int[])`,
          [[partnership.tenant_a_id, partnership.tenant_b_id]]
        );
        const tenantsById = new Map(tenantsQ.rows.map((t) => [t.id, t]));
        const meTenant = tenantsById.get(myTenantId);
        const otherTenantId = partnership.tenant_a_id === myTenantId
          ? partnership.tenant_b_id
          : partnership.tenant_a_id;
        const otherTenant = tenantsById.get(otherTenantId);

        // Crear/linkear contactos en AMBOS lados. Si existe un contacto con
        // nombre igual al partner (y sin linked_tenant_id), lo linkeamos.
        // Sino, INSERT nuevo con tipo='cliente' (default) — el operador puede
        // editar después.
        //
        // El nombre matchea exact-case porque queremos evitar accidentes
        // (ej. un "TekHaus" vs "tekhaus" que apunte a otra cosa).
        await upsertLinkedContacto(client, {
          ownerTenantId: meTenant.id,
          linkedTenant: otherTenant,
        });
        await upsertLinkedContacto(client, {
          ownerTenantId: otherTenant.id,
          linkedTenant: meTenant,
        });

        // Notif al invitador.
        await notify(
          client,
          partnership.invited_by_tenant_id,
          'invitation_accepted',
          {
            partner: tenantSnapshot(meTenant),
            accepted_by_user_id: userId,
            accepted_by_username: req.user.username,
          },
          { partnershipId: updated.id }
        );

        await client.query('COMMIT');
        return { ok: true, partnership: updated, otherTenant };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
      });
    }

    logger.info(
      { user_id: userId, tenant_id: myTenantId, partnership_id: partnershipId },
      '[red-b2b] partnership aceptada'
    );

    return res.json({
      partnership: {
        id: result.partnership.id,
        status: result.partnership.status,
        accepted_at: result.partnership.accepted_at,
        partner: tenantSnapshot(result.otherTenant),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// Helper: crea (o linkea con uno existente) el contacto que representa al
// partner en el tenant `ownerTenantId`. SET LOCAL antes para satisfacer
// el RLS estándar de contactos.
async function upsertLinkedContacto(client, { ownerTenantId, linkedTenant }) {
  await client.query(`SET LOCAL app.current_tenant = ${Number(ownerTenantId)}`);

  // Buscar contacto pre-existente con el mismo nombre que no esté ya linkeado.
  // Si hay uno, lo linkeamos (preservando datos preexistentes). Sino, INSERT.
  const existingQ = await client.query(
    `SELECT id FROM contactos
       WHERE nombre = $1
         AND linked_tenant_id IS NULL
       LIMIT 1`,
    [linkedTenant.nombre]
  );
  if (existingQ.rows[0]) {
    await client.query(
      `UPDATE contactos SET linked_tenant_id = $1 WHERE id = $2`,
      [linkedTenant.id, existingQ.rows[0].id]
    );
    return existingQ.rows[0].id;
  }
  // INSERT nuevo. tipo='cliente' por default — la mayoría de las relaciones
  // B2B son "le vendo a este partner". Si en realidad le compro, el operador
  // puede flipearlo después. origen=NULL porque el CHECK constraint actual
  // no incluye 'red_b2b' como valor válido (migration 20260527000003). En F3
  // podemos extender el enum si hace falta filtrar contactos por origen Red B2B
  // en la UI; por ahora `linked_tenant_id IS NOT NULL` es el filtro natural.
  const ins = await client.query(
    `INSERT INTO contactos (nombre, tipo, linked_tenant_id, tenant_id)
     VALUES ($1, 'cliente', $2, $3)
     RETURNING id`,
    [linkedTenant.nombre, linkedTenant.id, ownerTenantId]
  );
  return ins.rows[0].id;
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/partnerships/:id/reject
//
// El target rechaza una invitación pending. Decisión vs el diseño original:
// el doc decía "borrar la fila pending", pero la tarea pidió "deja la
// partnership en revoked con motivo 'rechazado'" — preservamos el rastro
// para audit + el cooldown anti-spam de re-invite sigue aplicando.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/reject', validate(rejectSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const partnershipId = parseId(req.params.id);
  if (!partnershipId) return res.status(400).json({ error: 'id inválido' });

  const { reason } = req.body;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const partnership = await getActivePartnershipById(client, partnershipId, myTenantId);
        if (!partnership) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (partnership.status !== 'pending') {
          await client.query('ROLLBACK');
          return { error: `cannot_reject_status_${partnership.status}`, status: 409 };
        }
        if (partnership.invited_by_tenant_id === myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'cannot_reject_own_invite', status: 403 };
        }

        // Marcar como revoked con motivo "rechazado" (decisión de la tarea
        // — preservamos la fila para audit en vez de DELETE como decía
        // el doc original).
        const motivo = reason
          ? `rechazado: ${reason}`
          : 'rechazado';
        const updQ = await client.query(
          `UPDATE tenant_partnerships
              SET status='revoked',
                  revoked_by_tenant_id=$1,
                  revoked_by_user_id=$2,
                  revoked_at=NOW(),
                  revoked_reason=$3
            WHERE id=$4 AND status='pending'
            RETURNING *`,
          [myTenantId, userId, motivo, partnershipId]
        );
        const updated = updQ.rows[0];
        if (!updated) {
          await client.query('ROLLBACK');
          return { error: 'race_condition', status: 409 };
        }

        // Notif al invitador.
        const meQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
          [myTenantId]
        );
        await notify(
          client,
          partnership.invited_by_tenant_id,
          'invitation_rejected',
          {
            partner: tenantSnapshot(meQ.rows[0]),
            reason: reason || null,
          },
          { partnershipId: updated.id }
        );

        await client.query('COMMIT');
        return { ok: true, partnership: updated };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
      });
    }

    return res.json({
      partnership: {
        id: result.partnership.id,
        status: result.partnership.status,
        revoked_at: result.partnership.revoked_at,
        revoked_reason: result.partnership.revoked_reason,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/partnerships/:id/revoke
//
// Cualquiera de los dos lados puede revocar una partnership activa o
// pending (cancela). Operaciones cross-tenant existentes quedan tal cual
// (read-only) — F3 implementa esa parte.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/revoke', validate(revokeSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const partnershipId = parseId(req.params.id);
  if (!partnershipId) return res.status(400).json({ error: 'id inválido' });

  const { reason } = req.body;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const partnership = await getActivePartnershipById(client, partnershipId, myTenantId);
        if (!partnership) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (partnership.status === 'revoked') {
          await client.query('ROLLBACK');
          return { error: 'already_revoked', status: 409 };
        }

        // Update — la fila state CHECK garantiza consistencia
        // (status='revoked' requiere revoked_at NOT NULL).
        const updQ = await client.query(
          `UPDATE tenant_partnerships
              SET status='revoked',
                  revoked_by_tenant_id=$1,
                  revoked_by_user_id=$2,
                  revoked_at=NOW(),
                  revoked_reason=$3
            WHERE id=$4 AND status IN ('pending', 'active')
            RETURNING *`,
          [myTenantId, userId, reason || null, partnershipId]
        );
        const updated = updQ.rows[0];
        if (!updated) {
          await client.query('ROLLBACK');
          return { error: 'race_condition', status: 409 };
        }

        // Notif al OTRO lado.
        const otherTenantId = partnership.tenant_a_id === myTenantId
          ? partnership.tenant_b_id
          : partnership.tenant_a_id;
        const meQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
          [myTenantId]
        );
        await notify(
          client,
          otherTenantId,
          'partnership_revoked',
          {
            partner: tenantSnapshot(meQ.rows[0]),
            reason: reason || null,
          },
          { partnershipId: updated.id }
        );

        // Audit (acción del que revoca).
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_partnership_revoked',
          payload: {
            partnership_id: updated.id,
            other_tenant_id: otherTenantId,
            reason: reason || null,
          },
        });

        await client.query('COMMIT');
        return { ok: true, partnership: updated };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
      });
    }

    logger.info(
      { user_id: userId, tenant_id: myTenantId, partnership_id: partnershipId },
      '[red-b2b] partnership revocada'
    );

    return res.json({
      partnership: {
        id: result.partnership.id,
        status: result.partnership.status,
        revoked_at: result.partnership.revoked_at,
        revoked_reason: result.partnership.revoked_reason,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/partnerships
//
// Lista las partnerships donde mi tenant participa. Filtrable por status.
// Devuelve counts agregados (activos / pending recibidas / pending enviadas).
//
// Esta query SÍ pasa por RLS estándar (withTenant) — la policy dual de
// tenant_partnerships limita el SELECT a las filas donde mi tenant es
// tenant_a_id o tenant_b_id. No necesitamos adminQuery.
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const { status } = req.query;
  const validStatuses = ['pending', 'active', 'revoked'];
  const filterStatus = validStatuses.includes(status) ? status : null;

  try {
    const data = await db.withTenant(myTenantId, async (client) => {
      // Belt-and-suspenders: el WHERE explícito por mi tenant es defense
      // en depth sobre el RLS dual. Hace tests locales (superuser BYPASSRLS)
      // determinísticos y deja la lectura segura aún si el RLS cambiara
      // por error en una migration futura.
      const mineFilter = `(tenant_a_id = ${myTenantId} OR tenant_b_id = ${myTenantId})`;

      // Counts (siempre — el frontend los usa para badges en tabs).
      const countsQ = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active') AS active_count,
           COUNT(*) FILTER (
             WHERE status = 'pending' AND invited_by_tenant_id <> $1
           ) AS pending_received_count,
           COUNT(*) FILTER (
             WHERE status = 'pending' AND invited_by_tenant_id = $1
           ) AS pending_sent_count,
           COUNT(*) FILTER (WHERE status = 'revoked') AS revoked_count
           FROM tenant_partnerships
           WHERE ${mineFilter}`,
        [myTenantId]
      );

      // Listado.
      const where = [mineFilter];
      const params = [];
      if (filterStatus) {
        params.push(filterStatus);
        where.push(`p.status = $${params.length}`);
      }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const partnershipsQ = await client.query(
        `SELECT
           p.*,
           CASE WHEN p.tenant_a_id = ${myTenantId} THEN p.tenant_b_id
                ELSE p.tenant_a_id END AS other_tenant_id
           FROM tenant_partnerships p
           ${whereSql}
           ORDER BY p.invited_at DESC
           LIMIT 200`,
        params
      );

      // Hidratar datos del partner. Necesitamos cross-tenant (los tenants
      // están RLS-scoped pero tenants table en sí solo está bloqueada para
      // ROW-level — listamos por id sin filtrar tenant). Hacemos una query
      // separada con adminQuery porque el client withTenant tiene SET LOCAL
      // a mi tenant; lectura cruzada de tenants es OK porque solo proyecta
      // los fields públicos.
      return {
        counts: countsQ.rows[0],
        partnerships: partnershipsQ.rows,
      };
    });

    // Hidratar partner tenant info (cross-tenant lookup).
    const otherIds = [...new Set(data.partnerships.map((p) => p.other_tenant_id))];
    let tenantsById = new Map();
    if (otherIds.length > 0) {
      await db.adminQuery(async (client) => {
        const t = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = ANY($1::int[])`,
          [otherIds]
        );
        tenantsById = new Map(t.rows.map((r) => [r.id, r]));
      });
    }

    res.json({
      counts: {
        active_count:           Number(data.counts.active_count),
        pending_received_count: Number(data.counts.pending_received_count),
        pending_sent_count:     Number(data.counts.pending_sent_count),
        revoked_count:          Number(data.counts.revoked_count),
      },
      partnerships: data.partnerships.map((p) => ({
        id: p.id,
        status: p.status,
        invited_at: p.invited_at,
        invited_by_tenant_id: p.invited_by_tenant_id,
        invitation_message: p.invitation_message,
        accepted_at: p.accepted_at,
        revoked_at: p.revoked_at,
        revoked_by_tenant_id: p.revoked_by_tenant_id,
        revoked_reason: p.revoked_reason,
        // Side relativo al caller: 'sent' si yo invité, 'received' si me invitaron.
        my_side: p.invited_by_tenant_id === myTenantId ? 'sent' : 'received',
        partner: tenantSnapshot(tenantsById.get(p.other_tenant_id)),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/partnerships/:id
//
// Detalle de una partnership con stats (vacías en F1; F3+ las llena con
// counts reales de cross_tenant_operations).
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const partnershipId = parseId(req.params.id);
  if (!partnershipId) return res.status(400).json({ error: 'id inválido' });

  try {
    // Belt-and-suspenders: además del RLS dual (que filtra a las filas donde
    // mi tenant participa), agregamos el filtro INLINE. Razón: en tests locales
    // bajo role superuser BYPASSRLS, la policy no aplica — el filtro inline
    // garantiza que la query sea segura en TODOS los runtimes (test local,
    // staging con ipro_app NOSUPERUSER, prod). Cinturón.
    const partnership = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `SELECT * FROM tenant_partnerships
           WHERE id = $1
             AND (tenant_a_id = $2 OR tenant_b_id = $2)`,
        [partnershipId, myTenantId]
      );
      return q.rows[0] || null;
    });

    if (!partnership) {
      // RLS ya filtró — si no aparece, es 404 desde la perspectiva del caller
      // (sea porque no existe o porque no participa).
      return res.status(404).json({ error: 'No encontrada', reason: 'not_found' });
    }

    // Hidratar tenant partner.
    const otherTenantId = partnership.tenant_a_id === myTenantId
      ? partnership.tenant_b_id
      : partnership.tenant_a_id;
    let other = null;
    await db.adminQuery(async (client) => {
      const t = await client.query(
        `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
        [otherTenantId]
      );
      other = t.rows[0] || null;
    });

    return res.json({
      partnership: {
        id: partnership.id,
        status: partnership.status,
        invited_at: partnership.invited_at,
        invited_by_tenant_id: partnership.invited_by_tenant_id,
        invitation_message: partnership.invitation_message,
        accepted_at: partnership.accepted_at,
        revoked_at: partnership.revoked_at,
        revoked_by_tenant_id: partnership.revoked_by_tenant_id,
        revoked_reason: partnership.revoked_reason,
        my_side: partnership.invited_by_tenant_id === myTenantId ? 'sent' : 'received',
        partner: tenantSnapshot(other),
      },
      // Stats vacías en F1. F3+ las llena con counts reales de
      // cross_tenant_operations entre los dos tenants.
      stats: {
        operations_count: 0,
        total_usd_movido: 0,
        last_operation_at: null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Helper: mapping interno reason → mensaje user-friendly.
// Centralizado para que sea fácil agregar i18n en F5+ sin tocar handlers.
// ──────────────────────────────────────────────────────────────────────────
function errorMessage(reason) {
  const map = {
    target_not_found:        'No encontramos un tenant con ese slug.',
    cannot_invite_self:      'No podés invitarte a vos mismo.',
    target_suspended:        'Ese tenant está suspendido — no podés invitarlo ahora.',
    already_active:          'Ya tenés una partnership activa con ese tenant.',
    already_pending:         'Ya hay una invitación pendiente con ese tenant.',
    cooldown_active:         'Tenés que esperar 24h después de revocar para volver a invitar a este tenant.',
    not_found:               'Partnership no encontrada.',
    cannot_accept_own_invite:'No podés aceptar tu propia invitación.',
    cannot_reject_own_invite:'No podés rechazar tu propia invitación.',
    already_revoked:         'Esta partnership ya fue revocada.',
    race_condition:          'La partnership cambió de estado mientras procesábamos. Reintentá.',
  };
  if (map[reason]) return map[reason];
  if (reason.startsWith('cannot_accept_status_')) return 'No se puede aceptar una partnership en este estado.';
  if (reason.startsWith('cannot_reject_status_')) return 'No se puede rechazar una partnership en este estado.';
  return 'Acción inválida.';
}

module.exports = router;
