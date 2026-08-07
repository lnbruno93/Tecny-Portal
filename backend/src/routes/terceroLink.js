// routes/terceroLink.js — link pragmático cliente_cc ↔ proveedor (task #302).
//
// Endpoints:
//   · POST   /                         — crear link
//   · GET    /by-cliente/:cliente_cc_id — link + contraparte proveedor + saldo neto
//   · GET    /by-proveedor/:proveedor_id — link + contraparte cliente_cc + saldo neto
//   · DELETE /:id                       — soft delete
//
// Diseño:
//   · 1 link activo por cliente Y por proveedor (UNIQUE partial en DB).
//   · Saldo neto USD = saldo_cliente_cc - saldo_proveedor.
//     - saldo_cliente_cc > 0 = el cliente nos debe (positivo suma al neto)
//     - saldo_proveedor > 0 = le debemos al proveedor (positivo resta al neto)
//     - neto > 0 ⇒ el tercero nos debe en total. neto < 0 ⇒ le debemos.
//   · Se reusan las fórmulas canónicas `SALDO_CASE_M` de saldoCC.js y
//     saldoProveedor.js — misma fuente de verdad que la ficha CC y la
//     ficha proveedor (evita divergencia).
//
// RLS: todas las queries van via `db.withTenant(req.tenantId, ...)` —
// defense-in-depth contra cross-tenant. Además los INSERT/DELETE validan
// que los IDs referenciados pertenezcan al tenant (SELECT previo).
const router = require('express').Router();
const db = require('../config/database');
const audit = require('../lib/audit');
const validate = require('../lib/validate');
const parseId = require('../lib/parseId');
const logger = require('../lib/logger');
const { createTerceroLinkSchema } = require('../schemas/terceroLink');
const { SALDO_CASE_M: SALDO_CASE_M_CC } = require('../lib/saldoCC');
const { SALDO_CASE_M: SALDO_CASE_M_PROV } = require('../lib/saldoProveedor');

// ─── POST / — crear link ─────────────────────────────────────────────
//
// Valida:
//   1. cliente_cc_id existe en el tenant + no soft-deleted.
//   2. proveedor_id existe en el tenant + no soft-deleted.
//   3. No hay ya un link activo para ese cliente_cc_id (UNIQUE partial cubre
//      el race — chequeo previo solo para dar 409 amigable).
//   4. No hay ya un link activo para ese proveedor_id (idem).
//
// Errores:
//   · 400 — schema Zod.
//   · 404 — cliente_cc_id o proveedor_id inexistentes en el tenant.
//   · 409 — ya existe link activo para ese cliente O ese proveedor
//     (mensaje discrimina cuál).
//   · 201 — success, devuelve la row.
router.post('/', validate(createTerceroLinkSchema), async (req, res, next) => {
  const { cliente_cc_id, proveedor_id, notas } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // 1) Verificar cliente_cc pertenece al tenant + vivo.
    const cliRes = await client.query(
      `SELECT id, nombre, apellido FROM clientes_cc
        WHERE id = $1 AND deleted_at IS NULL`,
      [cliente_cc_id]
    );
    if (cliRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // 2) Verificar proveedor pertenece al tenant + vivo.
    const provRes = await client.query(
      `SELECT id, nombre FROM proveedores
        WHERE id = $1 AND deleted_at IS NULL`,
      [proveedor_id]
    );
    if (provRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    // 3) Chequeo previo de UNIQUE (para dar 409 con mensaje claro; el UNIQUE
    //    partial en DB es la garantía real y cubre el race entre check y
    //    INSERT).
    const dupCli = await client.query(
      `SELECT id FROM tercero_link
        WHERE cliente_cc_id = $1 AND deleted_at IS NULL`,
      [cliente_cc_id]
    );
    if (dupCli.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Este cliente ya está vinculado con un proveedor. Desvinculá primero para re-linkear.',
        conflict_on: 'cliente_cc_id',
      });
    }
    const dupProv = await client.query(
      `SELECT id FROM tercero_link
        WHERE proveedor_id = $1 AND deleted_at IS NULL`,
      [proveedor_id]
    );
    if (dupProv.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Este proveedor ya está vinculado con un cliente. Desvinculá primero para re-linkear.',
        conflict_on: 'proveedor_id',
      });
    }

    // 4) INSERT. tenant_id se pasa explícito — el policy RLS también lo
    //    fuerza pero preferimos el bind param para no depender del GUC en
    //    el WITH CHECK (defense-in-depth).
    const { rows } = await client.query(
      `INSERT INTO tercero_link (tenant_id, cliente_cc_id, proveedor_id, notas, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, cliente_cc_id, proveedor_id, notas, created_at, created_by`,
      [req.tenantId, cliente_cc_id, proveedor_id, notas ?? null, req.user?.id ?? null]
    );

    await audit(client, 'tercero_link', 'INSERT', rows[0].id, {
      despues: rows[0], user_id: req.user?.id, req,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 23505 = UNIQUE violation (race entre check y INSERT — rare pero posible
    // si 2 requests concurrentes). El chequeo previo cubre el caso normal;
    // acá capturamos el race con el mismo 409 amigable.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Ya existe un vínculo activo para este cliente o proveedor',
      });
    }
    logger.error({ err, cliente_cc_id, proveedor_id }, 'tercero_link create failed');
    next(err);
  } finally {
    client.release();
  }
});

