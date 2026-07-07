// Helpers de dinero compartidos por el módulo de ventas.
//
// 2026-06-29 (Multi-país F1): se agregan helpers para multi-país (AR/UY) sin
// romper exports existentes. La validación país-aware se centraliza acá vía
// `isMonedaValidaParaPais` para que la matriz país↔moneda viva en un solo
// lugar. Ver docs/design/multi-pais-uyu.md.

// ─── Matriz país ↔ monedas operativas ────────────────────────────────────
// Decisión durable (Lucas, 2026-06-29):
//   · USD y USDT son monedas universales — habilitadas en todos los países
//     (los resellers operan con USD/USDT contra mayoristas chinos sin importar
//     el país del tenant).
//   · ARS solo en AR; UYU solo en UY. El dropdown del UI filtra por
//     `tenant.pais` usando `isMonedaValidaParaPais`.
//   · El CHECK constraint de DB es permissive global (ARS/USD/USDT/UYU) — la
//     restricción fina vive acá + en Zod, no en la DB.

const MONEDAS_GLOBALES = ['USD', 'USDT']; // habilitadas en todos los países

const MONEDAS_POR_PAIS = {
  AR: ['ARS', 'USD', 'USDT'],
  UY: ['UYU', 'USD', 'USDT'],
};

const TODAS_LAS_MONEDAS = ['ARS', 'UYU', 'USD', 'USDT'];

/**
 * Retorna true si la moneda está habilitada para el país.
 * País desconocido → permite solo monedas globales (defensive: mejor seguro
 * que romper si en el futuro agregamos un país y se nos olvida actualizar
 * la matriz).
 *
 * @param {string} moneda - 'ARS' | 'USD' | 'USDT' | 'UYU'
 * @param {string} pais - 'AR' | 'UY'
 * @returns {boolean}
 */
function isMonedaValidaParaPais(moneda, pais) {
  const lista = MONEDAS_POR_PAIS[pais];
  if (!lista) {
    return MONEDAS_GLOBALES.includes(moneda);
  }
  return lista.includes(moneda);
}

/**
 * Hard-asserta que la moneda esté habilitada para el país del tenant.
 * Llamar en endpoints de escritura DESPUÉS del parse Zod y ANTES de los
 * INSERT/UPDATE. Si la moneda no está habilitada, lanza un error con
 * `status=400` y `code='moneda_no_valida_para_pais'` que el error handler
 * global devuelve como JSON.
 *
 * Diseño: la matriz país↔moneda es un check de policy de negocio (no de
 * shape), por eso vive acá y no en Zod. El Zod schema acepta cualquiera de
 * las 4 monedas (ARS/USD/USDT/UYU) para que la validación sea uniforme entre
 * países; el handler decide cuáles son válidas para el tenant.
 *
 * @param {string} moneda - 'ARS' | 'USD' | 'USDT' | 'UYU'
 * @param {string} pais - 'AR' | 'UY'
 * @param {string} [fieldName='moneda'] - nombre del campo del body para
 *   contextualizar el error (ej. 'costo_moneda' vs 'precio_moneda').
 * @throws {Error} con status=400 si la moneda no está habilitada
 */
function assertMonedaValidaParaPais(moneda, pais, fieldName = 'moneda') {
  // moneda null/undefined no es nuestro problema — Zod debió rebotarlo si era
  // requerido. Si llegó null/undefined acá (caso opcional), pasa sin chequeo.
  if (moneda == null) return;
  if (!isMonedaValidaParaPais(moneda, pais)) {
    const err = new Error(
      `Moneda '${moneda}' no está habilitada para el país '${pais}'.`
    );
    err.status = 400;
    err.code = 'moneda_no_valida_para_pais';
    err.detail = { moneda, pais, field: fieldName };
    throw err;
  }
}

/**
 * Retorna la moneda local (fiat no-USD) del país.
 * AR → 'ARS', UY → 'UYU'.
 *
 * @param {string} pais - 'AR' | 'UY'
 * @returns {string}
 */
