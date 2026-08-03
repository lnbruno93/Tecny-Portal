// routes/contactoTipos.js — CRUD de tipos de contacto editables per-tenant
// (task #290).
//
// Contexto: los 5 tipos (cliente/amigo/familiar/inversor/ipro team) estaban
// hardcoded en frontend + CHECK constraint en `contactos.tipo`. Consecuencias:
//   1. Divergencia UI: Contactos.jsx mostraba value raw 'ipro team' post-rebrand
//      mientras Cajas.jsx aplicaba pretty label 'Tecny Team'.
//   2. No extensible: cada tenant tenía las mismas 5 opciones fijas.
//
// Fix: nueva tabla contacto_tipos per-tenant con CRUD. Slug interno estable
// (referenciado por contactos.tipo). Nombre editable. Soft delete + activo.
// Los 5 defaults tienen `is_system=true` — owner puede renombrar/reordenar/
// desactivar pero no borrar completamente (garantiza que siempre haya al
// menos una lista base para el sistema).
//
// Rutas:
//   · GET    /             — listar tipos vivos (todos los users con contactos.ver)
//   · POST   /             — crear nuevo tipo (cap contactos.crear_borrar)
//   · PATCH  /:id          — editar nombre/orden/activo (cap contactos.crear_borrar)
//   · DELETE /:id          — soft delete + guarda contra is_system y contactos-en-uso
//
// RLS: db.withTenant() en TODAS las queries. Defense-in-depth vs cross-tenant.
const router = require('express').Router();
const db = require('../config/database');
const audit = require('../lib/audit');
const validate = require('../lib/validate');
const requireCapability = require('../middleware/requireCapability');
const {
  createContactoTipoSchema,
  updateContactoTipoSchema,
  slugify,
} = require('../schemas/contactoTipos');

// UUID v4/v7 regex — permisivo (acepta cualquier UUID válido, no solo v4).
// Los IDs de contacto_tipos vienen de gen_random_uuid() (v4 en PG 13+).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── GET / — listar tipos activos del tenant ──────────────────────────────
//
// Sin requireCapability adicional — cualquier user logueado del tenant puede
// leer (el mount monta requireCapability('contactos.ver') si aplica; ver
// app.js). Los dropdowns de Contactos/Cajas/ContactoPickerEmbedded lo
// consumen, y esos ya están gateados por sus propias caps.
//
// Response: array ordenado por (orden ASC, nombre ASC). Include is_system
// para que el frontend pueda deshabilitar el botón "Eliminar" cuando true.
// También include `id` UUID para operaciones PATCH/DELETE.
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, slug, nombre, orden, activo, is_system
           FROM contacto_tipos
          WHERE deleted_at IS NULL
          ORDER BY orden ASC NULLS LAST, nombre ASC`
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── POST / — crear tipo nuevo ────────────────────────────────────────────
//
// El slug se genera del nombre (lowercase + trim + colapso de espacios). Si
// ya existe (violación UNIQUE (tenant_id, slug) sobre rows vivos), 409.
//
// is_system default false — solo los 5 defaults del seed son system.
router.post('/', requireCapability('contactos.crear_borrar'), validate(createContactoTipoSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    const { nombre, orden } = req.body;
    const slug = slugify(nombre);

    // Chequeo previo para dar 409 con mensaje amigable (el UNIQUE lo cazaría
    // igual con 23505 pero el mensaje sería feo).
    const dup = await client.query(
      `SELECT id FROM contacto_tipos
        WHERE tenant_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [req.tenantId, slug]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ya existe un tipo con ese nombre' });
    }

    // Si no vino orden explícito, poner al final (max orden actual + 1).
    let ordenFinal = orden;
    if (ordenFinal === undefined || ordenFinal === null) {
      const { rows: maxRow } = await client.query(
        `SELECT COALESCE(MAX(orden), 0) + 1 AS next_orden
           FROM contacto_tipos WHERE deleted_at IS NULL`
      );
      ordenFinal = maxRow[0].next_orden;
    }

    const { rows } = await client.query(
      `INSERT INTO contacto_tipos (tenant_id, slug, nombre, orden, activo, is_system)
       VALUES ($1, $2, $3, $4, TRUE, FALSE)
       RETURNING id, slug, nombre, orden, activo, is_system`,
      [req.tenantId, slug, nombre.trim(), ordenFinal]
    );

    await audit(client, 'contacto_tipos', 'INSERT', rows[0].id, {
      despues: rows[0], user_id: req.user.id, req,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// ─── PATCH /:id — editar nombre/orden/activo ─────────────────────────────
//
// NO se puede editar el slug (rompería los contactos existentes). Si el owner
// quiere un slug distinto, tiene que crear un tipo nuevo y (fuera de scope)
// migrar los contactos manualmente.
//
// is_system NO se puede editar desde acá (no viene en el schema — implícito).
//
// Para is_system=true: se permite renombrar/reordenar/desactivar (el owner
// puede querer llamar "Compañeros" en vez de "Tecny Team" por ejemplo).
router.patch('/:id', requireCapability('contactos.crear_borrar'), validate(updateContactoTipoSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = req.params.id;
    if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    const { rows: before } = await client.query(
      `SELECT * FROM contacto_tipos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tipo no encontrado' });
    }

    const { nombre, orden, activo } = req.body;
    const { rows } = await client.query(
      `UPDATE contacto_tipos SET
         nombre     = COALESCE($1, nombre),
         orden      = COALESCE($2, orden),
         activo     = COALESCE($3, activo),
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, slug, nombre, orden, activo, is_system`,
      [nombre?.trim() ?? null, orden ?? null, activo ?? null, id]
    );

    await audit(client, 'contacto_tipos', 'UPDATE', id, {
      antes: before[0], despues: rows[0], user_id: req.user.id, req,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// ─── DELETE /:id — soft delete ────────────────────────────────────────────
//
// Guardas:
//   1. is_system=true → 403 con mensaje (los 5 defaults no se pueden borrar,
//      solo desactivar via PATCH activo=false).
//   2. Hay contactos vivos usando ese slug → 409 con count. El owner tiene
//      que migrarlos manualmente antes o desactivar el tipo (activo=false,
//      via PATCH) para ocultarlo del dropdown sin romper contactos.
//
// Soft delete via `deleted_at = NOW()` — preserva historial. El UNIQUE
// partial WHERE deleted_at IS NULL permite re-crear un slug que fue
// borrado.
router.delete('/:id', requireCapability('contactos.crear_borrar'), async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = req.params.id;
    if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    const { rows: before } = await client.query(
      `SELECT * FROM contacto_tipos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tipo no encontrado' });
    }

    if (before[0].is_system) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'No se puede eliminar un tipo del sistema. Podés desactivarlo para ocultarlo del dropdown.',
      });
    }

    // Guarda de "en uso": contar contactos activos con este slug.
    const { rows: usedRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM contactos
        WHERE tipo = $1 AND deleted_at IS NULL`,
      [before[0].slug]
    );
    const enUso = usedRows[0].n;
    if (enUso > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Este tipo está siendo usado por ${enUso} contacto(s). Reasignálos o desactivalo para ocultarlo del dropdown.`,
        contactos_en_uso: enUso,
      });
    }

    const { rows } = await client.query(
      `UPDATE contacto_tipos SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );

    await audit(client, 'contacto_tipos', 'DELETE', id, {
      antes: before[0], despues: rows[0], user_id: req.user.id, req,
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

module.exports = router;
