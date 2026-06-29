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

// Convierte un monto a USD. ARS usa el TC provisto; sin TC válido devuelve 0.
function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}

// Redondeo a 2 decimales estable.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
