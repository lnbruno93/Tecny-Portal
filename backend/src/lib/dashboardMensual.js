// Agregador de KPIs por período para el Dashboard de Resumen Mensual.
//
// Diseño: una función `kpisDelPeriodo(client?, desde, hasta, fechaCorte)` que
// dispara todas las queries en paralelo (Promise.all) y devuelve el bundle JSON.
// El endpoint la llama dos veces (período actual + período a comparar) y
// devuelve { actual, comparado } sin calcular deltas — los calcula el front.
//
// Convención de fechas:
//   - desde/hasta: rango ISO YYYY-MM-DD que define el período (mes calendario).
//   - fechaCorte: punto en el tiempo para snapshots puntuales (cajas, deudas).
//     Habitualmente = hasta. Permite "saldo de cajas AL fin del período".
//
// Multi-tenant 2026-06-16: las funciones aceptan opcionalmente un `client`
// (PG client tx-scoped con `SET LOCAL app.current_tenant`) como PRIMER
// argumento. Si no viene, caen al pool global `db` para compat con jobs/crons.
// El detector de "primer arg es client" mira si tiene `.query` (duck typing).
//
// Cache: el endpoint lo wrappea con createCachedFetcherRedis TTL 60s por key
// del par (tenant, periodo, comparado).

const db = require('../config/database');
const { toUsd, round2 } = require('./money');

// Duck-type para distinguir un pg Client/PoolClient del pool global. Si el
// primer arg tiene .query (es decir, parece un Client o el pool mismo) Y NO
// es un string/Date, lo tratamos como client. Los args válidos (desde, hasta,
// fechaCorte, limit) son strings o numbers — nunca objetos con .query.
function _resolveExec(maybeClient, args) {
  if (maybeClient
      && typeof maybeClient === 'object'
      && !(maybeClient instanceof Date)
      && typeof maybeClient.query === 'function') {
    return { exec: maybeClient, restArgs: args };
  }
  return { exec: db, restArgs: [maybeClient, ...args] };
}

// ──────────────────────────────────────────────────────────────────────
// VENTAS — totales del período
// ──────────────────────────────────────────────────────────────────────

async function ventasAgregadas(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta] = restArgs;
  const { rows } = await exec.query(
    `SELECT
       COUNT(*) FILTER (WHERE estado <> 'cancelado')                                                      AS cant_ventas,
       COALESCE(SUM(total_usd)    FILTER (WHERE estado <> 'cancelado'), 0)                                AS ventas_usd,
       COALESCE(SUM(ganancia_usd) FILTER (WHERE estado <> 'cancelado'), 0)                                AS ganancia_usd,
       COALESCE(AVG(total_usd)    FILTER (WHERE estado <> 'cancelado' AND total_usd > 0), 0)              AS ticket_promedio_usd
     FROM ventas
     WHERE fecha BETWEEN $1 AND $2 AND deleted_at IS NULL`,
    [desde, hasta]
  );
  return {
    cant_ventas:         Number(rows[0].cant_ventas) || 0,
    ventas_usd:          round2(rows[0].ventas_usd),
    ganancia_usd:        round2(rows[0].ganancia_usd),
    ticket_promedio_usd: round2(rows[0].ticket_promedio_usd),
  };
}

async function topProductos(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, limit = 5] = restArgs;
  const { rows } = await exec.query(
    `SELECT vi.descripcion AS producto, SUM(vi.cantidad)::int AS cantidad,
            COALESCE(SUM(vi.precio_vendido * vi.cantidad
              / NULLIF(CASE WHEN v.tc_venta > 0 THEN v.tc_venta ELSE 1 END, 0)), 0) AS total_usd
       FROM venta_items vi
       JOIN ventas v ON v.id = vi.venta_id
      WHERE v.fecha BETWEEN $1 AND $2
        AND v.estado <> 'cancelado' AND v.deleted_at IS NULL
        AND vi.descripcion IS NOT NULL
      GROUP BY vi.descripcion
      ORDER BY cantidad DESC
      LIMIT $3`,
    [desde, hasta, limit]
  );
  return rows.map(r => ({ ...r, total_usd: round2(r.total_usd) }));
}

