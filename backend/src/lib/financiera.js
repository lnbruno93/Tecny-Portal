// Comprobante de Financiera generado automáticamente a partir de una venta.
//
// Invariante (única fuente de verdad): el comprobante de Financiera de una venta
// existe (deleted_at IS NULL) sí y solo sí:
//   (a) la venta está activa (estado !== 'cancelado'),
//   (b) tiene un pago con la caja financiera (metodos_pago.es_financiera), y
//   (c) tiene al menos un archivo de comprobante adjunto (venta_comprobantes).
//
// `syncFinancieraComprobante` reconcilia ese estado de forma idempotente: crea la
// fila si corresponde y no existe, la restaura + recalcula la comisión si existe,
// o la revierte (soft-delete) si ya no corresponde. Debe correr dentro de la tx.
// Devuelve la fila activa del comprobante, o null si no corresponde.
const { round2 } = require('./money');

async function syncFinancieraComprobante(client, ventaId, estado) {
  let pagoFin = null;
  let file = null;
  if (estado !== 'cancelado') {
    const fin = await client.query(
      `SELECT vp.monto FROM venta_pagos vp
         JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
        WHERE vp.venta_id = $1 AND mp.es_financiera = true AND mp.deleted_at IS NULL
        LIMIT 1`, [ventaId]
    );
    // P-03 Fase 5 (2026-06-13): el SELECT tiene que traer también archivo_key
    // y archivo_size — desde la activación del flag storage_r2_ventas_comprobantes
    // los uploads nuevos van a R2 y archivo_data queda NULL. Sin estos dos
    // campos, syncFinancieraComprobante copiaba data=NULL al comprobantes table
    // y el dashboard de Transferencias se quedaba sin el archivo.
    const f = await client.query(
      `SELECT archivo_data, archivo_key, archivo_size, archivo_nombre, archivo_tipo
         FROM venta_comprobantes
        WHERE venta_id = $1 AND deleted_at IS NULL
        ORDER BY id LIMIT 1`, [ventaId]
    );
    if (fin.rows[0] && f.rows[0]) { pagoFin = fin.rows[0]; file = f.rows[0]; }
  }

  // No corresponde → revertir el comprobante si existe.
  if (!pagoFin) {
    await client.query('UPDATE comprobantes SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [ventaId]);
    return null;
  }

  // Auditoría 2026-06-30 D-01 — Snapshot lazy de pct_aplicado:
  //  · Si la fila comprobantes ya existe y tiene pct_aplicado NOT NULL →
  //    usar ese % snapshoteado (NO leer config). Garantiza inmutabilidad
  //    histórica: editar la venta vieja no reescribe monto_financiera con el
  //    pct nuevo de config.
  //  · Si pct_aplicado IS NULL (fila pre-fix) → sealing lazy: derivar el %
  //    matemáticamente del monto_financiera ya congelado y persistirlo. NO
  //    sobrescribir monto_financiera con un valor recalculado del pct actual
  //    de config (el monto histórico es fuente de verdad).
  //  · Si no existe fila (alta nueva) → leer config.pct_financiera y persistir
  //    pct_aplicado al INSERT.
  const monto = Number(pagoFin.monto);
  const existing = await client.query(
    `SELECT id, pct_aplicado, monto AS monto_old, monto_financiera AS monto_financiera_old
       FROM comprobantes WHERE venta_id = $1 ORDER BY id LIMIT 1`,
    [ventaId]
  );

  let pct;             // % a persistir en pct_aplicado (NUMERIC(6,3))
  let monto_financiera;
  let monto_neto;

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const pctSnap = row.pct_aplicado != null ? Number(row.pct_aplicado) : null;
    const montoOld = Number(row.monto_old);
    const montoFinOld = Number(row.monto_financiera_old);

    if (pctSnap != null) {
      // CAMINO A: fila ya sellada — usar el % snapshoteado.
      // Si el monto del pago cambió (edit del monto en venta_pagos), recalculamos
      // con el % snapshot. El % NO cambia: el % es del momento de la venta.
      pct = pctSnap;
      monto_financiera = round2(monto * pct / 100);
      monto_neto = round2(monto - monto_financiera);
    } else if (montoOld > 0 && montoFinOld >= 0 && monto === montoOld) {
      // CAMINO B: fila pre-fix, monto no cambió — sealing lazy derivando el %
      // del monto_financiera ya congelado. Mantenemos los valores históricos
      // intactos y solo sellamos pct_aplicado para que futuros toques no
      // recalculen.
      pct = round3(montoFinOld * 100 / montoOld);
      monto_financiera = montoFinOld;        // preservar el valor histórico
      monto_neto = round2(monto - monto_financiera);
    } else {
      // CAMINO C: fila pre-fix Y el monto del pago cambió (o monto_old era 0).
      // No podemos derivar el % del histórico (la relación se rompió). Usamos
      // el pct ACTUAL de config como fallback y sellamos. Caso borde — debería
      // ser raro porque las ediciones de monto vienen de fullEdit que ya
      // re-INSERTÓ venta_pagos.
      const { rows: cfg } = await client.query('SELECT pct_financiera FROM config LIMIT 1');
      pct = round3(Number(cfg[0]?.pct_financiera || 0));
      monto_financiera = round2(monto * pct / 100);
      monto_neto = round2(monto - monto_financiera);
    }
  } else {
    // CAMINO D: fila nueva — leer config y snapshotear.
    const { rows: cfg } = await client.query('SELECT pct_financiera FROM config LIMIT 1');
    pct = round3(Number(cfg[0]?.pct_financiera || 0));
    monto_financiera = round2(monto * pct / 100);
    monto_neto = round2(monto - monto_financiera);
  }

  // Si ya hay una fila (activa o revertida), restaurarla + actualizar. Si no, crearla.
  //
  // IMPORTANTE: el UPDATE incluye archivo_data/nombre/tipo, no solo los montos.
  // Antes de mayo-2026 estos no se refrescaban: si la venta era cancelada (con su
  // comprobante soft-deleted), después se subía un archivo nuevo en venta_comprobantes,
  // y al reactivarse, el comprobante de Financiera quedaba pegado al archivo viejo —
  // archivo desincronizado de los montos. Riesgo de auditoría con terceros.
  if (existing.rows[0]) {
    // P-03 Fase 5: copiar también archivo_key + archivo_size. Si la fila origen
    // tiene archivo_data poblado (legacy), se copia tal cual. Si tiene archivo_key
    // (R2), se copia la key — el objeto en R2 queda referenciado por dos filas
    // distintas (venta_comprobantes + comprobantes), pero apunta al mismo blob:
    // cuando ambas filas pasen a soft-delete, el cron de purga futuro deberá
    // chequear que ninguna fila activa referencia la key antes de borrar el
    // objeto R2.
    //
    // Auditoría 2026-06-30 Q-05 (TODO P-03 cleanup cron): DEFERRED.
    // Decisión: no se implementa por ahora. Trade-offs:
    //   · Falsos positivos de un cron mal hecho borran blobs que SÍ están en
    //     uso desde otra tabla → pérdida de evidencia auditable con terceros.
    //     Inaceptable para la regla "calidad > velocidad".
    //   · El costo de R2 por blobs huérfanos en escala actual es despreciable
    //     (decenas de MB/mes; bucket factura por GB-mes). No hay urgencia.
    //   · Implementación correcta requiere: scan de comprobantes ∪
    //     venta_comprobantes (ambas tablas pueden apuntar a la misma key),
    //     ventana de gracia (>= 30 días post-soft-delete), dry-run con log
    //     antes del DELETE real, y tests sobre el grafo de keys compartidas.
    //     Es ~1 día de trabajo + revisión, no 10 líneas.
    //   · Plan: agendar como P-03 Fase 6 cuando (a) bucket > 5 GB, o (b) haya
    //     auditoría externa que requiera purga de blobs eliminados.
    //
    // Auditoría 2026-06-30 D-01: incluimos pct_aplicado en el UPDATE (sellado lazy).
    const { rows } = await client.query(
      `UPDATE comprobantes
          SET deleted_at = NULL, monto = $2, monto_financiera = $3, monto_neto = $4,
              archivo_data = $5, archivo_nombre = $6, archivo_tipo = $7,
              archivo_key = $8, archivo_size = $9,
              pct_aplicado = $10
        WHERE venta_id = $1
       RETURNING id, monto, monto_financiera, monto_neto, pct_aplicado`,
      [ventaId, monto, monto_financiera, monto_neto,
       file.archivo_data, file.archivo_nombre ?? null, file.archivo_tipo ?? null,
       file.archivo_key ?? null, file.archivo_size ?? null, pct]
    );
    return rows[0];
  }

  const { rows: v } = await client.query('SELECT fecha, cliente_nombre, order_id FROM ventas WHERE id = $1', [ventaId]);
  // Auditoría 2026-06-30 D-01: persistir pct_aplicado en el INSERT (snapshot).
  const { rows } = await client.query(
    `INSERT INTO comprobantes
      (fecha, cliente, monto, monto_financiera, monto_neto, referencia,
       archivo_data, archivo_nombre, archivo_tipo, archivo_key, archivo_size,
       venta_id, pct_aplicado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, monto, monto_financiera, monto_neto, pct_aplicado`,
    [v[0].fecha, v[0].cliente_nombre ?? null, monto, monto_financiera, monto_neto, v[0].order_id,
     file.archivo_data, file.archivo_nombre ?? null, file.archivo_tipo ?? null,
     file.archivo_key ?? null, file.archivo_size ?? null, ventaId, pct]
  );
  return rows[0];
}

