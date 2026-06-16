const router = require('express').Router();
const crypto = require('crypto');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { toUsd, round2 } = require('../lib/money');
const { createCachedFetcherRedis } = require('../lib/cacheTtl');
// postCajaMovimiento / reverseCajaMovimientos: postear/revertir cajas para una venta
// los maneja lib/ventaSync.js; este archivo no los usa directamente, pero los dejamos
// disponibles a través del require por si una edición futura los necesita.
// (Eliminado: imports innecesarios detectados por ESLint.)
const { syncFinancieraComprobante } = require('../lib/financiera');
const { syncTarjetaCobros } = require('../lib/tarjetas');
const { revertirEfectosVenta } = require('../lib/cancelarVenta');
const { syncVentaCaja, sincronizarCuentaCorriente } = require('../lib/ventaSync');
// Tema C (2026-06-13): denormalizamos `ventas.comision_total_metodos` para
// descontar el costo financiero (tarjeta + financiera) de la ganancia bruta.
// El sync DEBE correr después de syncTarjetaCobros + syncFinancieraComprobante.
const { syncComisionTotalMetodos } = require('../lib/comisionesMetodos');
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
//
// P-06 (auditoría 2026-06-10): items y pagos pasaron a INSERT bulk con UNNEST
// (1 round-trip cada uno en vez de N). Para venta B2B con 50 items eso son
// 99 round-trips menos. Canjes NO bulkificados — el conditional INSERT de
// productos por canje + lookup del id devuelto (FK al canje) requiere lógica
// per-row que no se mapea limpio a UNNEST. Frecuencia chica (1-2 canjes por
// venta típica) → no vale la complejidad.
async function insertarDetalle(client, venta, b) {
  // Items: bulk INSERT con UNNEST.
  if (b.items && b.items.length > 0) {
    await client.query(
      `INSERT INTO venta_items
         (venta_id, producto_id, vendedor_id, descripcion, imei, cantidad,
          precio_vendido, precio_original, costo, moneda, comision, ganancia)
       SELECT $1, pid, vid, d, im, cant, pv, po, co, mo, cm, ga
         FROM UNNEST(
           $2::int[], $3::int[], $4::text[], $5::text[],
           $6::int[], $7::numeric[], $8::numeric[], $9::numeric[],
           $10::text[], $11::numeric[], $12::numeric[]
         ) AS u(pid, vid, d, im, cant, pv, po, co, mo, cm, ga)`,
      [
        venta.id,
        b.items.map(it => it.producto_id ?? null),
        b.items.map(it => it.vendedor_id ?? null),
        b.items.map(it => it.descripcion),
        b.items.map(it => it.imei ?? null),
        b.items.map(it => it.cantidad),
        b.items.map(it => it.precio_vendido),
        b.items.map(it => it.precio_original ?? null),
        b.items.map(it => it.costo),
        b.items.map(it => it.moneda),
        b.items.map(it => it.comision),
        b.items.map(it => round2((it.precio_vendido - it.costo) * it.cantidad - it.comision)),
      ]
    );
  }
  // Pagos: bulk INSERT con UNNEST. monto_usd se precalcula en JS (toUsd
  // depende del TC, no es portable a SQL puro sin replicar la lógica).
  if (b.pagos && b.pagos.length > 0) {
    await client.query(
      `INSERT INTO venta_pagos
         (venta_id, metodo_pago_id, metodo_nombre, monto, moneda, tc, monto_usd, es_cuenta_corriente)
       SELECT $1, mpid, mnom, m, mo, t, mu, ecc
         FROM UNNEST(
           $2::int[], $3::text[], $4::numeric[], $5::text[],
           $6::numeric[], $7::numeric[], $8::boolean[]
         ) AS u(mpid, mnom, m, mo, t, mu, ecc)`,
      [
        venta.id,
        b.pagos.map(p => p.metodo_pago_id ?? null),
        b.pagos.map(p => p.metodo_nombre),
        b.pagos.map(p => p.monto),
        b.pagos.map(p => p.moneda),
        b.pagos.map(p => p.tc ?? null),
        b.pagos.map(p => round2(toUsd(p.monto, p.moneda, p.tc ?? b.tc_venta))),
        b.pagos.map(p => !!p.es_cuenta_corriente),
      ]
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

// P-05 (auditoría 2026-06-10): cache TTL 30s por par (desde, hasta).
//
// El dashboard de ventas dispara 11 queries agregadas en paralelo en cada
// request y se carga al entrar a la home → es el endpoint más caliente del
// portal. A 30s de TTL un mismo par (desde, hasta) que reciba N requests
// concurrentes paga UNA query bundle y los demás reutilizan el resultado.
//
// 2026-06-12 P-04 Fase 3.5: cache movido de in-memory local a Redis cross-
// instance. Cuando un usuario hit la réplica A y otro hit la réplica B con
// los mismos filtros, AHORA reusan el mismo resultado cacheado en Redis.
// La key Redis usa el mismo formato `cache:ventas:dashboard:{desde}|{hasta}`.
//
// Trade-off de invalidación (sin cambios respecto a la versión local): NO
// invalidamos manualmente desde POST/PUT/DELETE. Razones:
//   (a) 30s es staleness aceptable para KPIs de dashboard (Lucas no monitorea
//       al seg, mira para reporting).
//   (b) El cableado cross-route sería invasivo (8+ call sites) por un gain
//       marginal sobre los 30s de TTL.
// Si en el futuro se quiere "ver dashboard actualizado YA después de cerrar
// venta", agregar invalidación post-COMMIT en los 8 callsites (POST/PUT/
// DELETE ventas + egresos + movimientos). Con Redis ya migrado, la
// invalidación cross-instance es 1 línea.
//
// LRU cap: el operador puede mover los filtros de fecha libremente; cada par
// distinto retiene una closure con cache state. Acotamos a 100 entradas
// (~3 meses de pares día-por-día) y evictamos la más vieja.
//
// 2026-06-15 multi-tenant (PR 4.2): la key del cache pasa a ser
// `{tenantId}|{desde}|{hasta}` — DEBE incluir el tenant para que datos de
// distintos clientes NO crossan. Si dos tenants miran el mismo rango de
// fecha, cada uno tiene su propia entrada en Redis + Map local.
const DASHBOARD_TTL_MS = 30_000;
const DASHBOARD_MAX_FETCHERS = 100;
const dashboardFetchers = new Map();
function getDashboardFetcher(tenantId, desde, hasta) {
  const key = `${tenantId}|${desde}|${hasta}`;
  let fn = dashboardFetchers.get(key);
  if (fn) {
    dashboardFetchers.delete(key);
    dashboardFetchers.set(key, fn);
    return fn;
  }
  fn = createCachedFetcherRedis(
    `cache:ventas:dashboard:${key}`,
    DASHBOARD_TTL_MS,
    () => computeDashboard(tenantId, desde, hasta)
  );
  dashboardFetchers.set(key, fn);
  if (dashboardFetchers.size > DASHBOARD_MAX_FETCHERS) {
    const oldestKey = dashboardFetchers.keys().next().value;
    dashboardFetchers.delete(oldestKey);
  }
  return fn;
}

async function computeDashboard(tenantId, desde, hasta) {
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

    // 2026-06-15 multi-tenant (PR 4.2): el bundle de 11 queries del dashboard
    // corre dentro de UNA tx con app.current_tenant seteado vía withTenant.
    // RLS filtra automáticamente cada tabla involucrada (ventas, venta_items,
    // venta_pagos, canjes, egresos, movimientos_cc, items_movimiento_cc,
    // productos, vendedores, etiquetas). El Promise.all sigue siendo dentro
    // de un solo client → todas las queries comparten el mismo SET LOCAL.
    const [totales, pagos, unidades, canjes, egresos, dif, horario, etiquetas, topProd, topVend, b2b] = await db.withTenant(tenantId, async (client) => Promise.all([
      // Totales de ventas. 2026-06-10: `ganancia_acreditada_usd` agrega FILTER
      // por estado='acreditado' — alimenta la GANANCIA NETA del dashboard, que
      // ahora suma SOLO ventas confirmadas (las pendientes no descuentan
      // egresos hasta que pasen a acreditadas). Total bruto (todas) queda
      // disponible aparte en `ganancia_bruta_usd` para el desglose.
      //
      // Tema C.3 (2026-06-13): sumamos también `comision_total_metodos`
      // (denormalizada en C.1, backfill en C.2). Es el costo financiero retenido
      // por el método de pago (tarjeta + transferencia) que antes inflaba la
      // ganancia bruta — la cascada del KPI ahora es:
      //     bruta_acreditada − costo_financiero_acreditado − egresos = neta
      client.query(`SELECT
                  COUNT(*) AS count,
                  COALESCE(SUM(total_usd),0)                                                AS ingresos_usd,
                  COALESCE(SUM(ganancia_usd),0)                                             AS ganancia_bruta_usd,
                  COALESCE(SUM(ganancia_usd) FILTER (WHERE estado='acreditado'),0)          AS ganancia_acreditada_usd,
                  COALESCE(SUM(comision_total_metodos),0)                                   AS costo_financiero_usd,
                  COALESCE(SUM(comision_total_metodos) FILTER (WHERE estado='acreditado'),0) AS costo_financiero_acreditado_usd
                FROM ventas v WHERE ${BASE}`, p),
      // Por método de pago (monto en moneda original + equivalente USD)
      client.query(`SELECT pp.metodo_nombre, pp.moneda, COALESCE(SUM(pp.monto),0) AS total, COALESCE(SUM(pp.monto_usd),0) AS total_usd, COUNT(*) AS n
                FROM venta_pagos pp JOIN ventas v ON v.id = pp.venta_id WHERE ${BASE}
                GROUP BY pp.metodo_nombre, pp.moneda ORDER BY total_usd DESC`, p),
      // Unidades por clase + costos en USD
      client.query(`SELECT
                  COALESCE(SUM(vi.cantidad) FILTER (WHERE pr.clase = 'celular' OR pr.id IS NULL),0) AS celulares,
                  COALESCE(SUM(vi.cantidad) FILTER (WHERE pr.clase = 'accesorio'),0) AS accesorios,
                  COALESCE(SUM(CASE WHEN vi.moneda = 'ARS' AND v.tc_venta > 0 THEN vi.costo*vi.cantidad/v.tc_venta ELSE vi.costo*vi.cantidad END),0) AS costos_usd
                FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id LEFT JOIN productos pr ON pr.id = vi.producto_id WHERE ${BASE}`, p),
      // Inversión en canjes (USD)
      client.query(`SELECT COALESCE(SUM(CASE WHEN c.moneda = 'ARS' AND v.tc_venta > 0 THEN c.valor_toma/v.tc_venta ELSE c.valor_toma END),0) AS canjes_usd
                FROM canjes c JOIN ventas v ON v.id = c.venta_id WHERE ${BASE}`, p),
      // Egresos del período (USD)
      client.query(`SELECT COALESCE(SUM(monto_usd),0) AS egresos_usd FROM egresos WHERE deleted_at IS NULL AND estado = 'pagado' AND fecha >= $1 AND fecha <= $2`, p),
      // Diferencias de pago (sobrepagos / faltantes) — CTEs pre-agregadas (sin subqueries correlacionadas)
      client.query(`WITH bv AS (
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
      client.query(`SELECT EXTRACT(HOUR FROM v.hora)::int AS hora, COUNT(*) AS n FROM ventas v WHERE ${BASE} AND v.hora IS NOT NULL GROUP BY 1 ORDER BY 1`, p),
      // Ventas por etiqueta
      client.query(`SELECT COALESCE(e.nombre,'Sin etiqueta') AS etiqueta, COUNT(*) AS n FROM ventas v LEFT JOIN etiquetas e ON e.id = v.etiqueta_id WHERE ${BASE} GROUP BY 1 ORDER BY n DESC`, p),
      // Top productos (por unidades): UNION retail + B2B. Items B2B devueltos
      // (devuelto_at IS NOT NULL) NO cuentan — la unidad volvió al stock.
      client.query(`
        WITH all_items AS (
          SELECT vi.descripcion, vi.cantidad
            FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
            WHERE ${BASE}
          UNION ALL
          SELECT COALESCE(NULLIF(TRIM(i.producto), ''), '(sin nombre)') AS descripcion,
                 COALESCE(i.cantidad, 1)
            FROM items_movimiento_cc i JOIN movimientos_cc m ON m.id = i.movimiento_cc_id
            WHERE ${B2B_BASE} AND i.devuelto_at IS NULL
        )
        SELECT descripcion, SUM(cantidad)::int AS unidades
        FROM all_items
        GROUP BY descripcion
        ORDER BY unidades DESC, descripcion
        LIMIT 5
      `, p),
      // Top vendedores (por total facturado en USD)
      client.query(`SELECT ve.nombre AS vendedor,
                       COALESCE(SUM(CASE WHEN vi.moneda='ARS' AND v.tc_venta>0 THEN vi.precio_vendido*vi.cantidad/v.tc_venta ELSE vi.precio_vendido*vi.cantidad END),0) AS total_usd,
                       COUNT(*)::int AS items
                FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN vendedores ve ON ve.id = vi.vendedor_id
                WHERE ${BASE} GROUP BY ve.nombre ORDER BY total_usd DESC LIMIT 5`, p),
      // B2B: ventas via movimientos_cc (junio 2026). count + ingresos +
      // costos + ganancia + unidades por clase. Asumimos costos en USD.
      //
      // 2026-06-09: items devueltos (i.devuelto_at IS NOT NULL) NO suman a
      // ingresos/costos/unidades — la mercadería volvió al stock y el monto
      // se restó del saldo del cliente. Es como si esa porción de la venta
      // nunca hubiera ocurrido para fines de KPI del período.
      //
      // El `count` cuenta movimientos con AL MENOS un item vivo (no devuelto).
      // Una venta con todos sus items devueltos no aparece en los totales.
      //
      // 2026-06-10: `ingresos_acreditado_usd` y `costos_acreditado_usd` agregan
      // FILTER por m.estado='acreditado'. Alimentan la GANANCIA NETA del
      // dashboard — pendientes no cuentan hasta que pasen a acreditadas.
      client.query(`
        SELECT
          COUNT(DISTINCT m.id) FILTER (WHERE i.devuelto_at IS NULL)::int                            AS count,
          COALESCE(SUM(i.valor)             FILTER (WHERE i.devuelto_at IS NULL), 0)                AS ingresos_usd,
          COALESCE(SUM(i.costo_unit * i.cantidad) FILTER (WHERE i.devuelto_at IS NULL), 0)          AS costos_usd,
          COALESCE(SUM(i.valor)             FILTER (WHERE i.devuelto_at IS NULL AND m.estado = 'acreditado'), 0) AS ingresos_acreditado_usd,
          COALESCE(SUM(i.costo_unit * i.cantidad) FILTER (WHERE i.devuelto_at IS NULL AND m.estado = 'acreditado'), 0) AS costos_acreditado_usd,
          COALESCE(SUM(i.cantidad) FILTER (WHERE pr.clase = 'celular'   AND i.devuelto_at IS NULL), 0)::int AS celulares,
          COALESCE(SUM(i.cantidad) FILTER (WHERE pr.clase = 'accesorio' AND i.devuelto_at IS NULL), 0)::int AS accesorios
        FROM movimientos_cc m
        LEFT JOIN items_movimiento_cc i ON i.movimiento_cc_id = m.id
        LEFT JOIN productos pr ON pr.id = i.producto_id
        WHERE ${B2B_BASE}
      `, p),
    ]));

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

    // 2026-06-10: GANANCIA NETA suma SOLO ventas en estado='acreditado'.
    // Las pendientes (ej. Lucas todavía no confirmó cobro) no impactan en
    // este KPI hasta que el operador las marque como acreditadas. Aplica a
    // ambos retail y B2B.
    const gananciaAcreditadaRetail = Number(t.ganancia_acreditada_usd) || 0;
    const b2bGananciaAcreditadaUsd = round2(
      (Number(b.ingresos_acreditado_usd) || 0) - (Number(b.costos_acreditado_usd) || 0)
    );
    const gananciaBrutaAcreditada = gananciaAcreditadaRetail + b2bGananciaAcreditadaUsd;

    // Tema C.3 (2026-06-13): costo financiero retenido por método de pago.
    // Solo afecta retail — las ventas B2B cobran en CC y no usan tarjetas/transf
    // con comisión (si en el futuro un cliente B2B paga con tarjeta, el modelo
    // hay que extenderlo a movimientos_cc, pero hoy no aplica).
    //
    // El total (todas las ventas) alimenta el desglose visual. El acreditado
    // alimenta la cascada de ganancia neta — mismo principio que la ganancia:
    // las pendientes no impactan KPI hasta confirmarse.
    const costoFinancieroRetail            = Number(t.costo_financiero_usd) || 0;
    const costoFinancieroAcreditadoRetail  = Number(t.costo_financiero_acreditado_usd) || 0;
    const costoFinanciero                  = costoFinancieroRetail;  // alias por simetría con el resto de KPIs
    const costoFinancieroAcreditado        = costoFinancieroAcreditadoRetail;

    // Cascada GANANCIA NETA (2026-06-13):
    //     bruta_acreditada − costo_financiero_acreditado − egresos
    // El costo financiero (comisión de tarjetas y transferencias) NO estaba
    // descontado antes — la "ganancia neta" salía inflada. Tema C lo cierra.
    const gananciaNeta = round2(gananciaBrutaAcreditada - costoFinancieroAcreditado - egresosUsd);
    // Margen sigue calculado sobre ingresos totales del período (denominador
    // consistente con cómo se mostraba antes; cambiar a "ingresos_acreditados"
    // si Lucas quiere más adelante).
    const margenPct = ingresosVentas > 0 ? round2((gananciaNeta / ingresosVentas) * 100) : 0;

    return {
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
      // 2026-06-10: ganancia bruta restringida a ventas acreditadas (es la
      // base de la ganancia neta). El total bruto sigue arriba para el
      // desglose y comparativas.
      ganancia_bruta_acreditada_usd: round2(gananciaBrutaAcreditada),
      // Tema C.3 (2026-06-13): costo financiero retenido por método de pago
      // (tarjeta + transferencia). Se descuenta de la ganancia neta. El total
      // (todas las ventas) alimenta el desglose visual; el acreditado alimenta
      // la cascada del KPI.
      costo_financiero_usd: round2(costoFinanciero),
      costo_financiero_acreditado_usd: round2(costoFinancieroAcreditado),
      egresos_usd: round2(egresosUsd),
      ganancia_neta_usd: gananciaNeta,
      margen_pct: margenPct,
      costos_usd: round2(costosRetailUsd + b2bCostosUsd),
      // Desglose retail vs B2B para que el frontend pueda discriminar.
      retail: {
        count: parseInt(t.count),
        ingresos_usd: round2(ingresosVentasRetail),
        ganancia_bruta_usd: round2(gananciaBrutaRetail),
        costo_financiero_usd: round2(costoFinancieroRetail),
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
    };
}

router.get('/dashboard', validate(queryDashboardSchema, 'query'), async (req, res, next) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const desde = req.query.desde || hoy;
    const hasta = req.query.hasta || hoy;
    const data = await getDashboardFetcher(req.tenantId, desde, hasta)();
    res.json(data);
  } catch (err) { next(err); }
});

/* ═══════════════════════ VENTAS ═══════════════════════ */

// GET /api/ventas — listado unificado retail + B2B (cuentas corrientes).
//
// 2026-06-09: ahora incluye las ventas B2B (movimientos_cc tipo='compra'),
// mapeadas al mismo shape que las retail. Lucas pidió ver "una venta más" en
// la grilla, sin tener que cambiar de pantalla para ver lo vendido por CC.
// Cada fila B2B trae:
//   - `origen: 'b2b'` (retail usa 'retail') — discriminador para el frontend
//   - `order_id: 'B2B-{id}'` — etiqueta visual
//   - `estado`: 'acreditado' (default) o 'pendiente'. El operador alterna
//     desde la grilla con el mismo selector que usa retail; el flag es
//     visual e independiente del saldo del cliente (2026-06-10).
//   - `etiqueta_nombre: 'B2B'` — badge visual
//   - `items[]` derivados de items_movimiento_cc con el mismo shape
//   - `pagos[]` derivados del caja_movimiento asociado (si tuvo caja_id)
//   - `canjes: []`, `comprobantes_count: 0` (no aplica)
//
// P-01 (auditoría 2026-06-10): paginación a nivel SQL con UNION ALL.
//
// Antes: dos queries cargaban TODAS las filas filtradas (retail + B2B) con
// items/pagos/canjes en JSON aggregates, se combinaban y ordenaban en JS, y
// recién ahí se aplicaba slice(offset, offset+limit). A 50k+ ventas eso son
// muchos MB transferidos por request + segundos de CPU en JS para una página
// de 50 filas.
//
// Ahora: 3 pasos.
//   (1) "page IDs": SELECT id, origen, fecha de UNION ALL retail+b2b filtrado,
//       ORDER BY fecha DESC, id DESC, LIMIT + OFFSET. Solo trae los IDs de la
//       página. Mismo paso devuelve también el COUNT(*) total para el header.
//   (2) Si hay IDs retail en la página → fetch detalles retail con WHERE id =
//       ANY($1). Misma query enriquecida que antes (items/pagos/canjes JSON).
//   (3) Si hay IDs B2B en la página → fetch detalles B2B con WHERE m.id =
//       ANY($1). Mismo mapeo que antes.
//
// Pasos 2 y 3 corren en paralelo. El sort final se hace en JS, pero ahora
// sobre N=limit filas, no sobre toda la tabla.
router.get('/', validate(queryVentasSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, estado, etiqueta_id, buscar } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    // ── Step 1: build the UNION ALL of (id, origen, fecha) for pagination ──
    // Filtros retail
    const condR = ['v.deleted_at IS NULL'];
    const paramsR = [];
    if (desde)       { paramsR.push(desde);       condR.push(`v.fecha >= $${paramsR.length}`); }
    if (hasta)       { paramsR.push(hasta);       condR.push(`v.fecha <= $${paramsR.length}`); }
    if (estado)      { paramsR.push(estado);      condR.push(`v.estado = $${paramsR.length}`); }
    if (etiqueta_id) { paramsR.push(etiqueta_id); condR.push(`v.etiqueta_id = $${paramsR.length}`); }
    if (buscar) {
      paramsR.push(`%${buscar}%`);
      condR.push(`(v.order_id ILIKE $${paramsR.length} OR v.cliente_nombre ILIKE $${paramsR.length}
                   OR EXISTS (SELECT 1 FROM venta_items vi WHERE vi.venta_id = v.id AND (vi.descripcion ILIKE $${paramsR.length} OR vi.imei ILIKE $${paramsR.length})))`);
    }
    const whereR = condR.join(' AND ');

    // Filtros B2B. Skipea cuando filtros lo descartan.
    const skipB2B = (etiqueta_id != null && etiqueta_id !== '') ||
                    (estado && !['acreditado', 'pendiente'].includes(estado));
    const condB = [
      `m.deleted_at IS NULL`,
      `m.tipo = 'compra'`,
      `c.deleted_at IS NULL`,
    ];
    const paramsB = [];
    if (estado && ['acreditado', 'pendiente'].includes(estado)) {
      paramsB.push(estado);
      condB.push(`m.estado = $${paramsB.length}`);
    }
    if (desde) { paramsB.push(desde); condB.push(`m.fecha >= $${paramsB.length}`); }
    if (hasta) { paramsB.push(hasta); condB.push(`m.fecha <= $${paramsB.length}`); }
    if (buscar) {
      paramsB.push(`%${buscar}%`);
      condB.push(`(c.nombre ILIKE $${paramsB.length} OR c.apellido ILIKE $${paramsB.length}
                   OR ('B2B-' || m.id) ILIKE $${paramsB.length}
                   OR EXISTS (SELECT 1 FROM items_movimiento_cc i WHERE i.movimiento_cc_id = m.id
                              AND (i.producto ILIKE $${paramsB.length} OR i.imei_serial ILIKE $${paramsB.length})))`);
    }
    const whereB = condB.join(' AND ');

    // El UNION ALL combina los parámetros: primero todos los de retail, luego
    // los de B2B re-numerados. Se ejecutan dos veces en la misma query (count
    // y page), pero los offsets de numeración son los mismos en ambos casos.
    // Empaquetamos: [...paramsR, ...paramsB, limit, offset] al final.
    const offsetB = paramsR.length;
    const whereBOffset = whereB.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offsetB}`);

    const retailRowSql = `
      SELECT v.id::int AS id, 'retail'::text AS origen, v.fecha::date AS fecha
      FROM ventas v
      WHERE ${whereR}
    `;
    const b2bRowSql = `
      SELECT m.id::int AS id, 'b2b'::text AS origen, m.fecha::date AS fecha
      FROM movimientos_cc m
      JOIN clientes_cc c ON c.id = m.cliente_cc_id
      WHERE ${whereBOffset}
    `;
    // UNION ALL (no UNION) — no hay solapamiento posible entre retail y B2B
    // por origen, así que ahorramos el DISTINCT implícito.
    const unionSql = skipB2B
      ? retailRowSql
      : `${retailRowSql}\n      UNION ALL\n      ${b2bRowSql}`;
    const unionParams = skipB2B ? paramsR : [...paramsR, ...paramsB];

    // Lanzamos count y page en paralelo.
    const countSql = `SELECT COUNT(*)::int AS n FROM (${unionSql}) u`;
    const pageSql = `
      SELECT id, origen, fecha
      FROM (${unionSql}) u
      ORDER BY fecha DESC, id DESC
      LIMIT $${unionParams.length + 1} OFFSET $${unionParams.length + 2}
    `;
    const pageParams = [...unionParams, limit, offset];

    // 2026-06-15 multi-tenant (PR 4.2): toda la lectura (count + page + detalle
    // retail + detalle B2B) en UNA tx con app.current_tenant. Mantenemos los
    // dos Promise.all en paralelo, ambos compartiendo el mismo client. RLS
    // filtra ventas, movimientos_cc, items_movimiento_cc, venta_items,
    // venta_pagos, canjes, envios y etiquetas automáticamente.
    const { total, data } = await db.withTenant(req.tenantId, async (client) => {
      const [countRes, pageRes] = await Promise.all([
        client.query(countSql, unionParams),
        client.query(pageSql, pageParams),
      ]);
      const total = countRes.rows[0].n;
      const pageRows = pageRes.rows; // [{ id, origen, fecha }, ...] ya ordenado

      // Particionar IDs por origen para fetch en paralelo.
      const retailIds = pageRows.filter(r => r.origen === 'retail').map(r => r.id);
      const b2bIds    = pageRows.filter(r => r.origen === 'b2b').map(r => r.id);

      // ── Step 2 + 3: fetch detalles solo para los IDs de la página ──
      // Retail: misma estructura que la query original, pero con WHERE id = ANY.
      const retailDetalleSql = `
        SELECT v.*, e.nombre AS etiqueta_nombre, e.color AS etiqueta_color,
          COALESCE((SELECT json_agg(i ORDER BY i.id) FROM venta_items i WHERE i.venta_id = v.id), '[]') AS items,
          COALESCE((SELECT json_agg(p ORDER BY p.id) FROM venta_pagos p WHERE p.venta_id = v.id), '[]') AS pagos,
          COALESCE((SELECT json_agg(c ORDER BY c.id) FROM canjes c WHERE c.venta_id = v.id), '[]') AS canjes,
          COALESCE((SELECT COUNT(*) FROM venta_comprobantes vc WHERE vc.venta_id = v.id AND vc.deleted_at IS NULL), 0) AS comprobantes_count,
          (SELECT json_build_object('id', env.id, 'estado', env.estado)
             FROM envios env WHERE env.venta_id = v.id AND env.deleted_at IS NULL LIMIT 1) AS envio
        FROM ventas v
        LEFT JOIN etiquetas e ON e.id = v.etiqueta_id
        WHERE v.id = ANY($1::int[])
      `;
      const b2bDetalleSql = `
        SELECT
          ('b2b-' || m.id)                                                    AS id_str,
          m.id::int                                                           AS id_num,
          m.fecha,
          NULL::time                                                          AS hora,
          TRIM(COALESCE(c.nombre,'') || ' ' || COALESCE(c.apellido,''))       AS cliente_nombre,
          m.descripcion                                                       AS notas,
          m.estado                                                            AS estado,
          ('B2B-' || LPAD(m.id::text, 6, '0'))                                AS order_id,
          ROUND(COALESCE((
            SELECT SUM(i.valor) FROM items_movimiento_cc i
              WHERE i.movimiento_cc_id = m.id AND i.devuelto_at IS NULL
          ), 0)::numeric, 2)                                                  AS total_usd,
          ROUND(
            (COALESCE((
              SELECT SUM(i.valor) FROM items_movimiento_cc i
                WHERE i.movimiento_cc_id = m.id AND i.devuelto_at IS NULL
            ), 0)
            - COALESCE((
              SELECT SUM(COALESCE(i.costo_unit,0) * COALESCE(i.cantidad,1))
                FROM items_movimiento_cc i
                WHERE i.movimiento_cc_id = m.id AND i.devuelto_at IS NULL
            ), 0))::numeric, 2
          )                                                                   AS ganancia_usd,
          m.cliente_cc_id,
          m.caja_id,
          m.created_by_user_id,
          m.created_at,
          COALESCE((
            SELECT json_agg(json_build_object(
              'id',              i.id,
              'descripcion',     COALESCE(i.producto, ''),
              'cantidad',        COALESCE(i.cantidad, 1),
              'imei',            i.imei_serial,
              'producto_id',     i.producto_id,
              'precio_vendido',  i.valor,
              'precio_original', i.valor,
              'costo',           i.costo_unit,
              'moneda',          COALESCE(i.costo_moneda, 'USD'),
              'devuelto_at',     i.devuelto_at
            ) ORDER BY i.id)
              FROM items_movimiento_cc i WHERE i.movimiento_cc_id = m.id
          ), '[]'::json)                                                      AS items
        FROM movimientos_cc m
        JOIN clientes_cc c ON c.id = m.cliente_cc_id
        WHERE m.id = ANY($1::int[])
      `;

      const [retailDetalleRes, b2bDetalleRes] = await Promise.all([
        retailIds.length ? client.query(retailDetalleSql, [retailIds]) : Promise.resolve({ rows: [] }),
        b2bIds.length    ? client.query(b2bDetalleSql,    [b2bIds])    : Promise.resolve({ rows: [] }),
      ]);

      // Indexar por id para hacer el "lookup" en orden de pageRows.
      const retailById = new Map(retailDetalleRes.rows.map(v => [Number(v.id), v]));
      const b2bById    = new Map(b2bDetalleRes.rows.map(r => [Number(r.id_num), r]));

      // Mapear B2B al shape unificado (mismas keys que retail).
      const mapB2B = (r) => ({
        id:               r.id_str,
        origen:           'b2b',
        order_id:         r.order_id,
        fecha:            r.fecha,
        hora:             r.hora,
        cliente_nombre:   r.cliente_nombre || '—',
        cliente_cc_id:    r.cliente_cc_id,
        estado:           r.estado,
        total_usd:        Number(r.total_usd) || 0,
        ganancia_usd:     Number(r.ganancia_usd) || 0,
        etiqueta_id:      null,
        etiqueta_nombre:  'B2B',
        etiqueta_color:   '#6b7cff',
        items:            r.items || [],
        pagos:            [],
        canjes:           [],
        comprobantes_count: 0,
        notas:            r.notas,
        caja_id:          r.caja_id,
        created_by_user_id: r.created_by_user_id,
        created_at:       r.created_at,
        _b2b_mov_id:      r.id_num,
      });

      // Componer la respuesta en el orden devuelto por la query de paginación.
      const data = pageRows
        .map(pr => {
          if (pr.origen === 'retail') {
            const v = retailById.get(pr.id);
            return v ? { ...v, origen: 'retail' } : null;
          }
          const r = b2bById.get(pr.id);
          return r ? mapB2B(r) : null;
        })
        .filter(Boolean);

      return { total, data };
    });

    res.json(paginatedResponse(data, total, { page, limit }));
  } catch (err) { next(err); }
});

router.post('/', validate(createVentaSchema), async (req, res, next) => {
  const b = req.body;
  const client = await db.connect();
  try {
    validarTc(b.items, b.pagos, b.tc_venta);
    validarCuentaCorriente(b.pagos, b.cliente_cc_id);
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
    // Tema C: denormalizar el costo financiero total (tarjeta + transf) en
    // ventas.comision_total_metodos. DEBE ir DESPUÉS de los 2 syncs anteriores
    // porque lee de tarjeta_movimientos + comprobantes ya escritos.
    venta.comision_total_metodos = await syncComisionTotalMetodos(client, venta.id);

    await audit(client, 'ventas', 'INSERT', venta.id, { despues: venta, user_id: req.user.id });
    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);  // venta retail descontó stock
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
    // 2026-06-10 P-15: no llamamos client.release() acá — el `finally` lo hace.
    // El doble-release tira warning en node-pg y puede botar la conexión del pool.
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: beforeRows } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!beforeRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada' }); }
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
      // Tema C: re-derivar comision_total_metodos a partir del estado post-syncs.
      vrows[0].comision_total_metodos = await syncComisionTotalMetodos(client, id);
      await audit(client, 'ventas', 'UPDATE', id, { antes: before, despues: vrows[0], user_id: req.user.id });
      await client.query('COMMIT');
      invalidateMetricas(req.tenantId);  // edición completa pudo tocar stock
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
    // Tema C: re-derivar comision_total_metodos (cancelar la venta vacía la
    // columna porque revertirEfectosVenta soft-deletea las filas fuente).
    rows[0].comision_total_metodos = await syncComisionTotalMetodos(client, id);
    await audit(client, 'ventas', 'UPDATE', id, { antes: before, despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);
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
    // 2026-06-10 P-15: dejamos que el finally release. Doble-release ensucia logs.
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada' }); }

    await revertirEfectosVenta(client, before[0]);
    // Tema C: vaciar comision_total_metodos (las filas fuente quedaron soft-
    // deleted). La fila ventas se soft-deletea acto seguido, pero mantener el
    // invariante (columna = 0 cuando no hay filas fuente activas) ayuda al
    // backfill y a cualquier auditoría futura sobre la columna.
    await syncComisionTotalMetodos(client, id);
    await client.query('UPDATE ventas SET deleted_at = NOW() WHERE id = $1', [id]);
    await audit(client, 'ventas', 'DELETE', id, { antes: before[0], user_id: req.user.id });
    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);  // DELETE repuso stock
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