async function topVendedores(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, limit = 5] = restArgs;
  const { rows } = await exec.query(
    `SELECT vd.nombre AS vendedor,
            COUNT(DISTINCT v.id)::int AS ventas,
            COALESCE(SUM(vi.precio_vendido * vi.cantidad
              / NULLIF(CASE WHEN v.tc_venta > 0 THEN v.tc_venta ELSE 1 END, 0)), 0) AS total_usd
       FROM venta_items vi
       JOIN ventas v       ON v.id = vi.venta_id
       JOIN vendedores vd  ON vd.id = vi.vendedor_id
      WHERE v.fecha BETWEEN $1 AND $2
        AND v.estado <> 'cancelado' AND v.deleted_at IS NULL
      GROUP BY vd.id, vd.nombre
      ORDER BY total_usd DESC
      LIMIT $3`,
    [desde, hasta, limit]
  );
  return rows.map(r => ({ ...r, total_usd: round2(r.total_usd) }));
}

async function pagosPorMetodo(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta] = restArgs;
  // 2026-06-10 S-19: Bug numérico. Antes el CASE solo distinguía 'USD' → cuando
  // venía 'USDT' caía al WHEN v.tc_venta > 0 y dividía por el TC ARS, dando
  // un monto subdimensionado por ~1000×. USDT debe tratarse 1:1 con USD.
  const { rows } = await exec.query(
    `SELECT mp.nombre AS metodo, mp.moneda,
            COALESCE(SUM(vp.monto / NULLIF(
              CASE
                WHEN vp.moneda IN ('USD','USDT') THEN 1
                WHEN v.tc_venta > 0              THEN v.tc_venta
                ELSE 1
              END, 0)), 0) AS total_usd
       FROM venta_pagos vp
       JOIN ventas v       ON v.id = vp.venta_id
       JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
      WHERE v.fecha BETWEEN $1 AND $2
        AND v.estado <> 'cancelado' AND v.deleted_at IS NULL
        AND vp.metodo_pago_id IS NOT NULL
      GROUP BY mp.id, mp.nombre, mp.moneda
      ORDER BY total_usd DESC`,
    [desde, hasta]
  );
  return rows.map(r => ({ ...r, total_usd: round2(r.total_usd) }));
}

// ──────────────────────────────────────────────────────────────────────
// CAJAS — snapshot al final del período (saldo histórico)
// ──────────────────────────────────────────────────────────────────────

