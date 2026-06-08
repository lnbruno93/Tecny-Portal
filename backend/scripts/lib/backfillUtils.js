// Utilidades compartidas entre los scripts de backfill (financiera + tarjetas).
//
// Extraídas en TANDA 4 trazabilidad: antes los 2 scripts duplicaban ~55-60%
// del código (formatters, parseArgs común, INSERT plantilla, helper de err).
// Si suma un 3er backfill, importar desde acá.
//
// NO incluye la lógica core de cada backfill — eso vive en su script porque
// el SQL y los invariantes a validar son específicos del módulo.

// ─── Formateo ──────────────────────────────────────────────────────────────

function fmtARS(n) {
  return '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// ─── Errores con status para el endpoint admin ────────────────────────────

// Helper de error con status — el endpoint admin lo levanta a HTTP 400.
// Antes los scripts throwean `new Error(...)` y el endpoint hacía regex sobre
// el mensaje. Frágil — ahora confiamos en err.status (consistente con el
// resto del backend).
function err400(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// ─── Conceptos de movimientos (constants, no strings inline) ──────────────
//
// Estos strings van al `concepto` de cada caja_movimientos. Mantenerlos en
// un módulo evita drift entre el forward path (financiera.js/tarjetas.js) y
// el backfill (que reconstruye históricos).
const CONCEPTOS = {
  backfillComprobante:  (cliente, ref) => `Backfill venta previa · ${cliente}${ref ? ' · ' + ref : ''}`,
  backfillPago:         (cajaDestino, ref) => `Backfill egreso pago vendedor → ${cajaDestino || '?'}${ref ? ' · ' + ref : ''}`,
  backfillCobro:        (ventaId) => `Backfill ${ventaId ? `cobro venta #${ventaId}` : 'cobro previo'}`,
  backfillLiquidacion:  (cajaDestino) => `Backfill egreso liquidación → ${cajaDestino || '?'}`,
};

// ─── parseArgs común ──────────────────────────────────────────────────────
//
// Cada script puede tener flags propios (ej. --solo-comprobantes en
// financiera). Esta función parsea los comunes y devuelve el resto crudo
// para que el caller los procese.
function parseCommonArgs(argv, { onUnknown } = {}) {
  const args = { apply: false, verbose: false };
  const rest = [];
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) {
      if (onUnknown) { onUnknown(a); }
      else {
        console.error(`Flag desconocido: ${a}. Usá --help.`);
        process.exit(2);
      }
    } else {
      rest.push(a);
    }
  }
  return { args, rest };
}

// ─── INSERT plantilla para caja_movimientos del backfill ───────────────────
//
// Los 2 scripts INSERTan filas con shape idéntico. Centralizar el SQL acá
// elimina drift (ej. orden de columnas, manejo de monto_usd).
//
// NO usa postCajaMovimiento porque durante reconstrucción los saldos
// intermedios pueden ser negativos transitoriamente. Los scripts validan
// saldo final >= 0 al cierre de la tx.
async function insertCajaMovimientoBackfill(client, {
  caja_id, fecha, tipo, monto, origen, ref_tabla, ref_id, concepto, user_id,
}) {
  await client.query(`
    INSERT INTO caja_movimientos
      (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
    VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)
  `, [caja_id, fecha, tipo, monto, origen, ref_tabla, ref_id, concepto, user_id ?? null]);
}

// Versión batch del INSERT con UNNEST — un solo round-trip a Postgres por
// lote, vs N round-trips de insertCajaMovimientoBackfill (TANDA 2 trazab,
// hallazgo Performance). Vale la pena cuando hay >100 filas; con 5000+
// (caso real de prod) es ~50× más rápido.
//
// `rows` es un array de objetos con el mismo shape que insertCajaMovimientoBackfill.
// Devuelve la cantidad insertada.
async function insertCajaMovimientosBatch(client, rows) {
  if (rows.length === 0) return 0;
  // Construir arrays paralelos para UNNEST. Cada uno tipado explícitamente
  // (postgres node driver no inferiría int[] sin la cast en UNNEST).
  const cajaIds   = rows.map(r => r.caja_id);
  const fechas    = rows.map(r => r.fecha);
  const tipos     = rows.map(r => r.tipo);
  const montos    = rows.map(r => r.monto);
  const origenes  = rows.map(r => r.origen);
  const refTablas = rows.map(r => r.ref_tabla);
  const refIds    = rows.map(r => r.ref_id);
  const conceptos = rows.map(r => r.concepto);
  const userIds   = rows.map(r => r.user_id ?? null);

  await client.query(`
    INSERT INTO caja_movimientos
      (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
    SELECT caja_id, fecha, tipo, monto, monto AS monto_usd, origen, ref_tabla, ref_id, concepto, user_id
      FROM UNNEST(
        $1::int[],         -- caja_id
        $2::date[],        -- fecha
        $3::text[],        -- tipo
        $4::numeric[],     -- monto (= monto_usd, ver insertCajaMovimientoBackfill)
        $5::text[],        -- origen
        $6::text[],        -- ref_tabla
        $7::int[],         -- ref_id
        $8::text[],        -- concepto
        $9::int[]          -- user_id (NULL ok)
      ) AS t(caja_id, fecha, tipo, monto, origen, ref_tabla, ref_id, concepto, user_id)
  `, [cajaIds, fechas, tipos, montos, origenes, refTablas, refIds, conceptos, userIds]);
  return rows.length;
}

module.exports = {
  fmtARS, fmtDate,
  err400,
  CONCEPTOS,
  parseCommonArgs,
  insertCajaMovimientoBackfill,
  insertCajaMovimientosBatch,
};