// ─── GET /by-cliente/:cliente_cc_id ───────────────────────────────────
//
// Devuelve la ficha "link + contraparte + saldo neto" desde la perspectiva
// del cliente_cc. Estructura:
//   {
//     link: { id, cliente_cc_id, proveedor_id, notas, created_at } | null,
//     contraparte: { id, nombre, saldo_usd } | null,
//     saldo_cliente_usd: number,   // saldo del cliente base (siempre presente)
//     saldo_neto_usd: number,      // saldo_cliente - saldo_proveedor (si link)
//                                   // = saldo_cliente_usd si NO hay link
//   }
//
// Racional: la ficha del cliente en el frontend siempre necesita el saldo
// del cliente, entonces lo devolvemos con o sin link. `saldo_neto_usd` es
// la MISMA cifra que `saldo_cliente_usd` cuando no hay contraparte —
// facilita al frontend renderizar sin condicionales de precio.
router.get('/by-cliente/:cliente_cc_id', async (req, res, next) => {
  try {
    const cliId = parseId(req.params.cliente_cc_id);
    if (!cliId) return res.status(400).json({ error: 'cliente_cc_id inválido' });

    const data = await db.withTenant(req.tenantId, async (client) => {
      // Cliente base con su saldo canónico.
      const cliRes = await client.query(
        `SELECT c.id, c.nombre, c.apellido,
                COALESCE((
                  SELECT SUM(${SALDO_CASE_M_CC})
                    FROM movimientos_cc m
                   WHERE m.cliente_cc_id = c.id AND m.deleted_at IS NULL
                ), 0) AS saldo
           FROM clientes_cc c
          WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [cliId]
      );
      if (cliRes.rows.length === 0) return { notFound: true };
      const saldoCliente = Number(cliRes.rows[0].saldo) || 0;

      // Link activo (si hay).
      // 2026-08-07: `AND tenant_id = $2` defensivo. El RLS ya filtra en
      // prod (NOSUPERUSER FORCE RLS), pero en entornos de test que corren
      // como superuser (BYPASSRLS efectivo) NO aplica. Este predicate
      // cierra el gap y agrega defense-in-depth. Los tests de aislamiento
      // cross-tenant fallaban por esto.
      const linkRes = await client.query(
        `SELECT id, cliente_cc_id, proveedor_id, notas, created_at, created_by
           FROM tercero_link
          WHERE cliente_cc_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [cliId, req.tenantId]
      );
      const link = linkRes.rows[0] || null;

      if (!link) {
        return {
          link: null,
          contraparte: null,
          saldo_cliente_usd: saldoCliente,
          saldo_neto_usd: saldoCliente,
        };
      }

      // Con link: traer proveedor + saldo canónico.
      const provRes = await client.query(
        `SELECT p.id, p.nombre,
                COALESCE(SUM(${SALDO_CASE_M_PROV}), 0) AS saldo_usd
           FROM proveedores p
      LEFT JOIN proveedor_movimientos m
             ON m.proveedor_id = p.id AND m.deleted_at IS NULL
          WHERE p.id = $1 AND p.deleted_at IS NULL
          GROUP BY p.id`,
        [link.proveedor_id]
      );

      // Edge case: link presente pero proveedor soft-deleted (aunque el FK
      // es ON DELETE CASCADE, un soft-delete no borra la row). Devolvemos
      // contraparte=null y saldo_neto = saldo_cliente puro.
      if (provRes.rows.length === 0) {
        return {
          link,
          contraparte: null,
          saldo_cliente_usd: saldoCliente,
          saldo_neto_usd: saldoCliente,
        };
      }

      const saldoProv = Number(provRes.rows[0].saldo_usd) || 0;
      return {
        link,
        contraparte: {
          id: provRes.rows[0].id,
          nombre: provRes.rows[0].nombre,
          saldo_usd: saldoProv,
        },
        saldo_cliente_usd: saldoCliente,
        saldo_neto_usd: saldoCliente - saldoProv,
      };
    });

    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(data);
  } catch (err) { next(err); }
});

