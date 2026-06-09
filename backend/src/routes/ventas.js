const router = require('express').Router();
const crypto = require('crypto');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { toUsd, round2 } = require('../lib/money');
// postCajaMovimiento / reverseCajaMovimientos: postear/revertir cajas para una venta
// los maneja lib/ventaSync.js; este archivo no los usa directamente, pero los dejamos
// disponibles a través del require por si una edición futura los necesita.
// (Eliminado: imports innecesarios detectados por ESLint.)
const { syncFinancieraComprobante } = require('../lib/financiera');
const { syncTarjetaCobros } = require('../lib/tarjetas');
const { revertirEfectosVenta } = require('../lib/cancelarVenta');
const { syncVentaCaja, sincronizarCuentaCorriente } = require('../lib/ventaSync');
const {
  createVentaSchema, updateVentaSchema, queryVentasSchema, queryDashboardSchema,
} = require('../schemas/ventas');

router.use(requireAuth);

function genOrderId() {
  const yy = new Date().getFullYear().toString().slice(-2);
  // 6 bytes (12 hex) → colisión despreciable incluso con millones de órdenes
  return `ORD-${yy}-${crypto.randomBytes(6).toString('hex')}`;
}

const { err400, retieneStock, descontarStock, reponerStock } = require('../lib/ventaCore');
const { invalidateMetricas } = require('../lib/inventarioCache');

// (syncVentaCaja y sincronizarCuentaCorriente movidos a lib/ventaSync.js — reusados desde envíos)

// Si hay un pago en cuenta corriente, exige un cliente de cuenta corriente.
function validarCuentaCorriente(pagos, clienteCcId) {
  if ((pagos || []).some(p => p.es_cuenta_corriente) && !clienteCcId) {
    throw err400('Para un pago en cuenta corriente, elegí un cliente con cuenta corriente.');
  }
}

// Exige TC > 0 cuando hay montos en ARS (evita que se contabilicen como USD 0 silenciosamente).
function validarTc(items, pagos, tcVenta) {
  const tcOk = Number(tcVenta) > 0;
  if ((items || []).some(it => it.moneda === 'ARS') && !tcOk) {
    throw err400('Indicá el tipo de cambio (TC) de la venta para ítems en ARS.');
  }
  for (const p of (pagos || [])) {
    if (p.moneda === 'ARS' && !(Number(p.tc) > 0) && !tcOk) {
      throw err400('Indicá el tipo de cambio (TC) para los pagos en ARS.');
    }
  }
}

// (helpers de stock movidos a lib/ventaCore.js — reusados desde envíos)

// Totales de una venta en USD (normalizados por TC). { totalUsd, gananciaUsd }
function calcularTotales(items, tc) {
  let totalUsd = 0, costoUsd = 0, comisionUsd = 0;
  for (const it of items) {
    totalUsd    += toUsd(it.precio_vendido * it.cantidad, it.moneda, tc);
    costoUsd    += toUsd(it.costo * it.cantidad, it.moneda, tc);
    comisionUsd += toUsd(it.comision, it.moneda, tc);
  }
  return { totalUsd: round2(totalUsd), gananciaUsd: round2(totalUsd - costoUsd - comisionUsd) };
}