async function snapshotCajas(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [fechaCorte] = restArgs;
  // Saldo de cada caja AL final del día `fechaCorte`. Se reconstruye con el
  // saldo inicial + la suma de movimientos hasta esa fecha. Permite ver
  // "cómo estaba la caja a fin del mes pasado" sin pisar el saldo actual.
  const { rows } = await exec.query(
    `SELECT mp.id, mp.nombre, mp.moneda,
            mp.saldo_inicial + COALESCE(SUM(
              CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
            ) FILTER (WHERE cm.fecha <= $1 AND cm.deleted_at IS NULL), 0) AS saldo
       FROM metodos_pago mp
       LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id
      WHERE mp.deleted_at IS NULL
      GROUP BY mp.id, mp.nombre, mp.moneda, mp.saldo_inicial
      ORDER BY mp.orden, mp.nombre`,
    [fechaCorte]
  );

  const cajas = rows.map(r => ({ ...r, saldo: round2(r.saldo) }));

  // Capital total por moneda + agregado en USD. Para el USD agregado,
  // ARS se convierte con el último TC de venta del período (aproximado).
  // Para simplicidad inicial: asumimos 1 USD = 1000 ARS si no hay TC.
  // (Mejora futura: parametrizar el TC o usar el del cierre del mes).
  const porMoneda = { ARS: 0, USD: 0, USDT: 0 };
  for (const c of cajas) {
    if (porMoneda[c.moneda] !== undefined) porMoneda[c.moneda] += Number(c.saldo) || 0;
  }

  // Last TC de venta hasta fechaCorte (para conversión ARS → USD).
  // Fallback en cadena: (1) última venta con TC, (2) tc_referencia configurado
  // en alertas_config (si el usuario lo seteó), (3) NULL para que el front
  // sepa que no hay base de conversión confiable. Antes era hardcoded 1000,
  // lo que ocultaba el problema y daba capital_usd irreal.
  const [{ rows: tcRowArr }, { rows: tcConfArr }] = await Promise.all([
    exec.query(
      `SELECT tc_venta FROM ventas
        WHERE tc_venta IS NOT NULL AND fecha <= $1 AND deleted_at IS NULL
        ORDER BY fecha DESC, id DESC LIMIT 1`,
      [fechaCorte]
    ),
    exec.query(
      `SELECT parametros FROM alertas_config WHERE tipo = 'tc_referencia' LIMIT 1`
    ),
  ]);
  const tcDeVenta = Number(tcRowArr[0]?.tc_venta) || 0;
  const tcDeConfig = Number(tcConfArr[0]?.parametros?.valor) || 0;
  // Si ninguno: NULL → capital_usd_equivalente queda en null, el front muestra "—".
  const tcReferencia = tcDeVenta > 0 ? tcDeVenta : (tcDeConfig > 0 ? tcDeConfig : null);

  // Si no hay TC para convertir ARS → USD, el capital_usd_equivalente sólo
  // refleja USD + USDT (no inventamos un TC). El frontend muestra "—" para
  // capital agregado y un hint "Configurá un TC de referencia en Alertas".
  const capitalUsdEquivalente = tcReferencia
    ? round2(porMoneda.USD + porMoneda.USDT + toUsd(porMoneda.ARS, 'ARS', tcReferencia))
    : (porMoneda.ARS === 0
        ? round2(porMoneda.USD + porMoneda.USDT)
        : null);

  return {
    cajas,
    por_moneda: {
      ARS:  round2(porMoneda.ARS),
      USD:  round2(porMoneda.USD),
      USDT: round2(porMoneda.USDT),
    },
    capital_usd_equivalente: capitalUsdEquivalente,
    tc_referencia:           tcReferencia,
  };
}

// ──────────────────────────────────────────────────────────────────────
// DEUDAS — snapshot puntual al final del período
// ──────────────────────────────────────────────────────────────────────

