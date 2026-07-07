// Helper puro para el backfill de `caja_movimientos` con mismatch moneda
// pago vs caja (Fase B fix #4 audit 2026-07-07).
//
// Contexto: antes del PR de Fase A, `syncVentaCaja` copiaba
// `venta_pagos.monto` crudo al `caja_movimientos.monto` sin considerar si
// las monedas difieren. Como el saldo se calcula sumando montos crudos y
// asume la moneda de la caja, hay data histórica donde el saldo está mal.
//
// Este helper toma una row del SELECT que junta caja_movimientos +
// venta_pagos + metodos_pago y decide qué hacer con cada mov:
//
//   - 'skip'            → no requiere backfill (misma moneda / USD↔USDT
//                         paridad / ya convertido POST-fix / dato tocado
//                         manualmente por operador).
//   - 'reparar'         → tenemos toda la data para auto-corregir. El
//                         script UPDATE usará `nuevo_monto` +
//                         `nuevo_monto_usd`.
//   - 'revisar_manual'  → hay mismatch pero convertirMonto devuelve null
//                         (falta TC, o par local↔local sin USD intermedio).
//                         Lucas + tenant deciden caso por caso.
//
// El helper es puro (sin DB, sin side effects) para poder testearlo con
// inputs sintéticos y correr el dry-run en prod con confianza.

const { convertirMonto, round2, toUsd } = require('./money');

// Monedas "fuertes" (USD/USDT) — decisión Lucas 2026-07-07: USD↔USDT tiene
// paridad 1:1, entonces el mismatch en la práctica no afecta el saldo
// (100 USD guardados como USDT vale igual). Skip explícito para no
// contaminar el reporte con miles de rows irrelevantes.
const MONEDAS_FUERTES = new Set(['USD', 'USDT']);

// Umbral para detectar "monto ya convertido" — comparamos el monto del
// mov con el monto crudo del pago con tolerancia de round2 (dos decimales)
// porque round-trips fpu pueden agregar 0.001 de drift sin significar
// que el mov fue tocado.
const TOLERANCIA_MONTO_CRUDO = 0.01;

/**
 * Decide qué hacer con una row candidata (caja_movimiento ligado a un
 * venta_pago con posible mismatch).
 *
 * @param {object} row — shape esperado:
 *   {
 *     caja_movimiento_id, caja_id, caja_moneda, caja_nombre,
 *     mov_monto, mov_monto_usd,
 *     venta_id, order_id,
 *     pago_monto, pago_moneda, pago_tc,
 *   }
 * @returns {object} — { accion, razon, nuevo_monto?, nuevo_monto_usd?, delta? }
 */
function analizarCandidato(row) {
  const pagoMoneda  = String(row.pago_moneda || '');
  const cajaMoneda  = String(row.caja_moneda || '');
  const pagoMonto   = Number(row.pago_monto);
  const movMonto    = Number(row.mov_monto);
  const pagoTc      = row.pago_tc != null ? Number(row.pago_tc) : null;

  // 1) Misma moneda → nada que hacer (comportamiento pre-fix era passthrough,
  //    y el fix no cambia nada acá — el mov ya está bien).
  if (pagoMoneda === cajaMoneda) {
    return { accion: 'skip', razon: 'misma_moneda' };
  }

  // 2) Ambas fuertes (USD ↔ USDT) → paridad 1:1, no afecta el saldo.
  //    Decisión durable: no las tocamos, no ensucian el reporte.
  if (MONEDAS_FUERTES.has(pagoMoneda) && MONEDAS_FUERTES.has(cajaMoneda)) {
    return { accion: 'skip', razon: 'usd_usdt_paridad' };
  }

  // 3) Si el monto del mov ya NO es el crudo del pago, significa que fue
  //    convertido (POST-fix Fase A) o tocado manualmente por un operador.
  //    En cualquiera de los dos casos NO queremos re-tocarlo — corromperíamos
  //    algo que ya está bien o pisaríamos una intervención humana.
  //    Tolerancia de 0.01 para absorber drift de round2.
  if (Math.abs(movMonto - pagoMonto) > TOLERANCIA_MONTO_CRUDO) {
    return { accion: 'skip', razon: 'ya_convertido_o_tocado' };
  }

  // 4) En este punto: mismatch de moneda + monto todavía crudo → candidato
  //    real. Intentamos calcular la conversión con el mismo helper que usa
  //    `syncVentaCaja` en el fix Fase A — así la corrección histórica queda
  //    coherente con lo que hace el sistema hoy.
  const nuevoMonto = convertirMonto(pagoMonto, pagoMoneda, cajaMoneda, pagoTc);

  if (nuevoMonto === null) {
    // Distingo dos razones para el reporte al operador:
    //   - `falta_tc`: es fiat↔fuerte pero no hay TC. Podríamos completar
    //     pidiéndole al tenant el TC de esa fecha (o usando el TC default
    //     del país como fallback).
    //   - `par_no_soportado`: ARS↔UYU sin USD intermedio. Requiere decisión
    //     de negocio (¿convertir a USD como paso intermedio? ¿anular el mov?).
    const esLocalLocal = (
      (pagoMoneda === 'ARS' || pagoMoneda === 'UYU') &&
      (cajaMoneda === 'ARS' || cajaMoneda === 'UYU')
    );
    return {
      accion: 'revisar_manual',
      razon: esLocalLocal ? 'par_no_soportado' : 'falta_tc',
    };
  }

  // 5) Conversión OK — calculamos también el nuevo `monto_usd`. El helper
  //    `toUsd` asume que el monto está EN LA MONEDA DE LA CAJA (que es lo
  //    que vamos a persistir), no en la del pago. Por eso pasamos
  //    `nuevoMonto` + `cajaMoneda`, no `pagoMonto` + `pagoMoneda`.
  //    `pagoTc` es el que corresponde a esa venta específica — usamos el
  //    del pago, no un tc actual.
  const nuevoMontoUsd = round2(toUsd(nuevoMonto, cajaMoneda, pagoTc));
  const delta         = round2(nuevoMonto - movMonto);

  return {
    accion:          'reparar',
    nuevo_monto:     nuevoMonto,
    nuevo_monto_usd: nuevoMontoUsd,
    delta,
  };
}