// Inserta items, pagos y canjes de una venta (usado por crear y editar). El stock
// debe descontarse aparte con descontarStock(). Canjes con agregar_stock crean un producto usado.
async function insertarDetalle(client, venta, b) {
  for (const it of b.items) {
    const ganancia = round2((it.precio_vendido - it.costo) * it.cantidad - it.comision);
    await client.query(
      `INSERT INTO venta_items (venta_id, producto_id, vendedor_id, descripcion, imei, cantidad, precio_vendido, precio_original, costo, moneda, comision, ganancia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [venta.id, it.producto_id ?? null, it.vendedor_id ?? null, it.descripcion, it.imei ?? null, it.cantidad,
       it.precio_vendido, it.precio_original ?? null, it.costo, it.moneda, it.comision, ganancia]
    );
  }
  for (const p of (b.pagos || [])) {
    const montoUsd = round2(toUsd(p.monto, p.moneda, p.tc ?? b.tc_venta));
    await client.query(
      `INSERT INTO venta_pagos (venta_id, metodo_pago_id, metodo_nombre, monto, moneda, tc, monto_usd, es_cuenta_corriente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [venta.id, p.metodo_pago_id ?? null, p.metodo_nombre, p.monto, p.moneda, p.tc ?? null, montoUsd, p.es_cuenta_corriente]
    );
  }
  for (const c of (b.canjes || [])) {
    let prodId = null;
    if (c.agregar_stock) {
      // Ampliación junio 2026: el producto se crea con TODOS los campos que el
      // user cargó en el form de canje, no solo los básicos. Antes:
      //   categoria_id=NULL, condicion=NULL (DB default 'nuevo'), precio_venta=0
      // → el producto era inusable hasta editarlo a mano post-venta.
      //
      // Observaciones: si el user cargó un texto, lo prependeamos a la nota
      // automática "Ingresado por canje (venta V-XXX)" para que el contexto
      // (que el equipo entró por un canje) NUNCA se pierda.
      const autoObs = `Ingresado por canje (venta ${venta.order_id})`;
      const obsFinal = c.observaciones?.trim()
        ? `${c.observaciones.trim()}\n— ${autoObs}`
        : autoObs;
      const { rows: pr } = await client.query(
        `INSERT INTO productos (
            tipo_carga, clase, nombre, imei, gb, color, bateria,
            categoria_id, condicion,
            costo, costo_moneda, precio_venta, precio_moneda,
            estado, observaciones
         ) VALUES (
            'unitario','celular',$1,$2,$3,$4,$5,
            $6,$7,
            $8,$9,$10,$9,
            'disponible',$11
         ) RETURNING id`,
        [
          c.descripcion, c.imei ?? null, c.gb ?? null, c.color ?? null, c.bateria ?? null,
          c.categoria_id ?? null, c.condicion ?? 'usado', // default 'usado' — un canje casi siempre lo es
          c.valor_toma, c.moneda, c.precio_venta_sugerido ?? 0,
          obsFinal,
        ]
      );
      prodId = pr[0].id;
    }
    await client.query(
      `INSERT INTO canjes (venta_id, descripcion, imei, gb, color, bateria, valor_toma, moneda, producto_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [venta.id, c.descripcion, c.imei ?? null, c.gb ?? null, c.color ?? null, c.bateria ?? null, c.valor_toma, c.moneda, prodId]
    );
  }
}

/* ═══════════════════════ DASHBOARD (agregaciones) ═══════════════════════ */

router.get('/dashboard', validate(queryDashboardSchema, 'query'), async (req, res, next) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const desde = req.query.desde || hoy;
    const hasta = req.query.hasta || hoy;
    const p = [desde, hasta];
    // Filtro base de ventas del período (excluye canceladas y borradas)
    const BASE = `v.deleted_at IS NULL AND v.estado <> 'cancelado' AND v.fecha >= $1 AND v.fecha <= $2`;

    // B2B: ventas registradas como movimientos_cc tipo='compra' en el período.
    // Antes el dashboard solo miraba la tabla `ventas` (retail). Ahora sumamos
    // las B2B en un bloque aparte + las totalizamos en los KPIs generales
    // (ventas_count, ingresos, costos, ganancia).
    //
    // monto_total y valor ya están persistidos en USD (frontend convierte al
    // mandar). costo_unit puede estar en USD o ARS — si está en ARS y no hay
    // info de TC, asumimos costo_unit como USD (caso 99% del catálogo). Si
    // empieza a haber casos mixtos importantes, agregar columna tc al movimiento.
    const B2B_BASE = `m.deleted_at IS NULL AND m.tipo = 'compra' AND m.fecha >= $1 AND m.fecha <= $2`;

    const [totales, pagos, unidades, canjes, egresos, dif, horario, etiquetas, topProd, topVend, b2b] = await Promise.all([
      // Totales de ventas
      db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(total_usd),0) AS ingresos_usd, COALESCE(SUM(ganancia_usd),0) AS ganancia_bruta_usd FROM ventas v WHERE ${BASE}`, p),
      // Por método de pago (monto en moneda original + equivalente USD)
      db.query(`SELECT pp.metodo_nombre, pp.moneda, COALESCE(SUM(pp.monto),0) AS total, COALESCE(SUM(pp.monto_usd),0) AS total_usd, COUNT(*) AS n
                FROM venta_pagos pp JOIN ventas v ON v.id = pp.venta_id WHERE ${BASE}
                GROUP BY pp.metodo_nombre, pp.moneda ORDER BY total_usd DESC`, p),
      // Unidades por clase + costos en USD
      db.query(`SELECT
                  COALESCE(SUM(vi.cantidad) FILTER (WHERE pr.clase = 'celular' OR pr.id IS NULL),0) AS celulares,
                  COALESCE(SUM(vi.cantidad) FILTER (WHERE pr.clase = 'accesorio'),0) AS accesorios,
                  COALESCE(SUM(CASE WHEN vi.moneda = 'ARS' AND v.tc_venta > 0 THEN vi.costo*vi.cantidad/v.tc_venta ELSE vi.costo*vi.cantidad END),0) AS costos_usd
                FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id LEFT JOIN productos pr ON pr.id = vi.producto_id WHERE ${BASE}`, p),
      // Inversión en canjes (USD)
      db.query(`SELECT COALESCE(SUM(CASE WHEN c.moneda = 'ARS' AND v.tc_venta > 0 THEN c.valor_toma/v.tc_venta ELSE c.valor_toma END),0) AS canjes_usd
                FROM canjes c JOIN ventas v ON v.id = c.venta_id WHERE ${BASE}`, p),
      // Egresos del período (USD)
      db.query(`SELECT COALESCE(SUM(monto_usd),0) AS egresos_usd FROM egresos WHERE deleted_at IS NULL AND estado = 'pagado' AND fecha >= $1 AND fecha <= $2`, p),
      // Diferencias de pago (sobrepagos / faltantes) — CTEs pre-agregadas (sin subqueries correlacionadas)
      db.query(`WITH bv AS (
                  SELECT v.id, v.total_usd, v.tc_venta FROM ventas v WHERE ${BASE}
                ),
                pa AS (
                  SELECT pp.venta_id, SUM(pp.monto_usd) AS pagos_usd
                  FROM venta_pagos pp JOIN bv ON bv.id = pp.venta_id GROUP BY pp.venta_id
                ),
                ca AS (
                  SELECT cc.venta_id,
                         SUM(CASE WHEN cc.moneda = 'ARS' AND bv.tc_venta > 0 THEN cc.valor_toma/bv.tc_venta ELSE cc.valor_toma END) AS canje_usd
                  FROM canjes cc JOIN bv ON bv.id = cc.venta_id GROUP BY cc.venta_id
                ),
                dif AS (
                  SELECT bv.total_usd, COALESCE(pa.pagos_usd,0) + COALESCE(ca.canje_usd,0) AS cubierto
                  FROM bv
                  LEFT JOIN pa ON pa.venta_id = bv.id
                  LEFT JOIN ca ON ca.venta_id = bv.id
                )
                SELECT COALESCE(SUM(CASE WHEN cubierto-total_usd > 0 THEN cubierto-total_usd ELSE 0 END),0) AS sobrepagos,
                       COALESCE(SUM(CASE WHEN cubierto-total_usd < 0 THEN total_usd-cubierto ELSE 0 END),0) AS faltantes FROM dif`, p),
      // Ventas por hora
      db.query(`SELECT EXTRACT(HOUR FROM v.hora)::int AS hora, COUNT(*) AS n FROM ventas v WHERE ${BASE} AND v.hora IS NOT NULL GROUP BY 1 ORDER BY 1`, p),
      // Ventas por etiqueta
      db.query(`SELECT COALESCE(e.nombre,'Sin etiqueta') AS etiqueta, COUNT(*) AS n FROM ventas v LEFT JOIN etiquetas e ON e.id = v.etiqueta_id WHERE ${BASE} GROUP BY 1 ORDER BY n DESC`, p),
      // Top productos (por unidades)
      db.query(`SELECT vi.descripcion, SUM(vi.cantidad)::int AS unidades
                FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE ${BASE}
                GROUP BY vi.descripcion ORDER BY unidades DESC, vi.descripcion LIMIT 5`, p),
      // Top vendedores (por total facturado en USD)
      db.query(`SELECT ve.nombre AS vendedor,
                       COALESCE(SUM(CASE WHEN vi.moneda='ARS' AND v.tc_venta>0 THEN vi.precio_vendido*vi.cantidad/v.tc_venta ELSE vi.precio_vendido*vi.cantidad END),0) AS total_usd,
                       COUNT(*)::int AS items
                FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN vendedores ve ON ve.id = vi.vendedor_id
                WHERE ${BASE} GROUP BY ve.nombre ORDER BY total_usd DESC LIMIT 5`, p),
      // B2B: ventas via movimientos_cc (junio 2026). count + ingresos +
      // costos + ganancia + unidades por clase. Asumimos costos en USD.
      db.query(`
        SELECT
          COUNT(DISTINCT m.id)::int                                          AS count,
          COALESCE(SUM(DISTINCT m.monto_total), 0)                           AS ingresos_usd,
          COALESCE(SUM(i.costo_unit * i.cantidad), 0)                        AS costos_usd,
          COALESCE(SUM(i.cantidad) FILTER (WHERE pr.clase = 'celular'), 0)::int   AS celulares,
          COALESCE(SUM(i.cantidad) FILTER (WHERE pr.clase = 'accesorio'), 0)::int AS accesorios
        FROM movimientos_cc m
        LEFT JOIN items_movimiento_cc i ON i.movimiento_cc_id = m.id
        LEFT JOIN productos pr ON pr.id = i.producto_id
        WHERE ${B2B_BASE}
      `, p),
    ]);

    // Ingresos por moneda (a partir del desglose de métodos)
    const ingresos_por_moneda = { USD: 0, ARS: 0, USDT: 0 };
    let ingresos_usd_equiv = 0;
    for (const r of pagos.rows) {
      ingresos_por_moneda[r.moneda] = (ingresos_por_moneda[r.moneda] || 0) + Number(r.total);
      ingresos_usd_equiv += Number(r.total_usd);
    }

    const t = totales.rows[0];
    const b = b2b.rows[0];
    // KPIs B2B aislados — para que el frontend pueda mostrarlos discriminados.
    const b2bCount        = Number(b.count) || 0;
    const b2bIngresosUsd  = Number(b.ingresos_usd) || 0;
    const b2bCostosUsd    = Number(b.costos_usd) || 0;
    const b2bGananciaUsd  = round2(b2bIngresosUsd - b2bCostosUsd);

    const gananciaBrutaRetail = Number(t.ganancia_bruta_usd);
    const ingresosVentasRetail = Number(t.ingresos_usd);
    const costosRetailUsd = Number(unidades.rows[0].costos_usd);
    const egresosUsd = Number(egresos.rows[0].egresos_usd);

    // KPIs combinados (retail + B2B). El frontend que ya consumía estos campos
    // ahora ve el total. Si necesita solo retail, le agregamos `.retail` / `.b2b` aparte.
    const ingresosVentas = ingresosVentasRetail + b2bIngresosUsd;
    const gananciaBruta = gananciaBrutaRetail + b2bGananciaUsd;
    const gananciaNeta = round2(gananciaBruta - egresosUsd);
    const margenPct = ingresosVentas > 0 ? round2((gananciaNeta / ingresosVentas) * 100) : 0;

    res.json({
      periodo: { desde, hasta },
      ventas_count: parseInt(t.count) + b2bCount,
      ingresos: {
        usd: round2(ingresos_por_moneda.USD),
        ars: round2(ingresos_por_moneda.ARS),
        usdt: round2(ingresos_por_moneda.USDT),
        total_usd_equiv: round2(ingresos_usd_equiv + b2bIngresosUsd),
        ventas_total_usd: round2(ingresosVentas),
      },
      unidades: {
        celulares: parseInt(unidades.rows[0].celulares) + parseInt(b.celulares),
        accesorios: parseInt(unidades.rows[0].accesorios) + parseInt(b.accesorios),
      },
      ganancia_bruta_usd: round2(gananciaBruta),
      egresos_usd: round2(egresosUsd),
      ganancia_neta_usd: gananciaNeta,
      margen_pct: margenPct,
      costos_usd: round2(costosRetailUsd + b2bCostosUsd),
      // Desglose retail vs B2B para que el frontend pueda discriminar.
      retail: {
        count: parseInt(t.count),
        ingresos_usd: round2(ingresosVentasRetail),
        ganancia_bruta_usd: round2(gananciaBrutaRetail),
        costos_usd: round2(costosRetailUsd),
      },
      b2b: {
        count: b2bCount,
        ingresos_usd: round2(b2bIngresosUsd),
        ganancia_bruta_usd: b2bGananciaUsd,
        costos_usd: round2(b2bCostosUsd),
        unidades: { celulares: parseInt(b.celulares), accesorios: parseInt(b.accesorios) },
      },
      inversion_canjes_usd: round2(Number(canjes.rows[0].canjes_usd)),
      metodos_pago: pagos.rows.map(r => ({ metodo_nombre: r.metodo_nombre, moneda: r.moneda, total: round2(Number(r.total)), total_usd: round2(Number(r.total_usd)), n: parseInt(r.n) })),
      diferencias: { sobrepagos: round2(Number(dif.rows[0].sobrepagos)), faltantes: round2(Number(dif.rows[0].faltantes)), neto: round2(Number(dif.rows[0].sobrepagos) - Number(dif.rows[0].faltantes)) },
      por_horario: horario.rows.map(r => ({ hora: r.hora, n: parseInt(r.n) })),
      por_etiqueta: etiquetas.rows.map(r => ({ etiqueta: r.etiqueta, n: parseInt(r.n) })),
      ticket_promedio_usd: parseInt(t.count) > 0 ? round2(ingresosVentas / parseInt(t.count)) : 0,
      top_productos: topProd.rows.map(r => ({ descripcion: r.descripcion, unidades: r.unidades })),
      top_vendedores: topVend.rows.map(r => ({ vendedor: r.vendedor, total_usd: round2(Number(r.total_usd)), items: r.items })),
    });
  } catch (err) { next(err); }
});