function getMonedaLocalPais(pais) {
  return pais === 'UY' ? 'UYU' : 'ARS';
}

/**
 * Lee el TC default UYU/USD o ARS/USD del país desde `tc_defaults_pais`.
 * Tabla creada en migration 20260629100003 con seed inicial AR=1400, UY=40.
 *
 * @param {object} client - pg client (cualquier rol con SELECT en tc_defaults_pais)
 * @param {string} pais - 'AR' | 'UY'
 * @returns {Promise<number|null>} TC numérico (ej. 1400 para AR, 40 para UY) o
 *                                  null si el país no tiene fila seedeada.
 */
async function getTcDefaultPais(client, pais) {
  const par = pais === 'UY' ? 'UYU/USD' : 'ARS/USD';
  const { rows } = await client.query(
    `SELECT valor FROM tc_defaults_pais WHERE pais = $1 AND par = $2`,
    [pais, par]
  );
  return rows[0] ? Number(rows[0].valor) : null;
}

// ─── Helpers monetarios pre-existentes ────────────────────────────────────

/**
 * Convierte un monto a USD.
 *
 *   - USD/USDT → retorna el monto tal cual (1:1).
 *   - ARS/UYU → divide por `tc` (unidades locales por USD). Sin `tc` válido
 *     devuelve 0 (no leak silencioso).
 *   - Cualquier otra moneda → devuelve 0 (defensive: mejor cero que corrupto).
 *
 * BLOCKER 2026-07-05 (auditoría UYU): la versión previa retornaba `return m`
 * como fallback, así que un monto UYU con tc caía a "monto tal cual" y se
 * persistía inflado 40x (ej: 40000 UYU se guardaba como total_usd=40000 en
 * lugar de 1000). Todos los tenants UY tenían `total_usd`, `ganancia_usd` y
 * `monto_usd` corruptos. El fix cambia:
 *   1. `UYU` se maneja explícitamente como `ARS` (fiat local con TC).
 *   2. El fallback pasa a `return 0` — si algún día llega una moneda nueva
 *      sin actualizar este helper, preferimos "cero visible" (que rompe el
 *      dashboard y alerta) antes que "monto crudo" (que se persiste corrupto
 *      y solo se detecta cuando el cliente reclama).
 *
 * El `tc` esperado es "unidades locales por USD":
 *   - AR: tc_venta ≈ 1400 (ARS/USD)
 *   - UY: tc_venta ≈ 40 (UYU/USD)
 *
 * @param {number|string} monto — cantidad en la moneda origen
 * @param {string} moneda — 'ARS' | 'UYU' | 'USD' | 'USDT'
 * @param {number|string} tc — cotización local/USD (solo relevante para ARS/UYU)
 * @returns {number} equivalente en USD (redondear con round2 si se persiste)
 */
function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS' || moneda === 'UYU') {
    return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  }
  return 0;
}