/**
 * Agrupa un batch de resultados por tenant y arma un reporte estructurado.
 * El caller le pasa las rows YA con `tenant_id` y `tenant_slug` incluidos
 * (el SELECT del script hace el JOIN a `tenants`).
 *
 * @param {Array<object>} rows — cada row incluye tenant_id/slug + campos row
 * @returns {object} — reporte por tenant
 */
function armarReporte(rows) {
  const porTenant = new Map();

  for (const row of rows) {
    const key = row.tenant_slug || `tenant_${row.tenant_id}`;
    if (!porTenant.has(key)) {
      porTenant.set(key, {
        tenant_id: row.tenant_id,
        tenant_slug: row.tenant_slug,
        reparables: [],
        revisar_manual: [],
        skip: { count: 0, por_razon: {} },
        cajas_afectadas: new Set(),
      });
    }
    const bucket = porTenant.get(key);

    const analisis = analizarCandidato(row);
    const base = {
      caja_movimiento_id: row.caja_movimiento_id,
      caja_id:            row.caja_id,
      caja_nombre:        row.caja_nombre,
      caja_moneda:        row.caja_moneda,
      venta_id:           row.venta_id,
      order_id:           row.order_id,
      pago_monto:         Number(row.pago_monto),
      pago_moneda:        row.pago_moneda,
      pago_tc:            row.pago_tc != null ? Number(row.pago_tc) : null,
      mov_monto_actual:   Number(row.mov_monto),
    };

    if (analisis.accion === 'reparar') {
      bucket.reparables.push({
        ...base,
        mov_monto_nuevo:     analisis.nuevo_monto,
        mov_monto_usd_nuevo: analisis.nuevo_monto_usd,
        delta:               analisis.delta,
      });
      bucket.cajas_afectadas.add(row.caja_id);
    } else if (analisis.accion === 'revisar_manual') {
      bucket.revisar_manual.push({ ...base, razon: analisis.razon });
      bucket.cajas_afectadas.add(row.caja_id);
    } else {
      bucket.skip.count += 1;
      bucket.skip.por_razon[analisis.razon] = (bucket.skip.por_razon[analisis.razon] || 0) + 1;
    }
  }

  // Convertimos el Set de cajas a count para JSON serialización.
  const tenants = {};
  for (const [slug, b] of porTenant) {
    tenants[slug] = {
      tenant_id:       b.tenant_id,
      tenant_slug:     b.tenant_slug,
      cajas_afectadas: b.cajas_afectadas.size,
      reparables:      b.reparables,
      revisar_manual:  b.revisar_manual,
      skip:            b.skip,
    };
  }
  return { tenants, total_rows: rows.length };
}

module.exports = { analizarCandidato, armarReporte, MONEDAS_FUERTES };