/* ═══════════════════════ VENTAS ═══════════════════════ */

router.get('/', validate(queryVentasSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, estado, etiqueta_id, buscar } = req.query;
    const conditions = ['v.deleted_at IS NULL'];
    const params = [];
    if (desde)       { params.push(desde);       conditions.push(`v.fecha >= $${params.length}`); }
    if (hasta)       { params.push(hasta);       conditions.push(`v.fecha <= $${params.length}`); }
    if (estado)      { params.push(estado);      conditions.push(`v.estado = $${params.length}`); }
    if (etiqueta_id) { params.push(etiqueta_id); conditions.push(`v.etiqueta_id = $${params.length}`); }
    if (buscar) {
      params.push(`%${buscar}%`);
      conditions.push(`(v.order_id ILIKE $${params.length} OR v.cliente_nombre ILIKE $${params.length}
                        OR EXISTS (SELECT 1 FROM venta_items vi WHERE vi.venta_id = v.id AND (vi.descripcion ILIKE $${params.length} OR vi.imei ILIKE $${params.length})))`);
    }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const dataQuery = `
      SELECT v.*, e.nombre AS etiqueta_nombre, e.color AS etiqueta_color,
        COALESCE((SELECT json_agg(i ORDER BY i.id) FROM venta_items i WHERE i.venta_id = v.id), '[]') AS items,
        COALESCE((SELECT json_agg(p ORDER BY p.id) FROM venta_pagos p WHERE p.venta_id = v.id), '[]') AS pagos,
        COALESCE((SELECT json_agg(c ORDER BY c.id) FROM canjes c WHERE c.venta_id = v.id), '[]') AS canjes,
        COALESCE((SELECT COUNT(*) FROM venta_comprobantes vc WHERE vc.venta_id = v.id AND vc.deleted_at IS NULL), 0) AS comprobantes_count
      FROM ventas v
      LEFT JOIN etiquetas e ON e.id = v.etiqueta_id
      WHERE ${where}
      ORDER BY v.fecha DESC, v.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM ventas v WHERE ${where}`, params),
      db.query(dataQuery, [...params, limit, offset]),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/', validate(createVentaSchema), async (req, res, next) => {
  const b = req.body;
  const client = await db.connect();
  try {
    validarTc(b.items, b.pagos, b.tc_venta);
    validarCuentaCorriente(b.pagos, b.cliente_cc_id);
    await client.query('BEGIN');

    const { totalUsd, gananciaUsd } = calcularTotales(b.items, b.tc_venta);

    const { rows: vrows } = await client.query(
      `INSERT INTO ventas (order_id, fecha, hora, cliente_id, cliente_cc_id, cliente_nombre, etiqueta_id, garantia_id, estado, tc_venta, tc_compra, total_usd, ganancia_usd, notas, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [genOrderId(), b.fecha, b.hora ?? null, b.cliente_id ?? null, b.cliente_cc_id ?? null, b.cliente_nombre ?? null,
       b.etiqueta_id ?? null, b.garantia_id ?? null, b.estado, b.tc_venta ?? null, b.tc_compra ?? null, totalUsd, gananciaUsd, b.notas ?? null, req.user.id]
    );
    const venta = vrows[0];

    // Stock: descontar solo si la venta retiene stock (no cancelada). Bloquea y valida disponibilidad.
    if (retieneStock(b.estado)) await descontarStock(client, b.items);
    // Ítems, pagos y canjes
    await insertarDetalle(client, venta, b);
    // Deuda de cuenta corriente (si corresponde)
    await sincronizarCuentaCorriente(client, venta);
    // Ingresos de caja por los pagos (Fase 2b)
    await syncVentaCaja(client, venta, req.user.id);
    // Cobros de tarjeta por los pagos con método tarjeta
    await syncTarjetaCobros(client, venta.id, venta.estado);

    await audit(client, 'ventas', 'INSERT', venta.id, { despues: venta, user_id: req.user.id });
    await client.query('COMMIT');
    invalidateMetricas();  // venta retail descontó stock
    res.status(201).json(venta);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', validate(updateVentaSchema), async (req, res, next) => {
  const b = req.body;
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) { client.release(); return res.status(400).json({ error: 'ID inválido' }); }

    await client.query('BEGIN');
    const { rows: beforeRows } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!beforeRows[0]) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ error: 'Venta no encontrada' }); }
    const before = beforeRows[0];

    const fullEdit = b.items !== undefined;
    const newEstado = b.estado ?? before.estado;
    const oldHolds = retieneStock(before.estado);
    const newHolds = retieneStock(newEstado);

    if (fullEdit) {
      const tc = b.tc_venta !== undefined ? b.tc_venta : before.tc_venta;
      const effClienteCc = b.cliente_cc_id !== undefined ? b.cliente_cc_id : before.cliente_cc_id;
      if (newHolds) { validarTc(b.items, b.pagos, tc); validarCuentaCorriente(b.pagos, effClienteCc); }
      // Reponer stock viejo (si retenía) y descontar el nuevo (si la venta sigue reteniendo)
      const { rows: oldItems } = await client.query('SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL', [id]);
      if (oldHolds) await reponerStock(client, oldItems);
      if (newHolds) await descontarStock(client, b.items);

      await client.query('DELETE FROM venta_items WHERE venta_id = $1', [id]);
      await client.query('DELETE FROM venta_pagos WHERE venta_id = $1', [id]);
      await client.query('DELETE FROM canjes WHERE venta_id = $1', [id]);

      const { totalUsd, gananciaUsd } = calcularTotales(b.items, tc);
      const { estado, etiqueta_id, garantia_id, cliente_id, cliente_cc_id, cliente_nombre, notas, hora } = b;
      const { rows: vrows } = await client.query(
        `UPDATE ventas SET
           estado = COALESCE($1, estado), etiqueta_id = COALESCE($2, etiqueta_id), garantia_id = COALESCE($3, garantia_id),
           cliente_id = COALESCE($4, cliente_id), cliente_cc_id = COALESCE($5, cliente_cc_id), cliente_nombre = COALESCE($6, cliente_nombre),
           notas = COALESCE($7, notas), hora = COALESCE($8, hora), tc_venta = $9, total_usd = $10, ganancia_usd = $11
         WHERE id = $12 RETURNING *`,
        [estado, etiqueta_id, garantia_id, cliente_id, cliente_cc_id, cliente_nombre, notas, hora, tc ?? null, totalUsd, gananciaUsd, id]
      );
      await insertarDetalle(client, vrows[0], { ...b, tc_venta: tc });
      await sincronizarCuentaCorriente(client, vrows[0]);
      await syncVentaCaja(client, vrows[0], req.user.id);
      // Re-derivar el comprobante de Financiera (cancelación, o quitar/agregar el pago financiera)
      await syncFinancieraComprobante(client, id, vrows[0].estado);
      await syncTarjetaCobros(client, id, vrows[0].estado);
      await audit(client, 'ventas', 'UPDATE', id, { antes: before, despues: vrows[0], user_id: req.user.id });
      await client.query('COMMIT');
      invalidateMetricas();  // edición completa pudo tocar stock
      return res.json(vrows[0]);
    }

    // ── Solo metadatos ── ajustar stock si cambia el "retener stock" (cancelar / reactivar)
    if (oldHolds && !newHolds) {
      const { rows: items } = await client.query('SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL', [id]);
      await reponerStock(client, items); // cancelación: liberar stock
    } else if (!oldHolds && newHolds) {
      const { rows: items } = await client.query('SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL', [id]);
      await descontarStock(client, items); // reactivación: re-descontar (valida disponibilidad)
    }
    const { estado, etiqueta_id, garantia_id, cliente_id, cliente_cc_id, cliente_nombre, notas, hora } = b;
    const { rows } = await client.query(
      `UPDATE ventas SET
         estado = COALESCE($1, estado), etiqueta_id = COALESCE($2, etiqueta_id), garantia_id = COALESCE($3, garantia_id),
         cliente_id = COALESCE($4, cliente_id), cliente_cc_id = COALESCE($5, cliente_cc_id), cliente_nombre = COALESCE($6, cliente_nombre),
         notas = COALESCE($7, notas), hora = COALESCE($8, hora)
       WHERE id = $9 RETURNING *`,
      [estado, etiqueta_id, garantia_id, cliente_id, cliente_cc_id, cliente_nombre, notas, hora, id]
    );
    await sincronizarCuentaCorriente(client, rows[0]);
    await syncVentaCaja(client, rows[0], req.user.id);
    // Re-derivar el comprobante de Financiera (cancelar / reactivar)
    await syncFinancieraComprobante(client, id, rows[0].estado);
    await syncTarjetaCobros(client, id, rows[0].estado);
    await audit(client, 'ventas', 'UPDATE', id, { antes: before, despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    invalidateMetricas();
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) { client.release(); return res.status(400).json({ error: 'ID inválido' }); }

    await client.query('BEGIN');
    const { rows: before } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ error: 'Venta no encontrada' }); }

    await revertirEfectosVenta(client, before[0]);
    await client.query('UPDATE ventas SET deleted_at = NOW() WHERE id = $1', [id]);
    await audit(client, 'ventas', 'DELETE', id, { antes: before[0], user_id: req.user.id });
    await client.query('COMMIT');
    invalidateMetricas();  // DELETE repuso stock
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