async function deudaCCClientes(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [fechaCorte] = restArgs;
  // 2026-06-11 S-03: usar la fórmula canónica de lib/saldoCC.js. Antes acá había
  // un CASE distinto que (a) NO descontaba compras pagadas de contado (caja_id
  // IS NOT NULL → contado, no genera deuda) y (b) NO sumaba `saldo_inicial`.
  // Resultado: el "total deuda CC" del dashboard difería del del módulo
  // operativo. Ahora ambos usan la MISMA fórmula y la cifra cuadra.
  const { SALDO_CASE_M } = require('./saldoCC');
  const { rows } = await exec.query(
    `SELECT COALESCE(SUM(${SALDO_CASE_M}), 0) AS deuda_usd,
            COUNT(DISTINCT m.cliente_cc_id)::int AS clientes_con_deuda
       FROM movimientos_cc m
       JOIN clientes_cc c ON c.id = m.cliente_cc_id
      WHERE m.fecha <= $1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [fechaCorte]
  );
  return {
    deuda_usd:          round2(rows[0].deuda_usd),
    clientes_con_deuda: rows[0].clientes_con_deuda || 0,
  };
}

async function deudaProveedores(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [fechaCorte] = restArgs;
  // Saldo proveedores: compras suman deuda, pagos la restan.
  const { rows } = await exec.query(
    `SELECT COALESCE(SUM(
       CASE m.tipo
         WHEN 'compra' THEN m.monto_usd
         WHEN 'pago'   THEN -m.monto_usd
         ELSE 0
       END
     ), 0) AS deuda_usd,
     COUNT(DISTINCT m.proveedor_id)::int AS proveedores_con_deuda
     FROM proveedor_movimientos m
     JOIN proveedores p ON p.id = m.proveedor_id
    WHERE m.fecha <= $1 AND m.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [fechaCorte]
  );
  return {
    deuda_usd:             round2(rows[0].deuda_usd),
    proveedores_con_deuda: rows[0].proveedores_con_deuda || 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// EGRESOS — totales del período
// ──────────────────────────────────────────────────────────────────────

async function egresosAgregados(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta] = restArgs;
  const { rows } = await exec.query(
    `SELECT COUNT(*)::int AS cant_egresos,
            COALESCE(SUM(monto_usd), 0) AS total_usd
       FROM egresos
      WHERE fecha BETWEEN $1 AND $2 AND deleted_at IS NULL AND estado = 'pagado'`,
    [desde, hasta]
  );
  return {
    cant_egresos: rows[0].cant_egresos || 0,
    total_usd:    round2(rows[0].total_usd),
  };
}

// ──────────────────────────────────────────────────────────────────────
// ORQUESTADOR
// ──────────────────────────────────────────────────────────────────────

/**
 * Devuelve el bundle de KPIs para un período. Lanza todas las queries en
 * paralelo. fechaCorte por default es `hasta` (saldos al final del período).
 *
 * Multi-tenant 2026-06-16: acepta opcionalmente un `client` como primer arg
 * (PG client tx-scoped con `SET LOCAL app.current_tenant`). Si el primer arg
 * NO es un client (heurística: tiene .query y no es string), asume que ese
 * arg es `desde` (compat con callers viejos sin tenant — jobs/crons).
 */
async function kpisDelPeriodo(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, fechaCorte = hasta] = restArgs;
  const [
    ventas, productos, vendedores, metodos,
    cajas, deudaCC, deudaProv, egresos,
  ] = await Promise.all([
    ventasAgregadas(exec, desde, hasta),
    topProductos(exec, desde, hasta),
    topVendedores(exec, desde, hasta),
    pagosPorMetodo(exec, desde, hasta),
    snapshotCajas(exec, fechaCorte),
    deudaCCClientes(exec, fechaCorte),
    deudaProveedores(exec, fechaCorte),
    egresosAgregados(exec, desde, hasta),
  ]);

  return {
    periodo: { desde, hasta },
    ventas: {
      ...ventas,
      top_productos:  productos,
      top_vendedores: vendedores,
      pagos_por_metodo: metodos,
    },
    cajas,        // { cajas, por_moneda, capital_usd_equivalente, tc_referencia }
    deuda_cc:     deudaCC,
    deuda_proveedores: deudaProv,
    egresos,
  };
}

/** YYYY-MM → { desde: YYYY-MM-01, hasta: YYYY-MM-último } */
function rangoMes(periodo) {
  if (!/^\d{4}-\d{2}$/.test(periodo)) {
    const e = new Error('Período inválido (formato esperado YYYY-MM)');
    e.status = 400; throw e;
  }
  const [y, m] = periodo.split('-').map(Number);
  if (m < 1 || m > 12) {
    const e = new Error(`Mes inválido: ${m} (debe ser 1-12)`);
    e.status = 400; throw e;
  }
  if (y < 2000 || y > 2100) {
    const e = new Error(`Año fuera de rango: ${y} (esperado 2000-2100)`);
    e.status = 400; throw e;
  }
  const desde = `${periodo}-01`;
  const ultimoDia = new Date(y, m, 0).getDate(); // m=mes 1-12 → new Date(y, m, 0) = último día del mes
  const hasta = `${periodo}-${String(ultimoDia).padStart(2, '0')}`;
  return { desde, hasta };
}

/** YYYY-MM → YYYY-MM del mes anterior */
function mesAnterior(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

module.exports = { kpisDelPeriodo, rangoMes, mesAnterior };
