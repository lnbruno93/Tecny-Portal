#!/usr/bin/env node
/**
 * backfill-caja-financiera.js — completa la trazabilidad histórica.
 *
 * TANDA 1 (junio 2026) hizo que TODO movimiento del módulo Financiera (manual
 * o pago a vendedor) impacte la caja `es_financiera=true`. Pero solo afecta
 * los movs nuevos: los comprobantes/pagos pre-TANDA 1 quedaron sin
 * caja_movimiento asociado, lo que hace que el saldo de la caja FV NO refleje
 * la historia real del módulo.
 *
 * Este script:
 *   1. Lista todos los comprobantes manuales (venta_id IS NULL) sin
 *      caja_movimiento donde `ref_tabla='comprobantes' AND ref_id=comp.id`.
 *   2. Lista todos los pagos sin egreso desde la caja FV donde
 *      `ref_tabla='pagos' AND ref_id=pago.id AND tipo='egreso'`.
 *   3. DRY-RUN por default: muestra qué se crearía + delta del saldo final.
 *      Con --apply: ejecuta en UNA tx, valida saldo final >= 0, COMMIT.
 *
 * Idempotente: el WHERE NOT EXISTS evita duplicar. Se puede correr varias veces.
 *
 * NO toca:
 *   · Comprobantes con venta_id NOT NULL — esos ya tienen movs creados por
 *     la venta misma (el flujo "venta con pago Financiera" siempre los creó).
 *   · Pagos legacy con caja_id IS NULL (pre-junio 2026 sprint USD) — esos
 *     nunca crearon ingreso destino tampoco; no agregamos el egreso para no
 *     hacer aparecer dinero saliendo de FV sin contraparte.
 *
 * Cómo correr:
 *   # Reporte (no destructivo, default):
 *   $ node scripts/backfill-caja-financiera.js
 *
 *   # Aplicar (con confirmación):
 *   $ node scripts/backfill-caja-financiera.js --apply
 *
 *   # Solo comprobantes (no pagos):
 *   $ node scripts/backfill-caja-financiera.js --solo-comprobantes
 *
 *   # Verbose: imprime cada mov individual:
 *   $ node scripts/backfill-caja-financiera.js --verbose
 */

const db = require('../src/config/database');
const {
  fmtARS, fmtDate, err400, CONCEPTOS, insertCajaMovimientosBatch,
} = require('./lib/backfillUtils');

// H2 (TANDA 1 trazab): lock ID arbitrario para pg_try_advisory_xact_lock.
// Diferente por script (financiera/tarjetas) — pueden correr en paralelo
// entre sí, pero no 2 corridas del MISMO backfill. Per-transaction lock:
// se libera al COMMIT/ROLLBACK automáticamente.
const ADVISORY_LOCK_ID = 0x6AC8F1FC; // arbitrary stable int32 (~1.79B)

