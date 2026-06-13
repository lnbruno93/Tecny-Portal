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

  // Comisión con el monto y % actuales.
  const monto = Number(pagoFin.monto);
  const { rows: cfg } = await client.query('SELECT pct_financiera FROM config LIMIT 1');
  const pct = Number(cfg[0]?.pct_financiera || 0);
  const monto_financiera = round2(monto * pct / 100);
  const monto_neto = round2(monto - monto_financiera);

  // Si ya hay una fila (activa o revertida), restaurarla + recalcular. Si no, crearla.
  //
  // IMPORTANTE: el UPDATE incluye archivo_data/nombre/tipo, no solo los montos.
  // Antes de mayo-2026 estos no se refrescaban: si la venta era cancelada (con su
  // comprobante soft-deleted), después se subía un archivo nuevo en venta_comprobantes,
  // y al reactivarse, el comprobante de Financiera quedaba pegado al archivo viejo —
  // archivo desincronizado de los montos. Riesgo de auditoría con terceros.
  const existing = await client.query('SELECT id FROM comprobantes WHERE venta_id = $1 ORDER BY id LIMIT 1', [ventaId]);
  if (existing.rows[0]) {
    // P-03 Fase 5: copiar también archivo_key + archivo_size. Si la fila origen
    // tiene archivo_data poblado (legacy), se copia tal cual. Si tiene archivo_key
    // (R2), se copia la key — el objeto en R2 queda referenciado por dos filas
    // distintas (venta_comprobantes + comprobantes), pero apunta al mismo blob:
    // cuando ambas filas pasen a soft-delete, el cron de purga futuro deberá
    // chequear que ninguna fila activa referencia la key antes de borrar el
    // objeto R2 (TODO P-03 cleanup cron).
    const { rows } = await client.query(
      `UPDATE comprobantes
          SET deleted_at = NULL, monto = $2, monto_financiera = $3, monto_neto = $4,
              archivo_data = $5, archivo_nombre = $6, archivo_tipo = $7,
              archivo_key = $8, archivo_size = $9
        WHERE venta_id = $1
       RETURNING id, monto, monto_financiera, monto_neto`,
      [ventaId, monto, monto_financiera, monto_neto,
       file.archivo_data, file.archivo_nombre ?? null, file.archivo_tipo ?? null,
       file.archivo_key ?? null, file.archivo_size ?? null]
    );
    return rows[0];
  }

  const { rows: v } = await client.query('SELECT fecha, cliente_nombre, order_id FROM ventas WHERE id = $1', [ventaId]);
  const { rows } = await client.query(
    `INSERT INTO comprobantes
      (fecha, cliente, monto, monto_financiera, monto_neto, referencia,
       archivo_data, archivo_nombre, archivo_tipo, archivo_key, archivo_size, venta_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, monto, monto_financiera, monto_neto`,
    [v[0].fecha, v[0].cliente_nombre ?? null, monto, monto_financiera, monto_neto, v[0].order_id,
     file.archivo_data, file.archivo_nombre ?? null, file.archivo_tipo ?? null,
     file.archivo_key ?? null, file.archivo_size ?? null, ventaId]
  );
  return rows[0];
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

module.exports = { syncFinancieraComprobante, postCajaMovimientoFinanciera };