// ─── GET /by-proveedor/:proveedor_id ──────────────────────────────────
//
// Simétrico al anterior — desde la perspectiva del proveedor. Ver comment
// del by-cliente. Estructura:
//   {
//     link: {...} | null,
//     contraparte: { id, nombre, apellido, saldo_cc } | null,
//     saldo_proveedor_usd: number,
//     saldo_neto_usd: number,   // saldo_cliente - saldo_proveedor
//                                // = -saldo_proveedor si NO hay link
//   }
//
// Nota sobre el signo: mantenemos la convención "positivo = a favor
// nuestro" en `saldo_neto_usd` (mismo signo que en by-cliente). Sin link,
// como solo tenemos deuda hacia el proveedor, el neto es negativo (le
// debemos).
router.get('/by-proveedor/:proveedor_id', async (req, res, next) => {
  try {
    const provId = parseId(req.params.proveedor_id);
    if (!provId) return res.status(400).json({ error: 'proveedor_id inválido' });

    const data = await db.withTenant(req.tenantId, async (client) => {
      // Proveedor base con su saldo canónico.
      const provRes = await client.query(
        `SELECT p.id, p.nombre,
                COALESCE(SUM(${SALDO_CASE_M_PROV}), 0) AS saldo_usd
           FROM proveedores p
      LEFT JOIN proveedor_movimientos m
             ON m.proveedor_id = p.id AND m.deleted_at IS NULL
          WHERE p.id = $1 AND p.deleted_at IS NULL
          GROUP BY p.id`,
        [provId]
      );
      if (provRes.rows.length === 0) return { notFound: true };
      const saldoProv = Number(provRes.rows[0].saldo_usd) || 0;

      // Ver comment del by-cliente sobre `AND tenant_id = $2` defensivo.
      const linkRes = await client.query(
        `SELECT id, cliente_cc_id, proveedor_id, notas, created_at, created_by
           FROM tercero_link
          WHERE proveedor_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [provId, req.tenantId]
      );
      const link = linkRes.rows[0] || null;

      if (!link) {
        return {
          link: null,
          contraparte: null,
          saldo_proveedor_usd: saldoProv,
          saldo_neto_usd: -saldoProv,
        };
      }

      const cliRes = await client.query(
        `SELECT c.id, c.nombre, c.apellido,
                COALESCE((
                  SELECT SUM(${SALDO_CASE_M_CC})
                    FROM movimientos_cc m
                   WHERE m.cliente_cc_id = c.id AND m.deleted_at IS NULL
                ), 0) AS saldo
           FROM clientes_cc c
          WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [link.cliente_cc_id]
      );

      if (cliRes.rows.length === 0) {
        return {
          link,
          contraparte: null,
          saldo_proveedor_usd: saldoProv,
          saldo_neto_usd: -saldoProv,
        };
      }

      const saldoCliente = Number(cliRes.rows[0].saldo) || 0;
      return {
        link,
        contraparte: {
          id: cliRes.rows[0].id,
          nombre: cliRes.rows[0].nombre,
          apellido: cliRes.rows[0].apellido,
          saldo_cc: saldoCliente,
        },
        saldo_proveedor_usd: saldoProv,
        saldo_neto_usd: saldoCliente - saldoProv,
      };
    });

    if (data.notFound) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(data);
  } catch (err) { next(err); }
});

// ─── DELETE /:id — soft delete ─────────────────────────────────────────
//
// Marca deleted_at = NOW(). El UNIQUE partial (`WHERE deleted_at IS NULL`)
// permite crear un link nuevo sobre el mismo cliente/proveedor tras la
// desvinculación (flow "desvincular y re-linkear con otro").
router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // 2026-08-07: `AND tenant_id = $2` defensivo — ver comment de by-cliente.
    const { rows: before } = await client.query(
      `SELECT * FROM tercero_link
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [id, req.tenantId]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vínculo no encontrado' });
    }

    const { rows } = await client.query(
      `UPDATE tercero_link SET deleted_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, cliente_cc_id, proveedor_id, deleted_at`,
      [id, req.tenantId]
    );

    await audit(client, 'tercero_link', 'DELETE', id, {
      antes: before[0], despues: rows[0], user_id: req.user?.id, req,
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err, id: req.params.id }, 'tercero_link delete failed');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