function parseArgs(argv) {
  // Flags propios del script Financiera (soloComprobantes/soloPagos) +
  // los comunes (apply, verbose). Mantengo este parseArgs ad-hoc en vez de
  // usar parseCommonArgs() para no romper los `--solo-X` que ya documentamos.
  const args = { apply: false, verbose: false, soloComprobantes: false, soloPagos: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--solo-comprobantes') args.soloComprobantes = true;
    else if (a === '--solo-pagos') args.soloPagos = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('--')) {
      console.error(`Flag desconocido: ${a}. Usá --help.`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`backfill-caja-financiera.js — completa la trazabilidad histórica de la caja FV.

Uso:
  node scripts/backfill-caja-financiera.js [opts]

Opts:
  --apply              Aplica los cambios (default: dry-run).
  --verbose, -v        Imprime cada movimiento individualmente.
  --solo-comprobantes  Solo procesa comprobantes (omite pagos).
  --solo-pagos         Solo procesa pagos (omite comprobantes).
  --help, -h           Muestra esta ayuda.

Ejemplos:
  node scripts/backfill-caja-financiera.js                # reporte
  node scripts/backfill-caja-financiera.js --apply        # aplicar
`);
}

// fmtARS / fmtDate / err400 vienen de './lib/backfillUtils' (TANDA 4 trazab).

// ─── Lógica core (exportada para tests) ──────────────────────────────────────

/**
 * Listar comprobantes manuales sin caja_movimiento asociado.
 * Solo manuales (venta_id IS NULL): los autogenerados desde Venta ya tienen
 * mov creado por la venta misma.
 */
async function listarComprobantesPendientes(client) {
  const { rows } = await client.query(`
    SELECT c.id, c.fecha, c.cliente, c.monto_neto, c.referencia
      FROM comprobantes c
     WHERE c.deleted_at IS NULL
       AND c.venta_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM caja_movimientos cm
          WHERE cm.ref_tabla = 'comprobantes'
            AND cm.ref_id   = c.id
            AND cm.deleted_at IS NULL
       )
     ORDER BY c.fecha, c.id
  `);
  return rows;
}

/**
 * Listar pagos sin egreso desde caja FV. Solo pagos con caja_id NOT NULL
 * (post-junio 2026) — los legacy nunca crearon ingreso destino y no agregamos
 * el egreso para no descalabrar.
 */
async function listarPagosPendientes(client, fvId) {
  const { rows } = await client.query(`
    SELECT p.id, p.fecha, p.monto, p.referencia, mp.nombre AS caja_destino
      FROM pagos p
      LEFT JOIN metodos_pago mp ON mp.id = p.caja_id
     WHERE p.deleted_at IS NULL
       AND p.caja_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM caja_movimientos cm
          WHERE cm.ref_tabla = 'pagos'
            AND cm.ref_id   = p.id
            AND cm.caja_id  = $1
            AND cm.tipo     = 'egreso'
            AND cm.deleted_at IS NULL
       )
     ORDER BY p.fecha, p.id
  `, [fvId]);
  return rows;
}

async function getCajaFV(client) {
  const { rows } = await client.query(`
    SELECT id, nombre, moneda, saldo_inicial
      FROM metodos_pago
     WHERE es_financiera = true AND deleted_at IS NULL
     LIMIT 1
  `);
  return rows[0] || null;
}

async function getSaldoActual(client, cajaId) {
  const { rows } = await client.query(`
    SELECT mp.saldo_inicial
           + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) AS saldo
      FROM metodos_pago mp
      LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
     WHERE mp.id = $1
     GROUP BY mp.id, mp.saldo_inicial
  `, [cajaId]);
  return Number(rows[0]?.saldo || 0);
}

/**
 * Ejecuta el backfill dentro de una transacción. Si apply=false, ROLLBACK
 * (lo que hicimos no se persiste, pero el saldo proyectado es real).
 *
 * `silent: true` suprime el reporte humano (para uso desde endpoint HTTP —
 * el reporte se transmite en el JSON de respuesta, no en stdout).
 *
 * `userId` se estampa en cada caja_movimiento.user_id para audit trail.
 * En modo CLI (sin endpoint) queda null — visible como "operación de sistema".
 */
async function runBackfill({ apply, verbose, soloComprobantes, soloPagos, silent, userId } = {}) {
  const log = silent ? () => {} : (...args) => console.log(...args);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // H2: advisory lock per-transaction. Si otro admin ya está corriendo este
    // backfill en paralelo, abortamos limpio (no esperamos — preferimos error
    // claro). El ID es arbitrario pero estable, único por script.
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS got', [ADVISORY_LOCK_ID]);
    if (!lockRows[0]?.got) {
      throw err400('Otro backfill de caja Financiera ya está en curso. Esperá que termine y reintentá.');
    }

    const fv = await getCajaFV(client);
    if (!fv) {
      throw err400('No hay caja con es_financiera=true. Configurá una en Cajas → Config antes de correr el backfill.');
    }

    const saldoAntes = await getSaldoActual(client, fv.id);

    const comprobantes = soloPagos ? [] : await listarComprobantesPendientes(client);
    const pagos        = soloComprobantes ? [] : await listarPagosPendientes(client, fv.id);

    const totalCompromisos = comprobantes.reduce((s, c) => s + Number(c.monto_neto || 0), 0);
    const totalPagos       = pagos.reduce((s, p) => s + Number(p.monto || 0), 0);
    const saldoProyectado  = saldoAntes + totalCompromisos - totalPagos;

    // Reporte humano (CLI). El endpoint admin pasa silent=true.
    log('═'.repeat(70));
    log(`  Backfill caja FV  ·  ${apply ? 'APPLY' : 'DRY-RUN'}`);
    log('═'.repeat(70));
    log('');
    log(`Caja FV: #${fv.id} · "${fv.nombre}" · ${fv.moneda}`);
    log(`Saldo actual:        ${fmtARS(saldoAntes).padStart(18)}`);
    log('');

    if (verbose && comprobantes.length > 0) {
      log('─── Comprobantes manuales pendientes ─────────────────────');
      log('   ID    Fecha       Cliente                       Neto');
      for (const c of comprobantes) {
        const cliente = String(c.cliente || '').slice(0, 28).padEnd(28);
        log(`   ${String(c.id).padStart(4)}  ${fmtDate(c.fecha)}  ${cliente}  ${fmtARS(c.monto_neto).padStart(14)}`);
      }
      log('');
    }
    log(`Comprobantes pendientes: ${comprobantes.length.toString().padStart(4)} · +${fmtARS(totalCompromisos)}`);

    if (verbose && pagos.length > 0) {
      log('');
      log('─── Pagos sin egreso desde FV ────────────────────────────');
      log('   ID    Fecha       Caja destino                  Monto');
      for (const p of pagos) {
        const dest = String(p.caja_destino || '').slice(0, 28).padEnd(28);
        log(`   ${String(p.id).padStart(4)}  ${fmtDate(p.fecha)}  ${dest}  ${fmtARS(p.monto).padStart(14)}`);
      }
      log('');
    }
    log(`Pagos pendientes:        ${pagos.length.toString().padStart(4)} · −${fmtARS(totalPagos)}`);
    log('');
    log('─── Resumen ────────────────────────────────────────────────');
    log(`   Saldo actual:        ${fmtARS(saldoAntes).padStart(18)}`);
    log(`   + Comprobantes:      ${fmtARS(totalCompromisos).padStart(18)}`);
    log(`   − Pagos:             ${fmtARS(totalPagos).padStart(18)}`);
    log(`   ───────────────────────────────────────────────────────`);
    log(`   Saldo proyectado:    ${fmtARS(saldoProyectado).padStart(18)}`);
    log('');

    if (saldoProyectado < 0) {
      log('⚠️  ATENCIÓN: el saldo proyectado quedaría NEGATIVO.');
      log('   Probablemente hay pagos sin sus comprobantes contraparte.');
      log('   Investigá antes de aplicar; revisá si faltan comprobantes históricos.');
      log('');
    }

    // Datos estructurados para el caller (sirve UI + tests).
    const muestras = {
      comprobantes: comprobantes.slice(0, 10).map(c => ({
        id: c.id, fecha: fmtDate(c.fecha), cliente: c.cliente, monto_neto: Number(c.monto_neto),
      })),
      pagos: pagos.slice(0, 10).map(p => ({
        id: p.id, fecha: fmtDate(p.fecha), caja_destino: p.caja_destino, monto: Number(p.monto),
      })),
    };

    if (comprobantes.length === 0 && pagos.length === 0) {
      log('✓ Nada que backfillear. Todos los comprobantes/pagos ya tienen caja_movimiento.');
      await client.query('ROLLBACK');
      return {
        apply, comprobantes: 0, pagos: 0, saldoAntes, saldoProyectado, saldoProyectadoNegativo: false,
        totalCompromisos: 0, totalPagos: 0, muestras, skipped: true,
        caja: { id: fv.id, nombre: fv.nombre, moneda: fv.moneda },
      };
    }

    if (!apply) {
      log('Para aplicar:  node scripts/backfill-caja-financiera.js --apply');
      log('');
      await client.query('ROLLBACK');
      return {
        apply: false, comprobantes: comprobantes.length, pagos: pagos.length,
        saldoAntes, saldoProyectado, saldoProyectadoNegativo: saldoProyectado < 0,
        totalCompromisos, totalPagos, muestras,
        caja: { id: fv.id, nombre: fv.nombre, moneda: fv.moneda },
      };
    }

    // ── APPLY: insertar los caja_movimientos directamente con SQL ──
    // No usamos postCajaMovimiento porque su check de saldo no-negativo
    // rechazaría egresos intermedios mientras la caja se reconstruye
    // (ej. pago de marzo se aplica antes que comprobante de abril). El
    // saldo FINAL es lo que importa — y lo validamos al cierre.
    if (saldoProyectado < 0) {
      throw err400(`El saldo proyectado quedaría negativo (${fmtARS(saldoProyectado)}). ABORTADO.`);
    }

    // B2 audit trail: cada mov del backfill lleva user_id = admin que disparó
    // el endpoint. CLI sin endpoint deja null (= "operación de sistema").
    const uid = userId ?? null;

    // TANDA 2 trazab: batch INSERT con UNNEST en lugar de N round-trips.
    // Para casos reales (cientos/miles de filas) reduce el tiempo de tx
    // dramáticamente — y el advisory lock se libera antes.
    const comprObjInserted = await insertCajaMovimientosBatch(client,
      comprobantes.map(c => ({
        caja_id: fv.id, fecha: c.fecha, tipo: 'ingreso', monto: c.monto_neto,
        origen: 'financiera', ref_tabla: 'comprobantes', ref_id: c.id,
        concepto: CONCEPTOS.backfillComprobante(c.cliente, c.referencia),
        user_id: uid,
      }))
    );
    const pagosInserted = await insertCajaMovimientosBatch(client,
      pagos.map(p => ({
        caja_id: fv.id, fecha: p.fecha, tipo: 'egreso', monto: p.monto,
        origen: 'financiera', ref_tabla: 'pagos', ref_id: p.id,
        concepto: CONCEPTOS.backfillPago(p.caja_destino, p.referencia),
        user_id: uid,
      }))
    );

    // Validar saldo final post-inserts.
    const saldoFinal = await getSaldoActual(client, fv.id);
    if (saldoFinal < 0) {
      throw err400(`Saldo final ${fmtARS(saldoFinal)} es negativo. ROLLBACK.`);
    }

    await client.query('COMMIT');
    log(`✓ ${comprObjInserted} ingresos por comprobantes manuales`);
    log(`✓ ${pagosInserted} egresos por pagos`);
    log(`✓ Saldo final: ${fmtARS(saldoFinal)} (validado >= 0)`);
    log(`COMMIT.`);
    return {
      apply: true,
      comprobantes: comprObjInserted, pagos: pagosInserted,
      saldoAntes, saldoFinal,
      totalCompromisos, totalPagos,
      caja: { id: fv.id, nombre: fv.nombre, moneda: fv.moneda },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  try {
    await runBackfill(args);
  } catch (err) {
    console.error('');
    console.error(`✗ ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    await db.end().catch(() => {});
  }
}

// Solo correr CLI si se invocó directamente (no si se require() desde test).
if (require.main === module) {
  main();
}

module.exports = {
  runBackfill,
  listarComprobantesPendientes,
  listarPagosPendientes,
  getCajaFV,
  getSaldoActual,
};
