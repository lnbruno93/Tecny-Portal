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
const { toUsd, round2, getTcDefaultPais } = require('./money');
// Fórmula canónica del saldo por proveedor — consolidada 2026-07-17 (task #150).
// Antes este archivo tenía una CASE inline INCOMPLETA que ignoraba caja_id +
// saldo_inicial, inflando la deuda cuando había compras pagadas de contado.
const { SALDO_CASE_M: SALDO_PROV_CASE_M } = require('./saldoProveedor');

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
  const [desde, hasta, opts = {}] = restArgs;
  const etiquetaId = opts.etiquetaId != null ? Number(opts.etiquetaId) : null;
  const claseId    = opts.claseId    || null;
  // 2026-08-04 (task #307): ganancia_usd persistida es BRUTA — descuenta
  // costo + comisión al vendedor pero NO la comisión del método de pago
  // (Financiera 3%, tarjetas). Descontamos comision_total_metodos acá para
  // que Resumen Mensual y serie-6-meses tengan valores consistentes con el
  // Dashboard KPI.
  //
  // 2026-08-05 (task #312): filtros opcionales etiquetaId + claseId. Cuando
  // claseId presente, JOIN venta_items → productos (una venta con múltiples
  // ítems de esa clase se cuenta 1 vez gracias a DISTINCT + subquery).
  const params = [desde, hasta];
  if (etiquetaId != null) params.push(etiquetaId);
  if (claseId)            params.push(claseId);
  const iEtq = etiquetaId != null ? params.indexOf(etiquetaId) + 1 : null;
  const iCla = claseId    ? params.indexOf(claseId)    + 1 : null;
  const { rows } = await exec.query(
    `SELECT
       COUNT(*) FILTER (WHERE estado <> 'cancelado')                                                      AS cant_ventas,
       COALESCE(SUM(total_usd)    FILTER (WHERE estado <> 'cancelado'), 0)                                AS ventas_usd,
       COALESCE(
         SUM(ganancia_usd - COALESCE(comision_total_metodos, 0))
           FILTER (WHERE estado <> 'cancelado'),
         0
       )                                                                                                  AS ganancia_usd,
       COALESCE(AVG(total_usd)    FILTER (WHERE estado <> 'cancelado' AND total_usd > 0), 0)              AS ticket_promedio_usd
     FROM (
       SELECT DISTINCT v.id, v.estado, v.total_usd, v.ganancia_usd, v.comision_total_metodos
         FROM ventas v
         ${claseId ? 'JOIN venta_items vi ON vi.venta_id = v.id JOIN productos p ON p.id = vi.producto_id' : ''}
        WHERE v.fecha BETWEEN $1 AND $2 AND v.deleted_at IS NULL
          ${etiquetaId != null ? `AND v.etiqueta_id = $${iEtq}::int` : ''}
          ${claseId    ? `AND p.clase_id = $${iCla}::uuid` : ''}
     ) sub`,
    params
  );
  return {
    cant_ventas:         Number(rows[0].cant_ventas) || 0,
    ventas_usd:          round2(rows[0].ventas_usd),
    ganancia_usd:        round2(rows[0].ganancia_usd),
    ticket_promedio_usd: round2(rows[0].ticket_promedio_usd),
  };
}