// Redondeo a 2 decimales estable.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Conversión pago→caja para syncVentaCaja + validación forward de mismatch
 * (fix #4 audit 2026-07-07).
 *
 * Contexto: un pago con `venta_pagos.moneda` distinta de la caja donde
 * ingresa hace que el saldo de la caja se calcule sumando montos de
 * monedas mixtas. El fix forward valida que si hay mismatch, el pago
 * traiga `tc` para convertir. El caja_movimiento se inserta ya en la
 * moneda de la caja para que el cálculo de saldo sea coherente.
 *
 * `tc` es siempre "local/USD" (ARS o UYU por USD).
 *
 * Casos soportados en Fase A:
 *   - Misma moneda:                monto sin cambio.
 *   - USD/USDT → ARS/UYU:          monto × tc.
 *   - ARS/UYU → USD/USDT:          monto / tc.
 *   - USD ↔ USDT:                  passthrough (paridad 1:1).
 *   - ARS ↔ UYU sin USD-intermedio: NO soportado (rechazar upstream).
 *
 * @param {number|string} monto — cantidad en `monedaSrc`
 * @param {string} monedaSrc — moneda del pago (source)
 * @param {string} monedaDst — moneda de la caja destino
 * @param {number|string} tc — cotización local/USD (obligatorio si hay conversión)
 * @returns {number|null} monto convertido a `monedaDst`, o null si NO se puede convertir.
 *   El caller distingue null (error) de 0 (monto original 0 legítimo).
 */
function convertirMonto(monto, monedaSrc, monedaDst, tc) {
  const m = Number(monto) || 0;
  if (monedaSrc === monedaDst) return round2(m);
  const src = String(monedaSrc || '');
  const dst = String(monedaDst || '');
  const esSrcFuerte = src === 'USD' || src === 'USDT';
  const esDstFuerte = dst === 'USD' || dst === 'USDT';
  const esSrcLocal  = src === 'ARS' || src === 'UYU';
  const esDstLocal  = dst === 'ARS' || dst === 'UYU';
  // USD ↔ USDT paridad 1:1.
  if (esSrcFuerte && esDstFuerte) return round2(m);
  // Local ↔ Local sin USD intermedio: no soportado en Fase A.
  // El rechazo lo hace el caller (400 en POST venta).
  if (esSrcLocal && esDstLocal) return null;
  const t = Number(tc);
  if (!Number.isFinite(t) || t <= 0) return null;
  // USD/USDT → ARS/UYU: monto local = monto USD × tc.
  if (esSrcFuerte && esDstLocal) return round2(m * t);
  // ARS/UYU → USD/USDT: monto USD = monto local / tc.
  if (esSrcLocal && esDstFuerte) return round2(m / t);
  // Combinación no reconocida.
  return null;
}

/**
 * Chequeo puro de si `venta_pagos.moneda` es compatible con la moneda
 * de su caja destino en Fase A. Usado por la validación del POST/PUT
 * de venta antes de disparar `syncVentaCaja`.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validarMonedasPagoCaja(monedaPago, monedaCaja, tc) {
  const converted = convertirMonto(1, monedaPago, monedaCaja, tc);
  if (converted !== null) return { ok: true };
  const src = String(monedaPago || '');
  const dst = String(monedaCaja || '');
  if ((src === 'ARS' || src === 'UYU') && (dst === 'ARS' || dst === 'UYU') && src !== dst) {
    return { ok: false, reason: `Conversión ${src} → ${dst} no soportada (requiere USD como intermedio).` };
  }
  return { ok: false, reason: `Falta TC válido para convertir el pago de ${src} a la caja en ${dst}.` };
}

// Cálculo bruto → comisión → neto usado por Tarjetas (cobros automáticos
// desde Ventas, cobros previos, edits). Antes el cálculo estaba duplicado en
// 4 lugares (lib/tarjetas.js, routes/tarjetas.js POST cobros-iniciales y
// PATCH liquidación, frontend Tarjetas.jsx). Helper único previene drift
// entre los call sites (un día alguien iba a cambiar el redondeo en un solo
// lado y romper la coherencia entre preview y persistencia).
//
//   bruto:    monto antes de comisión (positivo)
//   pct:      porcentaje 0..100 (puede ser null/undefined → asume 0)
// Devuelve { bruto, pct, comision, neto } — todos pasados por round2.
function computeNeto(bruto, pct) {
  const b = round2(Number(bruto) || 0);
  const p = round2(Number(pct) || 0);
  const comision = round2(b * p / 100);
  const neto = round2(b - comision);
  return { bruto: b, pct: p, comision, neto };
}

module.exports = {
  // pre-existentes
  toUsd,
  round2,
  computeNeto,
  // fix #4 audit 2026-07-07 — conversión pago→caja Fase A forward-only
  convertirMonto,
  validarMonedasPagoCaja,
  // multi-país F1
  MONEDAS_GLOBALES,
  MONEDAS_POR_PAIS,
  TODAS_LAS_MONEDAS,
  isMonedaValidaParaPais,
  getMonedaLocalPais,
  getTcDefaultPais,
  // multi-país F2
  assertMonedaValidaParaPais,
};
