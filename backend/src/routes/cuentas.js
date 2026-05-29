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

const rateLimit = require('express-rate-limit');
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
  keyGenerator: (req) => `cobranza-masiva:${req.user?.id || req.ip}`,
  message: { error: 'Demasiadas cobranzas masivas. Probá de nuevo en unos minutos.' },
});
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  cobranzaMasivaSchema,
} = require('../schemas/cuentas');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { syncContactoSafe } = require('../lib/contactosSync');

// Expresión CASE compartida para calcular el aporte de cada movimiento al saldo.
//
// Regla (mayo-2026, paralelo a Proveedores): una 'compra' con caja_id es
// contado (entró el dinero al instante) y NO suma deuda. Sin caja_id queda
// como deuda del cliente (el caso clásico de venta a CC).
//
// Usar `m.` o sin prefijo según el contexto: `SALDO_CASE` para queries sin
// alias, `SALDO_CASE_M` para queries con `movimientos_cc m`.
const SALDO_CASE = `
  CASE
    WHEN tipo = 'saldo_inicial'                       THEN  monto_total
    WHEN tipo = 'compra' AND caja_id IS NOT NULL      THEN  0
    WHEN tipo = 'compra'                              THEN  monto_total
    ELSE -monto_total
  END
`;
const SALDO_CASE_M = `
  CASE
    WHEN m.tipo = 'saldo_inicial'                     THEN  m.monto_total
    WHEN m.tipo = 'compra' AND m.caja_id IS NOT NULL  THEN  0
    WHEN m.tipo = 'compra'                            THEN  m.monto_total
    ELSE -m.monto_total
  END
`;

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
    const { rows } = await db.query(
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
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM clientes_cc c WHERE ${where}`, params),
      db.query(
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
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.get('/clientes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      `SELECT c.*, ${SALDO_SQL} AS saldo
       FROM clientes_cc c
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/clientes', validate(createClienteCCSchema), async (req, res, next) => {
  const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, saldo_inicial } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
    // Agenda central (best-effort, fuera de la transacción)
    await syncContactoSafe(db, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: cliente.id,
      nombre: cliente.nombre, apellido: cliente.apellido, telefono: cliente.contacto,
    });
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
    if (!id) { client.release(); return res.status(400).json({ error: 'ID inválido' }); }

    await client.query('BEGIN');
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
    // Agenda central (best-effort, fuera de la TX)
    await syncContactoSafe(db, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: rows[0].id,
      nombre: rows[0].nombre, apellido: rows[0].apellido, telefono: rows[0].contacto,
    });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/clientes/:id', async (req, res, next) => {
  // #H-09: TX para que audit y delete sean atómicos
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) { client.release(); return res.status(400).json({ error: 'ID inválido' }); }

    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE clientes_cc SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Cliente no encontrado' }); }
    await audit(client, 'clientes_cc', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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

    // Verificar que el cliente existe
    const { rows: c } = await db.query(
      'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!c[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Movimientos del cliente (paginado — una cuenta activa puede tener miles)
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM movimientos_cc WHERE cliente_cc_id = $1 AND deleted_at IS NULL', [id]
    );
    const { rows: movs } = await db.query(
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
      const { rows } = await db.query(
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
    res.json(paginatedResponse(result, parseInt(countRows[0].count), { page, limit }));
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
    } = req.body;

    // #H-05 cross-module: si la venta/devolución toca stock de inventario
    // (producto_id en algún item), exigir también permiso `inventario`.
    const tocaStock = ['compra', 'devolucion', 'entrega_mercaderia'].includes(tipo)
      && items.some(it => it.producto_id);
    if (tocaStock) {
      const { hasPermission } = require('../middleware/requirePermission');
      const ok = await hasPermission(req.user, 'inventario');
      if (!ok) {
        return res.status(403).json({
          error: 'Para registrar un movimiento que descuenta stock necesitás también permiso de Inventario.',
        });
      }
    }

    await client.query('BEGIN');

    // Verificar que el cliente existe (dentro de la tx, con FOR UPDATE para evitar race condition)
    const { rows: c } = await client.query(
      'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cliente_cc_id]
    );
    if (!c[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Insertar movimiento (con auditoría de creador para #B-07)
    const { rows: movRows } = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, notas, caja_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [cliente_cc_id, fecha, tipo, descripcion ?? null, monto_total, notas ?? null, caja_id ?? null, req.user.id]
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

      // 1) Batch SELECT FOR UPDATE de todos los productos relevantes en una
      //    sola query, ordenados por id para evitar deadlock.
      let prodMap = new Map();
      if (prodIds.length > 0) {
        const { rows: prodRows } = await client.query(
          `SELECT id, nombre, cantidad, estado FROM productos
             WHERE id = ANY($1::int[]) AND deleted_at IS NULL
             ORDER BY id
             FOR UPDATE`,
          [prodIds]
        );
        prodMap = new Map(prodRows.map(p => [Number(p.id), p]));

        // Validación: existencia + stock suficiente.
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
      const itemRes = await client.query(
        `INSERT INTO items_movimiento_cc
           (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas, producto_id, cantidad)
         SELECT $1, p, m, t, c, i, v, vf, n, pid, cant
           FROM UNNEST(
             $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
             $7::numeric[], $8::boolean[], $9::text[], $10::int[], $11::int[]
           ) AS u(p, m, t, c, i, v, vf, n, pid, cant)
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
        ]
      );
      insertedItems = itemRes.rows;

      // 3) Bulk UPDATE del stock con un solo round-trip. Usa FROM (VALUES ...)
      //    + JOIN. PostgreSQL aplica el CASE por producto.
      if (itemsConProd.length > 0) {
        const sign = esSalida ? '-' : '+';
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
           WHERE p.id = u.pid`,
          [
            itemsConProd.map(it => Number(it.producto_id)),
            itemsConProd.map(it => Number(it.cantidad || 1)),
          ]
        );
        // Asegura que afectamos N filas (sanity check)
        if (updateRes.rowCount !== itemsConProd.length) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'Inconsistencia al actualizar stock' });
        }
      }
    }

    await audit(client, 'movimientos_cc', 'INSERT', mov.id, {
      despues: { ...mov, items: insertedItems },
      user_id: req.user.id,
    });
    await client.query('COMMIT');

    res.status(201).json({ ...mov, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Ownership check (auditoría #B-07): un user con permiso `cuentas` solo
    // puede borrar movimientos que él mismo creó. Los admins pueden borrar
    // cualquiera. Movimientos legacy (created_by_user_id IS NULL, anteriores
    // al deploy de la migración 013) solo los borra admin.
    const { rows: pre } = await client.query(
      'SELECT id, created_by_user_id FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    );
    if (!pre[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    const isOwner = pre[0].created_by_user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No tenés permiso para borrar este movimiento (lo creó otro usuario).' });
    }
    const { rows } = await client.query(
      'UPDATE movimientos_cc SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    // Revertir el ingreso de caja asociado (si lo hubo)
    await reverseCajaMovimientos(client, 'movimientos_cc', id);

    // Devolver el stock al Inventario para los items que lo descontaron.
    //   - Si el mov era compra/entrega_mercaderia → reentra al stock.
    //   - Si era devolucion → vuelve a salir (compensa el ingreso original).
    // Soft-delete (items_movimiento_cc no se borra pero la PK del mov ya quedó
    // marcada con deleted_at, así que esta query usa la lista de items vivos
    // ANTES del soft-delete del padre via JOIN sobre el id del movimiento).
    const tipo = rows[0].tipo;
    if (['compra', 'entrega_mercaderia', 'devolucion'].includes(tipo)) {
      const sign = tipo === 'devolucion' ? -1 : 1; // compra/entrega: + (reintegrar); devolución: − (sacar)
      const { rows: items } = await client.query(
        `SELECT producto_id, cantidad FROM items_movimiento_cc
           WHERE movimiento_cc_id = $1 AND producto_id IS NOT NULL`,
        [id]
      );
      // Pre-validar que ningún UPDATE deje cantidad negativa (auditoría #B-06).
      // Caso típico que rompía: devolución sube stock 0→2, luego otra venta
      // intermedia baja 2→1, y al borrar la devolución intentamos 1→-1 que
      // viola CHECK (cantidad >= 0). En vez de un 500 críptico, devolvemos 409
      // con producto y cantidad disponible. Usamos FOR UPDATE para evitar
      // race con otras ventas en curso.
      if (sign < 0) {
        for (const it of items) {
          const delta = sign * Number(it.cantidad || 1);
          const { rows: pr } = await client.query(
            `SELECT id, nombre, cantidad FROM productos WHERE id = $1 FOR UPDATE`,
            [it.producto_id]
          );
          if (!pr[0]) continue; // producto borrado, ignoramos
          if (Number(pr[0].cantidad) + delta < 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `No se puede borrar la devolución: el stock de "${pr[0].nombre}" ya fue vendido (disponible ${pr[0].cantidad}, necesario ${-delta}).`,
              producto_id: it.producto_id,
            });
          }
        }
      }
      for (const it of items) {
        const delta = sign * Number(it.cantidad || 1);
        await client.query(
          `UPDATE productos
             SET cantidad = cantidad + $1,
                 estado   = CASE
                   WHEN cantidad + $1 > 0 AND estado = 'vendido' THEN 'disponible'
                   WHEN cantidad + $1 <= 0                       THEN 'vendido'
                   ELSE estado
                 END
           WHERE id = $2`,
          [delta, it.producto_id]
        );
      }
    }

    await audit(client, 'movimientos_cc', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
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

    const { rows: c } = await db.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!c[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { rows } = await db.query(
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

    res.json({ cliente: c[0], ...rows[0] });
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

    const [{ rows: totals }, { rows: top }] = await Promise.all([
      db.query(BASE_CTE + `
        SELECT
          COUNT(*)::int                                                   AS cant_clientes,
          COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo  ELSE 0 END), 0)   AS total_deuda,
          COALESCE(SUM(CASE WHEN saldo < 0 THEN -saldo ELSE 0 END), 0)   AS total_credito,
          COALESCE(SUM(saldo), 0)                                         AS neto
        FROM saldos
      `),
      db.query(BASE_CTE + `
        SELECT id, nombre, apellido, categoria, saldo
        FROM saldos
        WHERE saldo > 0
        ORDER BY saldo DESC
        LIMIT 10
      `),
    ]);

    res.json({ ...totals[0], top_deudores: top });
  } catch (err) { next(err); }
});

// GET /calendario?mes=2026-05 — movimientos agrupados por día para el calendario
router.get('/calendario', async (req, res, next) => {
  try {
    const mes = req.query.mes || new Date().toISOString().substring(0, 7);
    // Validate mes format
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Formato de mes inválido (YYYY-MM)' });

    const { rows } = await db.query(`
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

    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
