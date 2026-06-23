/**
 * Rutas del módulo Cuentas Corrientes (CC)
 *
 * Clientes:
 *   GET    /clientes            — lista con saldo calculado
 *   GET    /clientes/:id        — detalle + saldo
 *   POST   /clientes            — crear
 *   PUT    /clientes/:id        — actualizar
 *   DELETE /clientes/:id        — soft delete
 *
 * Movimientos:
 *   GET    /clientes/:id/movimientos  — historial de un cliente (con items)
 *   POST   /movimientos               — crear movimiento (+ items para compra/devolucion)
 *   DELETE /movimientos/:id           — soft delete (items se eliminan en cascada)
 *
 * Saldo = SUM(compra) - SUM(pago + devolucion + parte_de_pago + entrega_mercaderia)
 * Saldo positivo → el cliente nos debe dinero.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router  = require('express').Router();
const db      = require('../config/database');
const validate  = require('../lib/validate');
const audit     = require('../lib/audit');
const parseId   = require('../lib/parseId');
const { toUsd, round2 } = require('../lib/money');

// Rate-limit específico para cobranza masiva: 10 req / 15 min por user.
// Cada lote puede ser de hasta 100 cobranzas → write-heavy y mantiene
// locks de cajas un tiempo. Bloquea DoS interno (auditoría #H-07).
const cobranzaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id != null
    ? `cobranza-masiva:${req.user.id}`
    : `cobranza-masiva:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas cobranzas masivas. Probá de nuevo en unos minutos.' },
  // #T-1: en tests skipeamos el rate-limit. La suite hace >10 requests al
  // endpoint para cubrir todos los error paths (cliente inválido, caja
  // inválida, schema, rollbacks). Mismo patrón que el helmet+rateLimit
  // global en app.js:205.
  skip: () => process.env.NODE_ENV === 'test',
});
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  updateEstadoMovimientoCCSchema,
  cobranzaMasivaSchema,
} = require('../schemas/cuentas');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { invalidateMetricas } = require('../lib/inventarioCache');
const { cancelMovimientoCC } = require('../lib/cancelMovimientoCC');
const { syncContactoSafe } = require('../lib/contactosSync');

// Expresión CASE compartida para calcular el aporte de cada movimiento al saldo.
//
// Regla (mayo-2026, paralelo a Proveedores): una 'compra' con caja_id es
// contado (entró el dinero al instante) y NO suma deuda. Sin caja_id queda
// como deuda del cliente (el caso clásico de venta a CC).
//
// 2026-06-11 S-03: promovido a `src/lib/saldoCC.js` para que el dashboard
// mensual (y futuras pantallas) usen la MISMA fórmula que el listado de
// clientes y el detalle. Antes el dashboard tenía su propia copia con regla
// distinta → cifras de deuda CC inconsistentes entre módulos.
const { SALDO_CASE, SALDO_CASE_M } = require('../lib/saldoCC');

// Helper: SQL para calcular saldo de un cliente (subquery reutilizable — usada solo en GET /:id)
// Para el listado usamos un JOIN en lugar de subquery correlacionada (ver abajo).
const SALDO_SQL = `
  COALESCE((
    SELECT SUM(${SALDO_CASE})
    FROM movimientos_cc
    WHERE cliente_cc_id = c.id AND deleted_at IS NULL
  ), 0)
`;

// ─── CLIENTES ────────────────────────────────────────────────────────────────

// #P-05 endpoint dedicado para autocomplete del picker — devuelve pocos
// clientes que matchean el query string (nombre/apellido), opcionalmente
// solo deudores. Mucho más rápido que cargar 500 clientes al abrir el modal
// y filtrar client-side (no escala a 2k+ clientes).
router.get('/clientes/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const conSaldo = req.query.con_saldo === 'true';
    if (q.length < 2) return res.json({ data: [] });
    const params = [`%${q}%`];
    let extraSaldo = '';
    if (conSaldo) {
      // Subquery del saldo aplicada como having: solo con deuda > 0.
      extraSaldo = ` AND COALESCE(s.saldo, 0) > 0`;
    }
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.nombre, c.apellido, c.categoria, COALESCE(s.saldo, 0) AS saldo
           FROM clientes_cc c
           LEFT JOIN (
             SELECT cliente_cc_id, SUM(${SALDO_CASE_M.replace(/m\./g, '')}) AS saldo
               FROM movimientos_cc m
              WHERE deleted_at IS NULL
              GROUP BY cliente_cc_id
           ) s ON s.cliente_cc_id = c.id
          WHERE c.deleted_at IS NULL
            AND (c.nombre ILIKE $1 OR c.apellido ILIKE $1)
            ${extraSaldo}
          ORDER BY c.nombre, c.apellido
          LIMIT 15`,
        params
      );
      return rows;
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get('/clientes', async (req, res, next) => {
  try {
    const { buscar, categoria } = req.query;
    const params  = [];
    const filters = ['c.deleted_at IS NULL'];

    if (buscar) {
      params.push(`%${buscar}%`);
      filters.push(`(c.nombre ILIKE $${params.length} OR c.apellido ILIKE $${params.length} OR c.contacto ILIKE $${params.length})`);
    }
    if (categoria) {
      params.push(categoria);
      filters.push(`c.categoria = $${params.length}`);
    }

    const where = filters.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    // JOIN en lugar de subquery correlacionada — calcula todos los saldos en un solo pase
    // antes: 1 + N queries (una por cliente). Ahora: siempre 1 query total.
    //
    // 2026-06-15 multi-tenant (PR 4.3): count + data en una sola withTenant
    // → comparten el SET LOCAL. RLS filtra clientes_cc y movimientos_cc.
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const [countRes, dataRes] = await Promise.all([
        client.query(`SELECT COUNT(*) FROM clientes_cc c WHERE ${where}`, params),
        client.query(
          `SELECT c.*,
                  COALESCE(s.saldo, 0) AS saldo
           FROM clientes_cc c
           LEFT JOIN (
             SELECT cliente_cc_id,
                    SUM(
                      CASE
                        WHEN tipo = 'saldo_inicial'                  THEN  monto_total
                        WHEN tipo = 'compra' AND caja_id IS NOT NULL THEN  0
                        WHEN tipo = 'compra'                         THEN  monto_total
                        ELSE -monto_total
                      END
                    ) AS saldo
             FROM movimientos_cc
             WHERE deleted_at IS NULL
             GROUP BY cliente_cc_id
           ) s ON s.cliente_cc_id = c.id
           WHERE ${where}
           ORDER BY c.nombre, c.apellido
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.get('/clientes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.*, ${SALDO_SQL} AS saldo
         FROM clientes_cc c
         WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [id]
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/clientes', validate(createClienteCCSchema), async (req, res, next) => {
  const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, saldo_inicial } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows } = await client.query(
      `INSERT INTO clientes_cc
         (nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [nombre, apellido ?? null, contacto ?? null, marca_redes ?? null,
       provincia ?? null, localidad ?? null, direccion ?? null, categoria, notas ?? null]
    );
    const cliente = rows[0];

    // Saldo de apertura: movimiento 'saldo_inicial' (suma como compra → el cliente nos debe)
    const saldo = Number(saldo_inicial) || 0;
    if (saldo > 0) {
      await client.query(
        `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, descripcion, monto_total)
         VALUES ($1, CURRENT_DATE, 'saldo_inicial', 'Saldo inicial', $2)`,
        [cliente.id, saldo]
      );
    }
    await audit(client, 'clientes_cc', 'INSERT', cliente.id, { despues: { ...cliente, saldo_inicial: saldo }, user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la tx principal).
    // 2026-06-15 multi-tenant: dentro de withTenant para que el INSERT en
    // contactos respete el tenant_id correcto (la lib lee app.current_tenant).
    await db.withTenant(req.tenantId, async (c) => syncContactoSafe(c, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: cliente.id,
      nombre: cliente.nombre, apellido: cliente.apellido, telefono: cliente.contacto,
    }));
    res.status(201).json({ ...cliente, saldo });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/clientes/:id', validate(updateClienteCCSchema), async (req, res, next) => {
  // #H-09: envolver UPDATE + audit en una TX para que si el audit falla el
  // UPDATE haga rollback (antes el audit corría fuera con db, dejando
  // updates sin rastro auditable).
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    // 2026-06-10 P-15: el finally release ya cubre — el doble-release tiraba
    // warning de node-pg y podía botar la conexión.
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Cliente no encontrado' }); }

    const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas } = req.body;
    const { rows } = await client.query(
      `UPDATE clientes_cc SET
         nombre      = COALESCE($1,  nombre),
         apellido    = COALESCE($2,  apellido),
         contacto    = COALESCE($3,  contacto),
         marca_redes = COALESCE($4,  marca_redes),
         provincia   = COALESCE($5,  provincia),
         localidad   = COALESCE($6,  localidad),
         direccion   = COALESCE($7,  direccion),
         categoria   = COALESCE($8,  categoria),
         notas       = COALESCE($9,  notas)
       WHERE id = $10 RETURNING *`,
      [nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, id]
    );
    await audit(client, 'clientes_cc', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la TX principal).
    // 2026-06-15 multi-tenant: ver comentario en POST /clientes.
    await db.withTenant(req.tenantId, async (c) => syncContactoSafe(c, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: rows[0].id,
      nombre: rows[0].nombre, apellido: rows[0].apellido, telefono: rows[0].contacto,
    }));
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ─── GET /clientes/:id/delete-preview ───────────────────────────────────────
// Devuelve el "diff" de lo que va a pasar si el operador borra este cliente:
//   - cantidad de movimientos vivos que serán cancelados
//   - productos a restaurar al stock (sumando cantidades por flow B2B)
//   - total a revertir en caja_movimientos (USD)
// Lo usa el frontend para mostrar un confirm con números concretos. Antes la
// UI solo mostraba "se borrará el cliente; su histórico queda guardado", lo
// cual era engañoso — Lucas borró iConnect el 2026-06-09 esperando que el
// stock volviera, y los 7 movs huérfanos quedaron afectando inventario y caja
// invisiblemente. No invocable si el cliente ya está borrado.
router.get('/clientes/:id/delete-preview', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // 2026-06-15 multi-tenant (PR 4.3): cliente lookup + 3 agregaciones en una
    // sola withTenant. RLS filtra clientes_cc, movimientos_cc, caja_movimientos
    // y items_movimiento_cc.
    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: cli } = await client.query(
        'SELECT id, nombre, apellido FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      if (!cli[0]) return { notFound: true };

      const [{ rows: movsAgg }, { rows: cajaAgg }, { rows: itemsAgg }] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS n,
                  COALESCE(SUM(CASE WHEN tipo IN ('compra','entrega_mercaderia') THEN monto_total ELSE 0 END), 0) AS deuda_a_revertir
             FROM movimientos_cc
            WHERE cliente_cc_id = $1 AND deleted_at IS NULL`,
          [id]
        ),
        client.query(
          `SELECT COALESCE(SUM(cm.monto), 0)::numeric AS total
             FROM caja_movimientos cm
             JOIN movimientos_cc m ON m.id = cm.ref_id
            WHERE cm.ref_tabla = 'movimientos_cc'
              AND cm.deleted_at IS NULL
              AND m.cliente_cc_id = $1 AND m.deleted_at IS NULL`,
          [id]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n
             FROM items_movimiento_cc i
             JOIN movimientos_cc m ON m.id = i.movimiento_cc_id
            WHERE m.cliente_cc_id = $1 AND m.deleted_at IS NULL
              AND i.producto_id IS NOT NULL
              AND m.tipo IN ('compra','entrega_mercaderia','devolucion')`,
          [id]
        ),
      ]);
      return {
        cliente: cli[0],
        movimientos_a_cancelar: movsAgg[0].n,
        caja_a_revertir_usd: Number(cajaAgg[0].total) || 0,
        productos_a_restaurar: itemsAgg[0].n,
      };
    });
    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/clientes/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  // 2026-06-09: cascada. Antes el DELETE solo soft-deleteaba la fila de
  // clientes_cc, dejando movimientos_cc huérfanos (vivos en DB, invisibles en
  // listados, afectando stock y caja). Hoy en la misma TX: cancela todos los
  // movimientos vivos del cliente (revierte caja + restaura stock + audit
  // con _origen='cliente_cascade') y después soft-deletea el cliente.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // 1. Lockear cliente.
    const { rows: cliRows } = await client.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!cliRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // 2. Listar movimientos vivos a cancelar (ordenado por id para evitar deadlock
    //    si dos requests intentan borrar clientes con movs solapados — ej. el
    //    cleanup admin de huérfanos corriendo al mismo tiempo).
    const { rows: movs } = await client.query(
      `SELECT id FROM movimientos_cc
         WHERE cliente_cc_id = $1 AND deleted_at IS NULL
         ORDER BY id`,
      [id]
    );

    // 3. Cancelar cada uno con el helper compartido. Si alguno falla (#B-06 de
    //    devolución revendida), el throw rompe el loop y el catch hace ROLLBACK
    //    de TODO — el cliente NO queda borrado a medias.
    let productosRestaurados = 0;
    for (const m of movs) {
      const r = await cancelMovimientoCC(client, {
        movimientoId: m.id,
        userId: req.user.id,
        origen: 'cliente_cascade',
      });
      productosRestaurados += r.productos_restaurados;
    }

    // 4. Soft-delete del cliente.
    await client.query(
      'UPDATE clientes_cc SET deleted_at = NOW() WHERE id = $1',
      [id]
    );
    await audit(client, 'clientes_cc', 'DELETE', id, {
      antes: cliRows[0],
      user_id: req.user.id,
      _cascade: {
        movimientos_cancelados: movs.length,
        productos_restaurados: productosRestaurados,
      },
    });

    await client.query('COMMIT');
    if (productosRestaurados > 0) invalidateMetricas(req.tenantId);
    res.json({
      ok: true,
      cascade: {
        movimientos_cancelados: movs.length,
        productos_restaurados: productosRestaurados,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ─── MOVIMIENTOS ─────────────────────────────────────────────────────────────

router.get('/clientes/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    // 2026-06-15 multi-tenant (PR 4.3): cliente lookup + count + page + items en
    // una sola withTenant. Comparten SET LOCAL para que RLS filtre todas las
    // tablas por el mismo tenant.
    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: c } = await client.query(
        'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      if (!c[0]) return { notFound: true };

      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM movimientos_cc WHERE cliente_cc_id = $1 AND deleted_at IS NULL', [id]
      );
      const { rows: movs } = await client.query(
        `SELECT * FROM movimientos_cc
         WHERE cliente_cc_id = $1 AND deleted_at IS NULL
         ORDER BY fecha DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );

      // Items de todos los movimientos, traídos en una sola query
      const movIds = movs.map(m => m.id);
      let items = [];
      if (movIds.length) {
        const { rows } = await client.query(
          `SELECT * FROM items_movimiento_cc
           WHERE movimiento_cc_id = ANY($1)
           ORDER BY id`,
          [movIds]
        );
        items = rows;
      }

      // Adjuntar items a cada movimiento
      const itemsByMov = {};
      items.forEach(item => {
        if (!itemsByMov[item.movimiento_cc_id]) itemsByMov[item.movimiento_cc_id] = [];
        itemsByMov[item.movimiento_cc_id].push(item);
      });

      const result = movs.map(m => ({ ...m, items: itemsByMov[m.id] || [] }));
      return { result, count: parseInt(countRows[0].count) };
    });
    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(paginatedResponse(data.result, data.count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/movimientos', validate(createMovimientoCCSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      cliente_cc_id, fecha, tipo, descripcion, monto_total, notas,
      caja_id, items = [],
      // 2026-06-10: estado por defecto 'acreditado' para venta B2B.
      // El schema ya lo defaulta — destructuring igual por consistencia.
      estado = 'acreditado',
    } = req.body;

    // #H-05 cross-module: si la venta/devolución toca stock de inventario
    // (producto_id en algún item), exigir también permiso `inventario`.
    const tocaStock = ['compra', 'devolucion', 'entrega_mercaderia'].includes(tipo)
      && items.some(it => it.producto_id);
    if (tocaStock) {
      // 2026-06-23 F4: cutover a requireCapability. hasCapability mantiene
      // la misma semántica para checks cross-módulo inline.
      const { hasCapability } = require('../middleware/requireCapability');
      const ok = await hasCapability(req.user, 'inventario.ver');
      if (!ok) {
        return res.status(403).json({
          error: 'Para registrar un movimiento que descuenta stock necesitás también permiso de Inventario.',
        });
      }
    }

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Verificar que el cliente existe (dentro de la tx, con FOR UPDATE para evitar race condition)
    const { rows: c } = await client.query(
      'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cliente_cc_id]
    );
    if (!c[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Insertar movimiento (con auditoría de creador para #B-07).
    // estado: solo aplica visualmente a tipo='compra' (venta B2B). El default
    // 'acreditado' del schema cubre todos los demás (pago, devolución, etc.).
    const { rows: movRows } = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, notas, caja_id, created_by_user_id, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [cliente_cc_id, fecha, tipo, descripcion ?? null, monto_total, notas ?? null, caja_id ?? null, req.user.id, estado]
    );
    const mov = movRows[0];

    // Flujo "sale stock, entra dinero" (analogía inversa a Proveedores):
    //   - tipo 'compra' del cliente B2B (= venta nuestra a ese cliente):
    //       · con caja_id → ingreso al instante en esa caja (contado, no suma deuda)
    //       · sin caja_id → queda como deuda del cliente
    //   - tipo 'pago' / 'parte_de_pago' → siempre ingreso a la caja indicada
    //   - tipo 'devolucion' → reverso de venta, NO mueve caja en esta versión
    //     (la devolución cae en CC del cliente como menos deuda)
    if (caja_id && ['pago', 'parte_de_pago', 'compra'].includes(tipo)) {
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso', monto: monto_total, moneda: 'USD', tc: null,
        origen: 'b2b', ref_tabla: 'movimientos_cc', ref_id: mov.id,
        concepto: tipo === 'compra' ? `Venta B2B (contado) cliente #${cliente_cc_id}` : `Pago B2B #${cliente_cc_id}`,
        user_id: req.user.id,
      });
    }

    // Insertar items y, si tienen `producto_id`, validar stock y descontar.
    //   - compra / entrega_mercaderia → salida de stock (descuenta cantidad).
    //   - devolucion → entrada de stock (suma cantidad).
    //
    // #P-02 bulkificado: antes era loop con N SELECT FOR UPDATE + N INSERT
    // items + N UPDATE productos = ~3N round-trips. Ahora: 1 SELECT batch
    // ordenado + 1 INSERT bulk + 1 UPDATE bulk = 3 RTT total.
    let insertedItems = [];
    const tiposConItems = ['compra', 'devolucion', 'entrega_mercaderia'];
    if (tiposConItems.includes(tipo) && items.length > 0) {
      const esSalida = tipo === 'compra' || tipo === 'entrega_mercaderia';

      // Items con producto_id (ordenados por id ASC para evitar deadlock,
      // #H-01) vs items sin (texto libre, no tocan stock).
      const itemsConProd = items
        .filter(it => it.producto_id)
        .sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
      const prodIds = itemsConProd.map(it => Number(it.producto_id));

      // Detección temprana de producto_id duplicados ANTES de tocar nada.
      // Antes, el bulk UPDATE con UNNEST devolvía rowCount=1 cuando había 2
      // items con el mismo producto_id (PG dedupea) y caíamos a un 500 opaco
      // "Inconsistencia al actualizar stock" que confundía al operador.
      // Ahora devolvemos 409 con la lista exacta de IDs duplicados.
      const dupIds = [];
      const seenIds = new Set();
      for (const pid of prodIds) {
        if (seenIds.has(pid)) dupIds.push(pid);
        else seenIds.add(pid);
      }
      if (dupIds.length > 0) {
        await client.query('ROLLBACK');
        // Resolver nombres/IMEIs para que el frontend muestre algo útil.
        // 2026-06-15 multi-tenant: post-ROLLBACK la tx terminó → SET LOCAL ya no
        // aplica. Usamos withTenant separado para que RLS filtre por el tenant
        // del request (en vez de db.query que correría sin contexto y leería
        // todos los tenants en role super, o nada en role no-super).
        const dupRows = await db.withTenant(req.tenantId, async (c) => {
          const r = await c.query(
            `SELECT id, nombre, imei FROM productos
               WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
            [[...new Set(dupIds)]]
          );
          return r.rows;
        });
        return res.status(409).json({
          error: 'Hay productos repetidos en la venta — no se puede vender el mismo unitario dos veces',
          duplicados: dupRows.map(p => ({ id: p.id, nombre: p.nombre, imei: p.imei })),
        });
      }

      // 1) Batch SELECT de productos para (a) validar existencia con error
      //    user-friendly (Producto #X no existe), y (b) snapshot de costo
      //    congelado en items_movimiento_cc (junio 2026 — desglose B2B).
      //
      //    P-13 (auditoría 2026-06-10): se eliminó el FOR UPDATE. Antes
      //    tomábamos row locks aquí + en el UPDATE posterior, lo que
      //    serializaba ventas concurrentes que tocaban el mismo producto
      //    (caso típico B2B: cliente A y cliente B compran al mismo SKU).
      //    Ahora la atomicidad la garantiza el UPDATE condicional (paso 3),
      //    que rechaza la venta si otro thread ya consumió el stock en el
      //    intervalo entre SELECT y UPDATE. El pre-check de stock que sigue
      //    es para devolver un 409 con mensaje amistoso en el caso común
      //    (sin contención); el UPDATE es el guard real ante la race.
      let prodMap = new Map();
      if (prodIds.length > 0) {
        const { rows: prodRows } = await client.query(
          `SELECT id, nombre, cantidad, estado, costo, costo_moneda FROM productos
             WHERE id = ANY($1::int[]) AND deleted_at IS NULL
             ORDER BY id`,
          [prodIds]
        );
        prodMap = new Map(prodRows.map(p => [Number(p.id), p]));

        // Validación: existencia + stock suficiente (best-effort pre-check).
        // El UPDATE condicional al final es el verdadero guard transaccional.
        for (const item of itemsConProd) {
          const p = prodMap.get(Number(item.producto_id));
          if (!p) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Producto #${item.producto_id} no existe` });
          }
          if (esSalida && Number(p.cantidad) < Number(item.cantidad || 1)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Stock insuficiente para "${p.nombre}": disponible ${p.cantidad}, pedido ${item.cantidad}`,
              producto_id: item.producto_id,
            });
          }
        }
      }

      // 2) Bulk INSERT de los items en una sola query con UNNEST.
      //    costo_unit + costo_moneda: snapshot congelado del producto al
      //    momento de la venta. Items sin producto_id (texto libre) → NULL.
      //    Ventas históricas pre-migración → NULL también.
      const costoSnap = (it) => {
        if (!it.producto_id) return { unit: null, moneda: null };
        const p = prodMap.get(Number(it.producto_id));
        if (!p) return { unit: null, moneda: null };
        return { unit: Number(p.costo) || 0, moneda: p.costo_moneda || 'USD' };
      };
      const itemRes = await client.query(
        `INSERT INTO items_movimiento_cc
           (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas, producto_id, cantidad, costo_unit, costo_moneda)
         SELECT $1, p, m, t, c, i, v, vf, n, pid, cant, cu, cm
           FROM UNNEST(
             $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
             $7::numeric[], $8::boolean[], $9::text[], $10::int[], $11::int[],
             $12::numeric[], $13::text[]
           ) AS u(p, m, t, c, i, v, vf, n, pid, cant, cu, cm)
         RETURNING *`,
        [
          mov.id,
          items.map(it => it.producto ?? null),
          items.map(it => it.modelo ?? null),
          items.map(it => it.tamano ?? null),
          items.map(it => it.color ?? null),
          items.map(it => it.imei_serial ?? null),
          items.map(it => it.valor ?? null),
          items.map(it => it.verificado ?? false),
          items.map(it => it.notas ?? null),
          items.map(it => it.producto_id ?? null),
          items.map(it => Number(it.cantidad || 1)),
          items.map(it => costoSnap(it).unit),
          items.map(it => costoSnap(it).moneda),
        ]
      );
      insertedItems = itemRes.rows;

      // 3) Bulk UPDATE del stock con un solo round-trip. Usa FROM UNNEST + JOIN.
      //    P-13 (auditoría 2026-06-10): para ventas (esSalida=true) la cláusula
      //    WHERE incluye `p.cantidad >= u.cant`. Si otra venta concurrente ya
      //    drenó el stock entre nuestro SELECT y este UPDATE, la fila NO se
      //    actualiza → rowCount queda corto y devolvemos 409 con info. Esto
      //    es lo que reemplaza al SELECT FOR UPDATE: la atomicidad del UPDATE
      //    PostgreSQL serializa por fila a este nivel sin row lock previo.
      //    Para devoluciones (esSalida=false) no hay guard de stock — siempre
      //    se puede sumar.
      if (itemsConProd.length > 0) {
        const sign = esSalida ? '-' : '+';
        const stockGuard = esSalida ? 'AND p.cantidad >= u.cant' : '';
        // arrays paralelos para FROM UNNEST
        const updateRes = await client.query(
          `UPDATE productos p SET
             cantidad = p.cantidad ${sign} u.cant,
             estado = CASE
               WHEN p.cantidad ${sign} u.cant <= 0 THEN 'vendido'
               WHEN p.cantidad ${sign} u.cant > 0 AND p.estado = 'vendido' THEN 'disponible'
               ELSE p.estado
             END
           FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
           WHERE p.id = u.pid ${stockGuard}`,
          [
            itemsConProd.map(it => Number(it.producto_id)),
            itemsConProd.map(it => Number(it.cantidad || 1)),
          ]
        );
        // Sanity check: deberíamos haber afectado N filas únicas. Si no:
        //   · esSalida=true: race condition — otra venta concurrente drenó
        //     stock entre SELECT y este UPDATE. Devolvemos 409 (no 500),
        //     pidiendo reintentar. El frontend muestra "Stock insuficiente
        //     por concurrencia, reintentá".
        //   · esSalida=false: solo puede pasar si un producto se soft-deletó
        //     entre SELECT y UPDATE (race extrema). 500 sigue siendo correcto.
        // Los duplicados de producto_id ya fueron filtrados arriba.
        if (updateRes.rowCount !== itemsConProd.length) {
          await client.query('ROLLBACK');
          if (esSalida) {
            return res.status(409).json({
              error: 'Stock insuficiente por concurrencia — otra venta consumió el stock al mismo tiempo. Reintentá.',
              esperado: itemsConProd.length,
              afectado: updateRes.rowCount,
            });
          }
          return res.status(500).json({
            error: 'No se pudo actualizar el stock de todos los productos. Reintentá; si persiste, contactá soporte.',
            esperado: itemsConProd.length,
            afectado: updateRes.rowCount,
          });
        }
      }
    }

    await audit(client, 'movimientos_cc', 'INSERT', mov.id, {
      despues: { ...mov, items: insertedItems },
      user_id: req.user.id,
    });
    await client.query('COMMIT');
    // Venta B2B descontó stock — invalidar el cache de métricas para que el
    // dashboard de Inventario refleje el nuevo total en el próximo refresh.
    if (insertedItems.length > 0) invalidateMetricas(req.tenantId);

    res.status(201).json({ ...mov, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /movimientos/:id/estado — toggle acreditado/pendiente (2026-06-10).
// El selector del frontend en la grilla unificada de Ventas dispara esto.
// Solo aplica a movs vivos. Ownership: cualquiera con permiso `cuentas` puede
// cambiarlo (no hay check #B-07 acá — es solo un flag visual, no toca
// inventario ni caja).
router.patch('/movimientos/:id/estado', validate(updateEstadoMovimientoCCSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { estado } = req.body;

    // 2026-06-15 multi-tenant (PR 4.3): SELECT + UPDATE + audit en una sola
    // withTenant. Antes el audit corría con el pool global (sin contexto de
    // tenant) — ahora corre dentro de la tx con SET LOCAL, así el audit_log
    // se escribe con el tenant correcto.
    const result = await db.withTenant(req.tenantId, async (client) => {
      const { rows: pre } = await client.query(
        'SELECT estado FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      if (!pre[0]) return { notFound: true };
      if (pre[0].estado === estado) return { sinCambios: true };

      const { rows } = await client.query(
        `UPDATE movimientos_cc SET estado = $1 WHERE id = $2 RETURNING *`,
        [estado, id]
      );
      await audit(client, 'movimientos_cc', 'UPDATE', id, {
        antes: { estado: pre[0].estado },
        despues: { estado: rows[0].estado },
        user_id: req.user.id,
        _origen: 'cambio_estado',
      });
      return { row: rows[0] };
    });
    if (result.notFound) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (result.sinCambios) return res.json({ ok: true, estado, sin_cambios: true });
    res.json({ ok: true, estado: result.row.estado });
  } catch (err) { next(err); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    // Ownership check (auditoría #B-07): un user con permiso `cuentas` solo
    // puede borrar movimientos que él mismo creó. Los admins pueden borrar
    // cualquiera. Movimientos legacy (created_by_user_id IS NULL, anteriores
    // al deploy de la migración 013) solo los borra admin.
    const { rows: pre } = await client.query(
      'SELECT id, created_by_user_id FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!pre[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    const isOwner = pre[0].created_by_user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No tenés permiso para borrar este movimiento (lo creó otro usuario).' });
    }
    // Helper compartido: soft-delete + revertir caja + restaurar stock + audit.
    // Mismo flow que DELETE /clientes/:id (cascada) y POST /admin/orphan-movs
    // (cleanup huérfanos). Lanza errors con .status que mapeamos a HTTP.
    await cancelMovimientoCC(client, {
      movimientoId: id,
      userId: req.user.id,
      origen: 'manual',
    });
    await client.query('COMMIT');
    // DELETE de venta B2B repuso stock — invalidar cache para que el dashboard
    // refleje el nuevo total inmediatamente.
    invalidateMetricas(req.tenantId);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message, producto_id: err.producto_id });
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /movimientos/:movId/items/:itemId/devolver ────────────────────────
//
// Devolución inline de UN item de una venta B2B. Junio 2026 — Lucas pidió
// poder devolver un producto individual sin tener que cargar un movimiento
// nuevo manual. UX: el item queda visible en el desglose original con
// tachado + badge "Devuelto"; en paralelo se crea un movimiento_cc tipo
// 'devolucion' nuevo para mantener la trazabilidad contable + la lógica
// existente de saldo/caja (el saldo del cliente baja porque la devolución
// le da crédito).
//
// Idempotente: si el item ya fue devuelto (devuelto_at IS NOT NULL), tira 409.
// Atómico: si falla cualquier paso, rollback total.
//
// Pre-condiciones:
//   · movimiento_cc vivo (no soft-deleted) y tipo='compra' (no se devuelve
//     una devolución ni un pago).
//   · item del movimiento existe.
//   · item.producto_id NO NULL (sin producto_id no podemos restaurar stock —
//     items legacy de texto libre no se pueden devolver por este flow).
router.post('/movimientos/:movId/items/:itemId/devolver', async (req, res, next) => {
  const movId  = parseId(req.params.movId);
  const itemId = parseId(req.params.itemId);
  if (!movId || !itemId) return res.status(400).json({ error: 'IDs inválidos' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // 1. Lock del movimiento padre + validación.
    const { rows: movs } = await client.query(
      'SELECT * FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [movId]
    );
    if (!movs[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    const movOrig = movs[0];
    if (movOrig.tipo !== 'compra') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Solo se pueden devolver items de movimientos tipo "compra".' });
    }

    // 2. Lock del item + validación.
    const { rows: items } = await client.query(
      `SELECT * FROM items_movimiento_cc
        WHERE id = $1 AND movimiento_cc_id = $2
        FOR UPDATE`,
      [itemId, movId]
    );
    if (!items[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item no encontrado en este movimiento' });
    }
    const item = items[0];
    if (item.devuelto_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este item ya fue devuelto.' });
    }
    if (!item.producto_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Este item no tiene producto del Inventario asociado (texto libre); no se puede devolver por este flow.',
      });
    }

    // 3. Crear el movimiento_cc tipo 'devolucion' por este solo item. Le pasa
    //    el saldo del cliente (resta deuda) y restaura stock del producto.
    const cantidad = Number(item.cantidad || 1);
    const valor    = Number(item.valor || 0);
    const { rows: devMovRows } = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, caja_id, created_by_user_id)
       VALUES ($1, NOW()::date, 'devolucion', $2, $3, NULL, $4)
       RETURNING *`,
      [
        movOrig.cliente_cc_id,
        `Devolución item de mov #${movId}`,
        valor * cantidad,
        req.user.id,
      ]
    );
    const devMov = devMovRows[0];

    // 4. Copiar item al nuevo movimiento (para que el desglose del mov de
    //    devolución muestre qué se devolvió). Costo congelado igual que el
    //    original. NO seteamos devuelto_at acá — el flag lo lleva el item
    //    original, no la copia.
    await client.query(
      `INSERT INTO items_movimiento_cc
         (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado,
          notas, producto_id, cantidad, costo_unit, costo_moneda)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        devMov.id, item.producto, item.modelo, item.tamano, item.color,
        item.imei_serial, item.valor, item.verificado, item.notas,
        item.producto_id, cantidad, item.costo_unit, item.costo_moneda,
      ]
    );

    // 5. Restaurar stock — incrementar cantidad y volver a 'disponible' si
    //    el producto había quedado vendido. Mismo CASE que cancelMovimientoCC.
    await client.query(
      `UPDATE productos
          SET cantidad = cantidad + $2,
              estado = CASE
                WHEN cantidad + $2 <= 0                              THEN 'vendido'
                WHEN cantidad + $2 > 0  AND estado = 'vendido'       THEN 'disponible'
                ELSE estado
              END
        WHERE id = $1`,
      [item.producto_id, cantidad]
    );

    // 6. Marcar el item ORIGINAL como devuelto. Esto es lo que el frontend
    //    lee para tachar la fila y ocultar el botón ↺.
    await client.query(
      `UPDATE items_movimiento_cc
          SET devuelto_at = NOW(),
              devolucion_mov_id = $2,
              devolucion_user_id = $3
        WHERE id = $1`,
      [itemId, devMov.id, req.user.id]
    );

    // 7. Audit: queda registrado quién devolvió qué item de qué mov.
    await audit(client, 'items_movimiento_cc', 'UPDATE', itemId, {
      antes: { devuelto_at: null },
      despues: { devuelto_at: 'NOW', devolucion_mov_id: devMov.id },
      user_id: req.user.id,
      _origen: 'devolucion_inline',
      _mov_original_id: movId,
    });

    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);
    res.json({
      ok: true,
      item_id: itemId,
      devolucion_mov_id: devMov.id,
      monto_devuelto_usd: valor * cantidad,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ─── COBRANZA MASIVA ──────────────────────────────────────────────────────────
// Registra N pagos de distintos clientes en una sola TX (todo o nada).
//   - Cada fila es un movimiento_cc independiente (tipo=pago/parte_de_pago).
//   - Cada fila postea un INGRESO a su caja correspondiente.
//   - El sobrepago (monto > saldo) se permite: el cliente queda con saldo
//     negativo (a favor), descontable de la próxima compra.
//   - Si una fila falla por cualquier motivo (cliente no existe, caja
//     inválida, etc.) → rollback total: ninguna cobranza se aplica.
router.post('/cobranzas-masivas', cobranzaLimiter, validate(cobranzaMasivaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { cobranzas } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Pre-validación: clientes vivos y cajas vivas. Salvo bloqueo total
    // antes de empezar a INSERTAR para mensajes claros y rollback rápido.
    //
    // #M-01: SELECT FOR UPDATE ordenado por id en ambas tablas. Sin esto,
    // entre el SELECT y el INSERT otro proceso podía soft-deletear un
    // cliente o caja, dejando un movimientos_cc apuntando a deleted_at
    // != NULL. Con el lock, el delete espera al COMMIT.
    const clienteIds = [...new Set(cobranzas.map(c => c.cliente_cc_id))].sort((a, b) => a - b);
    const cajaIds    = [...new Set(cobranzas.map(c => c.caja_id))].sort((a, b) => a - b);
    // Las dos queries son secuenciales (no Promise.all) para mantener orden
    // de locks consistente entre transacciones concurrentes.
    const valC = await client.query(
      'SELECT id FROM clientes_cc WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE',
      [clienteIds]);
    const valK = await client.query(
      'SELECT id FROM metodos_pago WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE',
      [cajaIds]);
    const okC = new Set(valC.rows.map(r => r.id));
    const okK = new Set(valK.rows.map(r => r.id));
    const errores = [];
    cobranzas.forEach((c, i) => {
      if (!okC.has(c.cliente_cc_id)) errores.push({ fila: i + 1, error: `Cliente #${c.cliente_cc_id} no existe` });
      if (!okK.has(c.caja_id))       errores.push({ fila: i + 1, error: `Caja #${c.caja_id} no existe` });
    });
    if (errores.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Referencias inválidas', detalles: errores });
    }

    // #H-02 deadlock prevention: ordenar por caja_id ASC para que dos
    // procesos concurrentes que tocan cajas [A,B] vs [B,A] lockeen en el
    // mismo orden y eviten abort por deadlock detectado por PostgreSQL.
    //
    // #P-03 bulkificado: ANTES era loop con 1 INSERT mov + postCajaMovimiento
    // (que hace SELECT caja FOR UPDATE + INSERT) + 1 audit por cobranza.
    // Para 100 cobranzas: ~500 round-trips. AHORA: 1 lock batch + 1 INSERT
    // movs + 1 INSERT caja_movs + 1 audit-lote = 4 RTT total.
    const cobranzasOrdenadas = [...cobranzas].sort((a, b) =>
      Number(a.caja_id) - Number(b.caja_id));

    // Lock batch de las cajas únicas, ordenadas.
    const cajasUnicasOrdenadas = [...new Set(cobranzasOrdenadas.map(c => c.caja_id))].sort((a, b) => a - b);
    const { rows: cajaRows } = await client.query(
      `SELECT id, moneda FROM metodos_pago
         WHERE id = ANY($1::int[]) AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
      [cajasUnicasOrdenadas]
    );
    const cajaMoneda = new Map(cajaRows.map(r => [r.id, r.moneda]));

    // Validar que la moneda del pago coincida con el grupo de la caja
    // (USD/USDT son intercambiables, ARS aparte) — mismo check que hace
    // postCajaMovimiento pero hecho upfront para todas las filas.
    const grupoMoneda = (m) => m === 'ARS' ? 'ARS' : 'USD';
    for (let i = 0; i < cobranzasOrdenadas.length; i++) {
      const c = cobranzasOrdenadas[i];
      const monedaCaja = cajaMoneda.get(c.caja_id);
      if (grupoMoneda(monedaCaja) !== grupoMoneda(c.moneda)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Fila ${i + 1}: la moneda del pago (${c.moneda}) no coincide con la de la caja (${monedaCaja}).`,
        });
      }
    }

    // 1) Bulk INSERT de movimientos_cc, devuelve los IDs en el orden de UNNEST.
    const montosUsd = cobranzasOrdenadas.map(c => round2(toUsd(c.monto, c.moneda, c.tc)));
    const movRes = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, caja_id, created_by_user_id)
       SELECT cli, f, t, d, m, k, $1
         FROM UNNEST(
           $2::int[], $3::date[], $4::text[], $5::text[],
           $6::numeric[], $7::int[]
         ) WITH ORDINALITY AS u(cli, f, t, d, m, k, ord)
         ORDER BY ord
       RETURNING *`,
      [
        req.user.id,
        cobranzasOrdenadas.map(c => c.cliente_cc_id),
        cobranzasOrdenadas.map(c => c.fecha),
        cobranzasOrdenadas.map(c => c.tipo),
        cobranzasOrdenadas.map(c => c.descripcion ?? 'Cobranza masiva'),
        montosUsd,
        cobranzasOrdenadas.map(c => c.caja_id),
      ]
    );
    const creados = movRes.rows;

    // 2) Bulk INSERT de caja_movimientos con los ref_id de los movs creados.
    await client.query(
      `INSERT INTO caja_movimientos
         (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
       SELECT k, f, 'ingreso', m, mu, 'b2b', 'movimientos_cc', ref, con, $1
         FROM UNNEST(
           $2::int[], $3::date[], $4::numeric[], $5::numeric[],
           $6::int[], $7::text[]
         ) AS u(k, f, m, mu, ref, con)`,
      [
        req.user.id,
        cobranzasOrdenadas.map(c => c.caja_id),
        cobranzasOrdenadas.map(c => c.fecha),
        cobranzasOrdenadas.map(c => c.monto),
        montosUsd,
        creados.map(m => m.id),
        cobranzasOrdenadas.map(c => `Cobranza masiva cliente #${c.cliente_cc_id}`),
      ]
    );

    // 3) 1 audit-lote en vez de 1 por cobranza.
    // 1 audit-lote (accion='INSERT', con flag _bulk para distinguir del
    // INSERT individual al inspeccionar logs).
    await audit(client, 'movimientos_cc', 'INSERT', creados[0].id, {
      despues: { _bulk: true, _origen: 'cobranza_masiva', ids: creados.map(m => m.id), count: creados.length },
      user_id: req.user.id,
    });

    await client.query('COMMIT');
    res.status(201).json({ ok: true, creados: creados.length, movimientos: creados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── RESUMEN DE CUENTA ────────────────────────────────────────────────────────
// Totales desglosados por tipo para el header del detalle de cuenta

router.get('/clientes/:id/resumen', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: c } = await client.query(
        'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      if (!c[0]) return { notFound: true };

      const { rows } = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo = 'compra'             THEN monto_total ELSE 0 END), 0) AS total_compras,
           COALESCE(SUM(CASE WHEN tipo = 'pago'               THEN monto_total ELSE 0 END), 0) AS total_pagos,
           COALESCE(SUM(CASE WHEN tipo = 'devolucion'         THEN monto_total ELSE 0 END), 0) AS total_devoluciones,
           COALESCE(SUM(CASE WHEN tipo = 'parte_de_pago'      THEN monto_total ELSE 0 END), 0) AS total_parte_de_pago,
           COALESCE(SUM(CASE WHEN tipo = 'entrega_mercaderia' THEN monto_total ELSE 0 END), 0) AS total_entrega_mercaderia,
           COALESCE(SUM(CASE WHEN tipo = 'saldo_inicial'      THEN monto_total ELSE 0 END), 0) AS total_saldo_inicial,
           -- Saldo aplica la misma regla que el listado (SALDO_CASE):
           -- compra con caja_id = contado, no suma deuda.
           COALESCE(SUM(${SALDO_CASE}), 0) AS saldo,
           COUNT(*) FILTER (WHERE tipo = 'compra') AS cant_compras,
           COUNT(*)                                AS cant_movimientos
         FROM movimientos_cc
         WHERE cliente_cc_id = $1 AND deleted_at IS NULL`,
        [id]
      );

      return { cliente: c[0], ...rows[0] };
    });
    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /resumen-general — métricas globales de todas las CC
router.get('/resumen-general', async (req, res, next) => {
  try {
    // CTE compartida: calcula saldos una sola vez para totales y top-10.
    // Usa la misma regla que el listado de clientes y el detalle (SALDO_CASE_M):
    // una 'compra' con caja_id no suma deuda (contado).
    const BASE_CTE = `
      WITH saldos AS (
        SELECT
          c.id, c.nombre, c.apellido, c.categoria,
          COALESCE(SUM(${SALDO_CASE_M}), 0) AS saldo
        FROM clientes_cc c
        LEFT JOIN movimientos_cc m
               ON m.cliente_cc_id = c.id AND m.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.nombre, c.apellido, c.categoria
      )
    `;

    const { totals, top } = await db.withTenant(req.tenantId, async (client) => {
      const [{ rows: totals }, { rows: top }] = await Promise.all([
        client.query(BASE_CTE + `
          SELECT
            COUNT(*)::int                                                   AS cant_clientes,
            COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo  ELSE 0 END), 0)   AS total_deuda,
            COALESCE(SUM(CASE WHEN saldo < 0 THEN -saldo ELSE 0 END), 0)   AS total_credito,
            COALESCE(SUM(saldo), 0)                                         AS neto
          FROM saldos
        `),
        client.query(BASE_CTE + `
          SELECT id, nombre, apellido, categoria, saldo
          FROM saldos
          WHERE saldo > 0
          ORDER BY saldo DESC
          LIMIT 10
        `),
      ]);
      return { totals, top };
    });

    res.json({ ...totals[0], top_deudores: top });
  } catch (err) { next(err); }
});

// GET /calendario?mes=2026-05 — movimientos agrupados por día para el calendario
router.get('/calendario', async (req, res, next) => {
  try {
    const mes = req.query.mes || new Date().toISOString().substring(0, 7);
    // Validate mes format
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Formato de mes inválido (YYYY-MM)' });

    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(`
        SELECT
          fecha::date                                                                                AS dia,
          COALESCE(SUM(CASE WHEN tipo = 'compra'                         THEN monto_total ELSE 0 END), 0) AS compras,
          COALESCE(SUM(CASE WHEN tipo IN ('pago','parte_de_pago','entrega_mercaderia') THEN monto_total ELSE 0 END), 0) AS pagos,
          COALESCE(SUM(CASE WHEN tipo = 'devolucion'                     THEN monto_total ELSE 0 END), 0) AS devoluciones,
          COUNT(*)::int                                                                              AS cant
        FROM movimientos_cc
        WHERE DATE_TRUNC('month', fecha) = DATE_TRUNC('month', ($1 || '-01')::date)
          AND deleted_at IS NULL
        GROUP BY fecha::date
        ORDER BY fecha::date
      `, [mes]);
      return rows;
    });

    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