// 2026-07-12 (auditoría TOTAL P0-3 Financiero): el CASE anterior dividía
// SIEMPRE por `tc_venta`, asumiendo que `precio_vendido` está en moneda local.
// Pero `venta_items.moneda` puede ser 'USD'/'USDT' — en ese caso el precio
// YA está en USD y NO se debe dividir. Un item USD de 100 con tc_venta=1400
// quedaba computado como 100/1400 = 0.07 USD → total_usd subestimado 1400×.
//
// Fix: replicar el CASE del dashboard general (`routes/ventas.js:675`), que
// chequea `vi.moneda IN ('ARS','UYU')` antes de dividir. Consistencia
// cross-módulo. El bug afectaba los rankings del Resumen Mensual (mostraban
// valores absolutos totalmente incorrectos para tenants con ventas USD, que
// es el 100% de los tenants AR de electrónica).
//
// El `tc_venta` es el TC del momento de la venta (inmutable) y sigue siendo
// la fuente de conversión — solo se aplica cuando corresponde según la
// moneda del item.
async function topProductos(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, limit = 5] = restArgs;
  const { rows } = await exec.query(
    `SELECT vi.descripcion AS producto, SUM(vi.cantidad)::int AS cantidad,
            COALESCE(SUM(CASE
              WHEN vi.moneda IN ('ARS','UYU') AND v.tc_venta > 0
                THEN vi.precio_vendido * vi.cantidad / v.tc_venta
              ELSE vi.precio_vendido * vi.cantidad
            END), 0) AS total_usd
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
            COALESCE(SUM(CASE
              WHEN vi.moneda IN ('ARS','UYU') AND v.tc_venta > 0
                THEN vi.precio_vendido * vi.cantidad / v.tc_venta
              ELSE vi.precio_vendido * vi.cantidad
            END), 0) AS total_usd
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
  //
  // 2026-07-08 (tenant UY): bug reportado por owner. La tabla "Pagos por
  // método" del Resumen mensual mostraba `Mercadopago | UYU | 113.136` en la
  // columna USD — cuando eran 113.136 UYU (~2.828 USD al TC 40). Root cause:
  // el CASE anterior priorizaba `v.tc_venta` y caía en `ELSE 1` cuando no
  // había TC — típico de tenants UY (o AR) con ventas 100% en moneda local
  // donde el operador nunca setea `v.tc_venta` porque no está convirtiendo.
  // El pago tampoco trae TC propio (`vp.tc IS NULL`), así que el CASE dividía
  // por 1 → montos locales aparecían como USD.
  //
  // Fix estructural: cadena de fallbacks para el divisor:
  //   1) vp.tc  — TC del pago si el operador lo tipeó
  //   2) v.tc_venta — TC principal de la venta
  //   3) TC de referencia del país por moneda (catálogo global
  //      `tc_defaults_pais`). Misma fuente que `snapshotCajas` ya usa hoy
  //      para el capital agregado (seed AR=1400, UY=40).
  // Si aún así no hay TC (país sin seed), NULLIF(..., 0) → NULL → SUM ignora
  // esa fila (no leak silencioso). Idem con NULLIF sobre vp.tc y v.tc_venta.
  //
  // Los TCs default vienen del catálogo global — no dependen del tenant que
  // llama, mismo criterio que la conversión de cajas. Se leen en paralelo con
  // el query principal para no agregar latencia (2 lookups baratos sobre
  // tabla de 2 filas).
  const [tcUYU, tcARS] = await Promise.all([
    getTcDefaultPais(exec, 'UY'),
    getTcDefaultPais(exec, 'AR'),
  ]);
  const { rows } = await exec.query(
    `SELECT mp.nombre AS metodo, mp.moneda,
            COALESCE(SUM(vp.monto / NULLIF(
              CASE
                WHEN vp.moneda IN ('USD','USDT') THEN 1
                ELSE COALESCE(
                  NULLIF(vp.tc, 0),
                  NULLIF(v.tc_venta, 0),
                  CASE vp.moneda
                    WHEN 'UYU' THEN $3::numeric
                    WHEN 'ARS' THEN $4::numeric
                    ELSE NULL
                  END
                )
              END, 0)), 0) AS total_usd
       FROM venta_pagos vp
       JOIN ventas v       ON v.id = vp.venta_id
       JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
      WHERE v.fecha BETWEEN $1 AND $2
        AND v.estado <> 'cancelado' AND v.deleted_at IS NULL
        AND vp.metodo_pago_id IS NOT NULL
      GROUP BY mp.id, mp.nombre, mp.moneda
      ORDER BY total_usd DESC`,
    [desde, hasta, tcUYU, tcARS]
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
  // ARS se convierte con el último TC de venta del período (aproximado),
  // UYU con el TC default del país UY (tc_defaults_pais).
  //
  // BLOCKER 2026-07-05 (multi-país UYU): `porMoneda` antes era
  // { ARS, USD, USDT } — omitía UYU y las cajas UYU se quedaban afuera
  // del agregado por moneda Y del capital_usd_equivalente. Tenants UY con
  // caja UYU veían capital agregado sub-dimensionado (sólo USD + USDT).
  // Ahora UYU se acumula y se convierte con el tc UYU/USD del país UY
  // (catálogo global `tc_defaults_pais`, no depende del tenant que llama).
  const porMoneda = { ARS: 0, UYU: 0, USD: 0, USDT: 0 };
  for (const c of cajas) {
    if (porMoneda[c.moneda] !== undefined) porMoneda[c.moneda] += Number(c.saldo) || 0;
  }

  // Last TC de venta hasta fechaCorte (para conversión ARS → USD).
  // Fallback en cadena: (1) última venta con TC, (2) tc_referencia configurado
  // en alertas_config (si el usuario lo seteó), (3) NULL para que el front
  // sepa que no hay base de conversión confiable. Antes era hardcoded 1000,
  // lo que ocultaba el problema y daba capital_usd irreal.
  //
  // BLOCKER 2026-07-05 (multi-país UYU): el TC UYU se obtiene del catálogo
  // global `tc_defaults_pais` (seed AR=1400, UY=40). No cruzamos con el TC
  // de ventas porque un tenant AR puede tener cajas UYU legacy (raro pero
  // posible) y su histórico de ventas nunca va a tener tc UYU. La decisión
  // durable: el TC UYU de referencia vive en el catálogo país, no per-tenant.
  const [{ rows: tcRowArr }, { rows: tcConfArr }, tcUYU] = await Promise.all([
    exec.query(
      `SELECT tc_venta FROM ventas
        WHERE tc_venta IS NOT NULL AND fecha <= $1 AND deleted_at IS NULL
        ORDER BY fecha DESC, id DESC LIMIT 1`,
      [fechaCorte]
    ),
    exec.query(
      `SELECT parametros FROM alertas_config WHERE tipo = 'tc_referencia' LIMIT 1`
    ),
    getTcDefaultPais(exec, 'UY'),
  ]);
  const tcDeVenta = Number(tcRowArr[0]?.tc_venta) || 0;
  const tcDeConfig = Number(tcConfArr[0]?.parametros?.valor) || 0;
  // Si ninguno: NULL → capital_usd_equivalente queda en null, el front muestra "—".
  const tcReferencia = tcDeVenta > 0 ? tcDeVenta : (tcDeConfig > 0 ? tcDeConfig : null);
  // TC de referencia UYU (siempre desde el catálogo país). Si no hay seed,
  // null → el saldo UYU no se suma al capital_usd_equivalente (mismo criterio
  // que ARS sin TC).
  const tcReferenciaUYU = tcUYU && Number(tcUYU) > 0 ? Number(tcUYU) : null;

  // Si no hay TC para convertir ARS → USD, el capital_usd_equivalente sólo
  // refleja USD + USDT (no inventamos un TC). El frontend muestra "—" para
  // capital agregado y un hint "Configurá un TC de referencia en Alertas".
  //
  // BLOCKER 2026-07-05: la fórmula legacy sumaba `USD + USDT + toUsd(ARS)`
  // pero NO `toUsd(UYU)` — el saldo UYU se caía silenciosamente del capital
  // agregado. Fix: sumar también la conversión UYU→USD si hay tc_referencia_uyu.
  // Regla de "sin TC → null" ahora aplica a ARS **y** a UYU: si hay saldo en
  // una moneda local pero falta su TC, el agregado no es confiable.
  const arsSinTc = porMoneda.ARS !== 0 && !tcReferencia;
  const uyuSinTc = porMoneda.UYU !== 0 && !tcReferenciaUYU;
  let capitalUsdEquivalente;
  if (arsSinTc || uyuSinTc) {
    capitalUsdEquivalente = null;
  } else {
    capitalUsdEquivalente = round2(
      porMoneda.USD +
      porMoneda.USDT +
      toUsd(porMoneda.ARS, 'ARS', tcReferencia) +
      toUsd(porMoneda.UYU, 'UYU', tcReferenciaUYU)
    );
  }

  return {
    cajas,
    por_moneda: {
      ARS:  round2(porMoneda.ARS),
      UYU:  round2(porMoneda.UYU),
      USD:  round2(porMoneda.USD),
      USDT: round2(porMoneda.USDT),
    },
    capital_usd_equivalente: capitalUsdEquivalente,
    tc_referencia:           tcReferencia,
    tc_referencia_uyu:       tcReferenciaUYU,
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
  // Saldo proveedores: fórmula canónica de `lib/saldoProveedor.js`
  // (consolidada 2026-07-17, task #150). Antes esta función tenía una CASE
  // inline que:
  //   - Ignoraba `compra + caja_id IS NOT NULL` (contado, no deuda) → sumaba
  //     todas las compras y devolvía deuda INFLADA cuando había contado.
  //   - Ignoraba `saldo_inicial` → deudas heredadas al alta del proveedor
  //     nunca aparecían en el dashboard.
  //   - No conocía `entrega_mercaderia` (introducido en task #150).
  // COR-2 audit 2026-07-06: devolución cross-tenant B2B (buyer devuelve al
  // seller) baja la deuda del buyer con ese proveedor — cubierto por el helper.
  //
  // Sub-agregado por proveedor evita over-count del COUNT(DISTINCT) cuando
  // el saldo por proveedor es 0 (todas las compras fueron contado).
  const { rows } = await exec.query(
    `WITH saldos AS (
       SELECT m.proveedor_id,
              COALESCE(SUM(${SALDO_PROV_CASE_M}), 0) AS saldo
         FROM proveedor_movimientos m
         JOIN proveedores p ON p.id = m.proveedor_id
        WHERE m.fecha <= $1 AND m.deleted_at IS NULL AND p.deleted_at IS NULL
        GROUP BY m.proveedor_id
     )
     SELECT COALESCE(SUM(saldo), 0) AS deuda_usd,
            COUNT(*) FILTER (WHERE saldo > 0)::int AS proveedores_con_deuda
       FROM saldos`,
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
// COMPOSICIÓN DE VENTAS (task #309) — data para gráficos del Resumen
// ──────────────────────────────────────────────────────────────────────

/**
 * Ventas por ETIQUETA (incluye retail por etiqueta + B2B como bloque agregado).
 * Retail: LEFT JOIN etiquetas para incluir ventas sin etiqueta ('Sin etiqueta').
 * B2B: aparece como una entrada más con etiqueta='B2B' para lectura unificada
 * en el gráfico dona del frontend.
 *
 * 2026-08-05 (task #312) — filtros opcionales:
 *   · claseId: filtra retail por producto.clase_id (JOIN venta_items + productos).
 *     También filtra B2B por clase_id del producto de sus items.
 *   · etiquetaId: NO aplica acá (esta función AGRUPA por etiqueta; filtrar por
 *     etiqueta específica dejaría el gráfico con 1 sola slice — el frontend
 *     debería ocultar el gráfico en ese caso). Se ignora si viene.
 *
 * Devuelve [{ etiqueta, color, n, usd }] ordenado por usd desc.
 */
async function ventasPorEtiqueta(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, opts = {}] = restArgs;
  const claseId = opts.claseId || null;
  // Retail: cuando hay claseId, JOIN venta_items → productos y filtramos por
  // p.clase_id. La venta se cuenta si TIENE al menos un ítem de esa categoría.
  const { rows: retail } = await exec.query(
    `SELECT COALESCE(e.nombre, 'Sin etiqueta') AS etiqueta,
            COALESCE(e.color, '#94a3b8')        AS color,
            COUNT(DISTINCT v.id)::int           AS n,
            COALESCE(SUM(DISTINCT v.total_usd), 0)::numeric AS usd
       FROM ventas v
       LEFT JOIN etiquetas e ON e.id = v.etiqueta_id
       ${claseId ? 'JOIN venta_items vi ON vi.venta_id = v.id JOIN productos p ON p.id = vi.producto_id' : ''}
      WHERE v.fecha BETWEEN $1 AND $2
        AND v.deleted_at IS NULL AND v.estado <> 'cancelado'
        ${claseId ? 'AND p.clase_id = $3::uuid' : ''}
      GROUP BY 1, 2
      ORDER BY 4 DESC`,
    claseId ? [desde, hasta, claseId] : [desde, hasta]
  );
  const { rows: b2b } = await exec.query(
    `SELECT COUNT(DISTINCT m.id)::int                       AS n,
            COALESCE(SUM((
              SELECT SUM(i.valor) FROM items_movimiento_cc i
               ${claseId ? 'JOIN productos p2 ON p2.id = i.producto_id' : ''}
               WHERE i.movimiento_cc_id = m.id AND i.devuelto_at IS NULL
                 ${claseId ? 'AND p2.clase_id = $3::uuid' : ''}
            )), 0)::numeric                     AS usd
       FROM movimientos_cc m
       ${claseId ? 'JOIN items_movimiento_cc mi ON mi.movimiento_cc_id = m.id JOIN productos p ON p.id = mi.producto_id' : ''}
      WHERE m.fecha BETWEEN $1 AND $2
        AND m.deleted_at IS NULL AND m.tipo = 'compra'
        ${claseId ? 'AND p.clase_id = $3::uuid' : ''}`,
    claseId ? [desde, hasta, claseId] : [desde, hasta]
  );
  const out = retail.map(r => ({
    etiqueta: r.etiqueta,
    color:    r.color,
    n:        Number(r.n),
    usd:      round2(r.usd),
  }));
  const b2bN = Number(b2b[0]?.n || 0);
  if (b2bN > 0) {
    out.push({ etiqueta: 'B2B', color: '#6b7cff', n: b2bN, usd: round2(b2b[0].usd) });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/**
 * Unidades vendidas por CATEGORÍA (clase_id). Combina retail + B2B.
 * Devuelve [{ clase_id, nombre, emoji, unidades, usd }] Top 20 por unidades.
 *
 * 2026-08-05 (task #312) — filtros opcionales:
 *   · etiquetaId: filtra retail por v.etiqueta_id. B2B NO tiene etiquetas
 *     → cuando se aplica etiquetaId, B2B se excluye del resultado.
 *   · claseId: filtra ítems por p.clase_id. Deja el gráfico con 1 sola
 *     barra — el frontend debería ocultarlo/reemplazarlo en ese caso.
 */
async function unidadesPorCategoria(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, opts = {}] = restArgs;
  const etiquetaId = opts.etiquetaId != null ? Number(opts.etiquetaId) : null;
  const claseId    = opts.claseId    || null;
  // Retail
  const retailParams = [desde, hasta];
  if (etiquetaId != null) retailParams.push(etiquetaId);
  if (claseId)            retailParams.push(claseId);
  const iEtq = etiquetaId != null ? retailParams.indexOf(etiquetaId) + 1 : null;
  const iCla = claseId    ? retailParams.indexOf(claseId)    + 1 : null;
  const { rows: retail } = await exec.query(
    `SELECT p.clase_id                            AS clase_id,
            COUNT(vi.id)::int                     AS unidades,
            COALESCE(SUM(vi.precio_vendido * vi.cantidad), 0)::numeric AS usd
       FROM venta_items vi
       JOIN ventas v ON v.id = vi.venta_id
       LEFT JOIN productos p ON p.id = vi.producto_id
      WHERE v.fecha BETWEEN $1 AND $2
        AND v.deleted_at IS NULL AND v.estado <> 'cancelado'
        ${etiquetaId != null ? `AND v.etiqueta_id = $${iEtq}::int` : ''}
        ${claseId    ? `AND p.clase_id = $${iCla}::uuid` : ''}
      GROUP BY p.clase_id`,
    retailParams
  );
  // B2B: si hay etiquetaId, B2B se excluye (los movimientos_cc no tienen
  // etiqueta_id — retornamos array vacío).
  const b2b = etiquetaId != null ? [] : (await exec.query(
    `SELECT p.clase_id                            AS clase_id,
            COUNT(i.id)::int                      AS unidades,
            COALESCE(SUM(i.valor), 0)::numeric    AS usd
       FROM items_movimiento_cc i
       JOIN movimientos_cc m ON m.id = i.movimiento_cc_id
       LEFT JOIN productos p ON p.id = i.producto_id
      WHERE m.fecha BETWEEN $1 AND $2
        AND m.deleted_at IS NULL AND m.tipo = 'compra'
        AND i.devuelto_at IS NULL
        ${claseId ? 'AND p.clase_id = $3::uuid' : ''}
      GROUP BY p.clase_id`,
    claseId ? [desde, hasta, claseId] : [desde, hasta]
  )).rows;
  // Lookup nombres.
  const claseIds = [...new Set([...retail, ...b2b].map(r => r.clase_id).filter(Boolean))];
  let clases = new Map();
  if (claseIds.length > 0) {
    const { rows } = await exec.query(
      `SELECT id, nombre, emoji FROM clases_producto WHERE id = ANY($1::uuid[])`,
      [claseIds]
    );
    clases = new Map(rows.map(r => [r.id, { nombre: r.nombre, emoji: r.emoji }]));
  }
  // Merge retail + b2b por clase_id.
  const combined = new Map();
  const acc = (arr) => {
    for (const r of arr) {
      const key = r.clase_id || '__sin__';
      const prev = combined.get(key) || { clase_id: r.clase_id, unidades: 0, usd: 0 };
      prev.unidades += Number(r.unidades);
      prev.usd      += Number(r.usd);
      combined.set(key, prev);
    }
  };
  acc(retail);
  acc(b2b);
  return Array.from(combined.values())
    .map(r => {
      const meta = r.clase_id ? clases.get(r.clase_id) : null;
      return {
        clase_id: r.clase_id,
        nombre:   meta?.nombre || 'Sin categoría',
        emoji:    meta?.emoji  || '📦',
        unidades: r.unidades,
        usd:      round2(r.usd),
      };
    })
    .filter(r => r.unidades > 0)
    .sort((a, b) => b.unidades - a.unidades)
    .slice(0, 20);
}

/**
 * Ventas por DÍA del mes (retail + B2B combinado). Devuelve array denso
 * (todos los días del período, con 0 cuando no hubo). Facilita gráfico
 * de barras estilo EstadísticasNube (screenshot Lucas).
 *
 * 2026-08-05 (task #312) — filtros opcionales:
 *   · etiquetaId: filtra retail por v.etiqueta_id. B2B se excluye.
 *   · claseId: filtra ambos (retail via venta_items, B2B via items_movimiento_cc)
 *     por producto.clase_id. Días sin ventas de esa categoría quedan en 0.
 */
async function ventasPorDia(...allArgs) {
  const { exec, restArgs } = _resolveExec(allArgs[0], allArgs.slice(1));
  const [desde, hasta, opts = {}] = restArgs;
  const etiquetaId = opts.etiquetaId != null ? Number(opts.etiquetaId) : null;
  const claseId    = opts.claseId    || null;
  // Params dinámicos: siempre desde/hasta ($1, $2). Etiqueta y clase son
  // opcionales — solo se agregan cuando están presentes.
  const params = [desde, hasta];
  if (etiquetaId != null) params.push(etiquetaId);
  if (claseId)            params.push(claseId);
  const iEtq = etiquetaId != null ? params.indexOf(etiquetaId) + 1 : null;
  const iCla = claseId    ? params.indexOf(claseId)    + 1 : null;
  // Cuando hay claseId, JOIN venta_items → productos. COUNT(DISTINCT v.id)
  // porque una venta con 2 items de la misma clase debe contar 1 vez.
  // Cuando hay etiquetaId, B2B queda excluido (WHERE 1=0).
  const { rows } = await exec.query(
    `WITH retail AS (
       SELECT v.fecha::date AS dia, COUNT(DISTINCT v.id)::int AS n_retail
         FROM ventas v
         ${claseId ? 'JOIN venta_items vi ON vi.venta_id = v.id JOIN productos p ON p.id = vi.producto_id' : ''}
        WHERE v.fecha BETWEEN $1 AND $2
          AND v.deleted_at IS NULL AND v.estado <> 'cancelado'
          ${etiquetaId != null ? `AND v.etiqueta_id = $${iEtq}::int` : ''}
          ${claseId    ? `AND p.clase_id = $${iCla}::uuid` : ''}
        GROUP BY v.fecha::date
     ),
     b2b AS (
       SELECT m.fecha::date AS dia, COUNT(DISTINCT m.id)::int AS n_b2b
         FROM movimientos_cc m
         ${claseId ? 'JOIN items_movimiento_cc mi ON mi.movimiento_cc_id = m.id JOIN productos p ON p.id = mi.producto_id' : ''}
        WHERE m.fecha BETWEEN $1 AND $2
          AND m.deleted_at IS NULL AND m.tipo = 'compra'
          ${etiquetaId != null ? 'AND 1 = 0' : ''}
          ${claseId    ? `AND p.clase_id = $${iCla}::uuid` : ''}
        GROUP BY m.fecha::date
     ),
     dias AS (
       SELECT generate_series($1::date, $2::date, '1 day')::date AS dia
     )
     SELECT d.dia,
            COALESCE(r.n_retail, 0) + COALESCE(b.n_b2b, 0) AS n
       FROM dias d
       LEFT JOIN retail r ON r.dia = d.dia
       LEFT JOIN b2b    b ON b.dia = d.dia
      ORDER BY d.dia`,
    params
  );
  return rows.map(r => ({
    dia: r.dia.toISOString ? r.dia.toISOString().slice(0, 10) : String(r.dia).slice(0, 10),
    n:   Number(r.n),
  }));
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
  // 2026-08-05 (task #312): 4to arg opcional `opts` con { etiquetaId, claseId }
  // se propaga a los helpers de composición (por_etiqueta, por_categoria,
  // por_dia) + a ventasAgregadas. Los demás helpers (topProductos, etc.) NO
  // aceptan filtros por ahora — el listado top sigue global.
  const [desde, hasta, fechaCorte = hasta, opts = {}] = restArgs;
  // 2026-08-05 (task #309): 3 helpers nuevos para gráficos del Resumen —
  // corren en paralelo con los del bundle original (sin costo latencia).
  const [
    ventas, productos, vendedores, metodos,
    cajas, deudaCC, deudaProv, egresos,
    porEtiqueta, porCategoria, porDia,
  ] = await Promise.all([
    ventasAgregadas(exec, desde, hasta, opts),
    topProductos(exec, desde, hasta),
    topVendedores(exec, desde, hasta),
    pagosPorMetodo(exec, desde, hasta),
    snapshotCajas(exec, fechaCorte),
    deudaCCClientes(exec, fechaCorte),
    deudaProveedores(exec, fechaCorte),
    egresosAgregados(exec, desde, hasta),
    ventasPorEtiqueta(exec, desde, hasta, opts),
    unidadesPorCategoria(exec, desde, hasta, opts),
    ventasPorDia(exec, desde, hasta, opts),
  ]);

  // Margen neto % = (ganancia_usd − egresos.total_usd) / ventas_usd × 100.
  // Vive acá para que frontend no re-calcule (single source of truth) y
  // porque necesita cruzar 3 valores de sub-bundles distintos.
  const margenNetoPct = ventas.ventas_usd > 0
    ? round2(((Number(ventas.ganancia_usd) - Number(egresos.total_usd)) / Number(ventas.ventas_usd)) * 100)
    : 0;

  return {
    periodo: { desde, hasta },
    ventas: {
      ...ventas,
      top_productos:  productos,
      top_vendedores: vendedores,
      pagos_por_metodo: metodos,
      por_etiqueta:   porEtiqueta,       // task #309 (B2)
      por_categoria:  porCategoria,      // task #309 (B1 + B3)
      por_dia:        porDia,            // task #309 (C1)
    },
    cajas,        // { cajas, por_moneda, capital_usd_equivalente, tc_referencia }
    deuda_cc:     deudaCC,
    deuda_proveedores: deudaProv,
    egresos,
    margen_neto_pct: margenNetoPct,      // task #309 (A2)
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

module.exports = {
  kpisDelPeriodo, rangoMes, mesAnterior,
  // task #309: exportados para el endpoint serie-6-meses que compone su
  // propio bundle liviano (ventas + egresos) sin re-computar todo el mensual.
  ventasAgregadas, egresosAgregados,
};