// Auditoría 2026-06-30 D-01 — helper local para redondear a 3 decimales (tipo
// NUMERIC(6,3) de pct_aplicado / comision_pct_snapshot).
function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * postCajaMovimientoFinanciera — registra un caja_movimiento sobre la caja
 * marcada `es_financiera = true` para reflejar TODO movimiento del módulo
 * Financiera (comprobantes manuales, pagos a vendedor) en el libro caja.
 *
 * Decisión durable (junio 2026): el módulo Financiera ya tenía un "saldo
 * virtual" calculado del SUM(comprobantes) − SUM(pagos), pero ese saldo no
 * impactaba la caja `es_financiera`. Resultado: el libro caja no reflejaba
 * los comprobantes manuales (ventas previas al sistema) ni la salida de
 * dinero al pagar vendedores. Trazabilidad rota.
 *
 * Con este helper, el invariante pasa a ser:
 *
 *    saldo caja FV  ≡  Σ ingresos (ventas con pago FV + comprobantes manuales)
 *                    − Σ egresos  (pagos a vendedor)
 *
 * Convenciones:
 *  · El monto que se postea es el `monto_neto` (lo que efectivamente queda
 *    en la caja después de la retención de la financiera). La comisión nunca
 *    pasa por la caja del comercio — la retiene la fuente. Si en el futuro
 *    quisieras ver el bruto entrando y la comisión saliendo (2 movs), revisar
 *    esta decisión — afecta el saldo histórico.
 *  · La moneda del movimiento usa la moneda de la caja FV (lo que postCaja
 *    Movimiento espera). Si los montos vienen en otra moneda, el caller debe
 *    convertir antes.
 *  · `ref_tabla` / `ref_id` permiten que `reverseCajaMovimientos` revierta
 *    automáticamente al borrar/editar el documento origen (comprobante o pago).
 *
 * Errors: si no existe ninguna caja marcada `es_financiera=true`, throwea
 * con un mensaje claro al operador — pidiéndole que configure la caja en
 * Cajas → Config. NO crea movimientos huérfanos.
 */
const { postCajaMovimiento } = require('./cajaLedger');

async function postCajaMovimientoFinanciera(client, {
  tipo,        // 'ingreso' | 'egreso'
  fecha,
  monto,       // monto NETO del movimiento (positivo)
  ref_tabla,   // 'comprobantes' | 'pagos'
  ref_id,
  concepto,
  user_id,
}) {
  const { rows } = await client.query(
    `SELECT id, moneda FROM metodos_pago
      WHERE es_financiera = true AND deleted_at IS NULL
      LIMIT 1`
  );
  if (!rows[0]) {
    const e = new Error(
      'No hay caja marcada como Financiera. Configurá una caja con "es_financiera = true" en Cajas → Config antes de operar.'
    );
    e.status = 400;
    throw e;
  }
  const fv = rows[0];

  return postCajaMovimiento(client, {
    caja_id: fv.id,
    fecha,
    tipo,
    monto,
    moneda: fv.moneda, // la moneda del movimiento es la de la caja (grupoMoneda check delegado)
    tc: null,          // hoy la caja FV es ARS — si en el futuro hay FV en USD/USDT, ajustar
    origen: 'financiera',
    ref_tabla,
    ref_id,
    concepto: concepto ?? null,
    user_id: user_id ?? null,
  });
}

/**
 * recalcComprobantesFinancieraByTenant — recalcula monto_financiera y monto_neto
 * de TODOS los comprobantes activos del tenant actual con el nuevo `pctNuevo`.
 *
 * @deprecated Auditoría 2026-06-30 D-01. Este helper FUE invocado desde PUT
 *   /api/config para "propagar" el cambio de pct_financiera a las filas
 *   históricas. La auditoría detectó que ese comportamiento es exactamente el
 *   bug P0: cambiar el % afecta KPIs históricos retroactivamente.
 *
 *   La política nueva es "snapshot lazy" (Opción B): cada `comprobantes` lleva
 *   su propio `pct_aplicado` (NUMERIC(6,3)) congelado al momento de la venta.
 *   Cambiar pct_financiera SOLO afecta ventas NUEVAS. Por eso este helper YA
 *   NO se invoca desde rutas — queda para tests de smoke y eventuales scripts
 *   admin (re-sealing forzado en escenarios excepcionales).
 *
 * 2026-06-25 Bug #2 (primer cliente real iDeals Ar tenant=12): cuando el owner
 * cambia el % de retención de la financiera en Config, los comprobantes ya
 * existentes quedaban con el cálculo congelado del % viejo (o 0 si nunca se
 * configuró). El owner espera intuitivamente que cambiar el % afecte sus
 * ventas históricas — si no, el dashboard miente y la trazabilidad financiera
 * pierde sentido.
 * — Reverso 2026-06-30 D-01: ese "intuitivo" choca con la integridad histórica.
 *   Decisión final: ventas nuevas usan pct nuevo (snapshot al INSERT), ventas
 *   viejas se quedan con su pct original (sealing lazy en primer touch).
 *
 * Diseño:
 *  · Idempotente: re-correr con el mismo pct no cambia nada (los valores ya
 *    están consistentes con ese pct).
 *  · Solo toca filas activas (deleted_at IS NULL).
 *  · Asume que `client` ya está dentro de withTenant(tenantId) — la RLS de
 *    `comprobantes` filtra automáticamente al tenant actual; NO necesitamos
 *    WHERE tenant_id explícito.
 *  · Devuelve la cantidad de filas afectadas — útil para audit logging.
 *  · Mantiene la invariante: monto_neto = monto - monto_financiera (round2).
 *
 * Por qué un UPDATE en SQL en vez de iterar en JS: 1 query atómica que afecta
 * N filas es O(1) network roundtrips. Iterar en JS sería O(N) y abriría una
 * ventana donde algunas filas tienen el pct nuevo y otras el viejo.
 *
 * NOTA sobre postCajaMovimientoFinanciera: cuando cambia monto_neto, también
 * debería actualizarse el caja_movimiento asociado (porque el movimiento usa
 * el neto como monto). NO lo hacemos en este helper porque el flujo de
 * caja_movimientos es append-only + reverse, no UPDATE in-place. Para esta
 * primera iteración aceptamos que el SALDO de la caja FV puede quedar levemente
 * desincronizado del nuevo neto hasta que se edite/recree el comprobante.
 * TODO follow-up: si esto resulta confuso para el operador, sumar reverso +
 * post nuevo del movimiento con el delta. Por ahora documentamos.
 */
async function recalcComprobantesFinancieraByTenant(client, pctNuevo) {
  const pct = Number(pctNuevo) || 0;
  const { rowCount } = await client.query(
    `UPDATE comprobantes
        SET monto_financiera = ROUND(monto * $1 / 100, 2),
            monto_neto       = ROUND(monto - (monto * $1 / 100), 2)
      WHERE deleted_at IS NULL`,
    [pct]
  );
  return rowCount;
}

module.exports = {
  syncFinancieraComprobante,
  postCajaMovimientoFinanciera,
  recalcComprobantesFinancieraByTenant,
};
