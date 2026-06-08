#!/usr/bin/env node
/**
 * backfill-caja-tarjetas.js — completa la trazabilidad histórica de tarjetas.
 *
 * TANDA 1 Tarjetas (PR #122) hizo que TODO movimiento del módulo Tarjetas
 * (cobro de venta, cobro previo manual, liquidación) impacte la caja-tarjeta
 * (cada tarjeta con es_tarjeta=true es su propia caja). Pero solo afecta
 * los movs nuevos: los tarjeta_movimientos pre-TANDA 1 quedaron sin
 * caja_movimiento asociado en su caja-tarjeta, así que el saldo "Te deben"
 * del módulo Tarjetas NO coincide con el saldo_actual de la caja-tarjeta.
 *
 * Este script reconstruye esa simetría:
 *   1. Lista TODOS los tarjeta_movimientos tipo='cobro' sin +ingreso en su
 *      caja-tarjeta (ref_tabla='tarjeta_movimientos', tipo='ingreso').
 *   2. Lista TODOS los tarjeta_movimientos tipo='liquidacion' sin −egreso en
 *      su caja-tarjeta (ref_tabla='tarjeta_movimientos', tipo='egreso').
 *      (El +ingreso a la caja destino ya existía y NO se toca.)
 *   3. DRY-RUN por default: agrupa por tarjeta y muestra el delta proyectado.
 *      Con --apply: ejecuta en UNA tx, valida saldo final >= 0 PER tarjeta,
 *      COMMIT.
 *
 * Idempotente: WHERE NOT EXISTS evita duplicar. Correrlo 2 veces es seguro.
 *
 * Cómo correr:
 *   node scripts/backfill-caja-tarjetas.js             # reporte (no destructivo)
 *   node scripts/backfill-caja-tarjetas.js --apply     # ejecutar
 *   node scripts/backfill-caja-tarjetas.js --verbose   # detalle de cada mov
 *
 * Nota: A diferencia de backfill-caja-financiera (que tiene flags
 * --solo-comprobantes / --solo-pagos), acá no exponemos --solo-cobros ni
 * --solo-liquidaciones — los 2 paths son simétricos y no hubo caso de uso
 * para correr uno sin el otro. Si llegan a hacer falta, agregar siguiendo el
 * patrón de financiera.
 */

const db = require('../src/config/database');
const {
  fmtARS, fmtDate, err400, CONCEPTOS, insertCajaMovimientosBatch,
} = require('./lib/backfillUtils');

// H2 (TANDA 1 trazab): lock ID arbitrario para pg_try_advisory_xact_lock.
// Diferente del de financiera para permitir corridas paralelas entre scripts
// distintos, pero no 2 corridas del MISMO. Per-transaction.
const ADVISORY_LOCK_ID = 0x6AC8F2A0; // arbitrary stable int32

function parseArgs(argv) {
  const args = { apply: false, verbose: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('--')) {
      console.error(`Flag desconocido: ${a}. Usá --help.`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`backfill-caja-tarjetas.js — reconstruye la trazabilidad histórica de cada caja-tarjeta.

Uso:
  node scripts/backfill-caja-tarjetas.js [opts]

Opts:
  --apply         Aplica los cambios (default: dry-run).
  --verbose, -v   Imprime cada movimiento individualmente.
  --help, -h      Muestra esta ayuda.

Ejemplos:
  node scripts/backfill-caja-tarjetas.js                # reporte
  node scripts/backfill-caja-tarjetas.js --apply        # aplicar`);
}

// fmtARS / fmtDate / err400 vienen de './lib/backfillUtils' (TANDA 4 trazab).

// ─── Lógica core (exportada para tests) ──────────────────────────────────────

/**
 * Lista cobros sin su +ingreso en la caja-tarjeta. Cualquier tipo de cobro
 * (de venta o previo manual) — ambos deben impactar la caja-tarjeta hoy.
 */
async function listarCobrosPendientes(client) {
  const { rows } = await client.query(`
    SELECT tm.id, tm.metodo_pago_id, tm.fecha, tm.monto_neto, tm.moneda,
           tm.venta_id, mp.nombre AS tarjeta_nombre
      FROM tarjeta_movimientos tm
      JOIN metodos_pago mp ON mp.id = tm.metodo_pago_id
     WHERE tm.tipo = 'cobro'
       AND tm.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM caja_movimientos cm
          WHERE cm.ref_tabla = 'tarjeta_movimientos'
            AND cm.ref_id   = tm.id
            AND cm.caja_id  = tm.metodo_pago_id
            AND cm.tipo     = 'ingreso'
            AND cm.deleted_at IS NULL
       )
     ORDER BY tm.metodo_pago_id, tm.fecha, tm.id
  `);
  return rows;
}

/**
 * Lista liquidaciones sin su −egreso en la caja-tarjeta. El +ingreso a la
 * caja destino ya existía pre-TANDA 1 y no se toca.
 */
async function listarLiquidacionesPendientes(client) {
  const { rows } = await client.query(`
    SELECT tm.id, tm.metodo_pago_id, tm.fecha, tm.monto_neto, tm.moneda,
           tm.caja_id AS caja_destino_id, mp.nombre AS tarjeta_nombre,
           mpd.nombre AS caja_destino_nombre
      FROM tarjeta_movimientos tm
      JOIN metodos_pago mp ON mp.id = tm.metodo_pago_id
      LEFT JOIN metodos_pago mpd ON mpd.id = tm.caja_id
     WHERE tm.tipo = 'liquidacion'
       AND tm.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM caja_movimientos cm
          WHERE cm.ref_tabla = 'tarjeta_movimientos'
            AND cm.ref_id   = tm.id
            AND cm.caja_id  = tm.metodo_pago_id
            AND cm.tipo     = 'egreso'
            AND cm.deleted_at IS NULL
       )
     ORDER BY tm.metodo_pago_id, tm.fecha, tm.id
  `);
  return rows;
}

async function getTarjetas(client) {
  const { rows } = await client.query(`
    SELECT id, nombre, moneda
      FROM metodos_pago
     WHERE es_tarjeta = true AND deleted_at IS NULL
     ORDER BY id
  `);
  return rows;
}

async function getSaldoTarjeta(client, tarjetaId) {
  const { rows } = await client.query(`
    SELECT mp.saldo_inicial
           + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) AS saldo
      FROM metodos_pago mp
      LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
     WHERE mp.id = $1
     GROUP BY mp.id, mp.saldo_inicial
  `, [tarjetaId]);
  return Number(rows[0]?.saldo || 0);
}

// TANDA 2 trazab: trae saldo_actual de TODAS las tarjetas en 1 query (vs N).
// Para 50 tarjetas pasa de 50 LEFT JOIN/GROUP BY a 1 — diferencia notable si
// caja_movimientos tiene cientos de miles de filas.
//
// Devuelve un Map<tarjetaId, Number(saldo)> para lookup O(1).
async function getSaldosTodasTarjetas(client) {
  const { rows } = await client.query(`
    SELECT mp.id,
           mp.saldo_inicial
           + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) AS saldo
      FROM metodos_pago mp
      LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
     WHERE mp.es_tarjeta = true AND mp.deleted_at IS NULL
     GROUP BY mp.id, mp.saldo_inicial
  `);
  const map = new Map();
  for (const r of rows) map.set(r.id, Number(r.saldo || 0));
  return map;
}

/**
 * Ejecuta el backfill dentro de una transacción. Si apply=false, ROLLBACK
 * (lo que hicimos no se persiste, pero el saldo proyectado es real).
 *
 * `silent: true` suprime el reporte humano — para uso desde endpoint admin
 * (el reporte se transmite en el JSON de respuesta).
 *
 * `userId` se estampa en cada caja_movimiento.user_id para audit trail.
 * En modo CLI queda null (= "operación de sistema").
 */
async function runBackfill({ apply, verbose, silent, userId } = {}) {
  const log = silent ? () => {} : (...args) => console.log(...args);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // H2: advisory lock per-transaction (ver comentario en script Financiera).
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS got', [ADVISORY_LOCK_ID]);
    if (!lockRows[0]?.got) {
      throw err400('Otro backfill de cajas Tarjeta ya está en curso. Esperá que termine y reintentá.');
    }

    const tarjetas = await getTarjetas(client);
    if (tarjetas.length === 0) {
      throw err400('No hay tarjetas configuradas (metodos_pago con es_tarjeta=true). Configurá al menos una en Cajas → Config antes de correr el backfill.');
    }

    const cobros        = await listarCobrosPendientes(client);
    const liquidaciones = await listarLiquidacionesPendientes(client);

    // TANDA 2 trazab: 1 query bulk en vez de N getSaldoTarjeta(). Performance.
    const saldosMap = await getSaldosTodasTarjetas(client);

    // Agrupar por tarjeta para el reporte + para validar saldo final por tarjeta.
    const porTarjeta = new Map(); // tarjetaId → { tarjeta, saldoAntes, cobros, liquidaciones, totalCobros, totalLiq, saldoProyectado }
    for (const t of tarjetas) {
      porTarjeta.set(t.id, {
        tarjeta: t,
        saldoAntes: saldosMap.get(t.id) ?? 0,
        cobros: [],
        liquidaciones: [],
        totalCobros: 0,
        totalLiq: 0,
        saldoProyectado: 0,
      });
    }
    for (const c of cobros) {
      const g = porTarjeta.get(c.metodo_pago_id);
      if (!g) continue; // tarjeta soft-deleted — defensa
      g.cobros.push(c);
      g.totalCobros += Number(c.monto_neto || 0);
    }
    for (const l of liquidaciones) {
      const g = porTarjeta.get(l.metodo_pago_id);
      if (!g) continue;
      g.liquidaciones.push(l);
      g.totalLiq += Number(l.monto_neto || 0);
    }
    for (const g of porTarjeta.values()) {
      g.saldoProyectado = g.saldoAntes + g.totalCobros - g.totalLiq;
    }

    // Reporte humano (CLI). El endpoint admin pasa silent=true.
    log('═'.repeat(70));
    log(`  Backfill cajas Tarjetas  ·  ${apply ? 'APPLY' : 'DRY-RUN'}`);
    log('═'.repeat(70));
    log('');

    let totalCobros = 0, totalLiq = 0, hayNegativos = false;
    for (const g of porTarjeta.values()) {
      const { tarjeta, saldoAntes, saldoProyectado } = g;
      const cnt = g.cobros.length + g.liquidaciones.length;
      if (cnt === 0) continue;
      totalCobros += g.cobros.length;
      totalLiq    += g.liquidaciones.length;
      if (saldoProyectado < 0) hayNegativos = true;

      log(`Tarjeta #${tarjeta.id} · "${tarjeta.nombre}" (${tarjeta.moneda})`);
      log(`  Saldo actual:        ${fmtARS(saldoAntes).padStart(18)}`);
      log(`  + Cobros (${g.cobros.length}):           ${fmtARS(g.totalCobros).padStart(18)}`);
      log(`  − Liquidaciones (${g.liquidaciones.length}):    ${fmtARS(g.totalLiq).padStart(18)}`);
      log(`  Saldo proyectado:    ${fmtARS(saldoProyectado).padStart(18)} ${saldoProyectado < 0 ? '⚠️  NEGATIVO' : ''}`);
      if (verbose) {
        for (const c of g.cobros) {
          log(`    +ingreso ${fmtDate(c.fecha)}  mov#${c.id}  ${fmtARS(c.monto_neto).padStart(14)}${c.venta_id ? `  (venta #${c.venta_id})` : ''}`);
        }
        for (const l of g.liquidaciones) {
          log(`    −egreso  ${fmtDate(l.fecha)}  mov#${l.id}  ${fmtARS(l.monto_neto).padStart(14)}  → ${l.caja_destino_nombre || '?'}`);
        }
      }
      log('');
    }

    log('─── Total ──────────────────────────────────────────────────');
    log(`   Cobros pendientes:        ${totalCobros}`);
    log(`   Liquidaciones pendientes: ${totalLiq}`);
    log('');

    if (hayNegativos) {
      log('⚠️  ATENCIÓN: alguna tarjeta quedaría con saldo NEGATIVO post-backfill.');
      log('   Probablemente hay liquidaciones sin sus cobros contraparte registrados.');
      log('   Investigá antes de aplicar; revisá si faltan cobros previos históricos.');
      log('');
    }

    // Datos estructurados para el caller (UI + tests).
    const muestras = {
      // Top 10 cobros (mayor monto) y top 10 liquidaciones — los más impactantes.
      cobros: [...cobros].sort((a, b) => Number(b.monto_neto) - Number(a.monto_neto)).slice(0, 10)
        .map(c => ({ id: c.id, fecha: fmtDate(c.fecha), tarjeta: c.tarjeta_nombre, monto_neto: Number(c.monto_neto), venta_id: c.venta_id })),
      liquidaciones: [...liquidaciones].sort((a, b) => Number(b.monto_neto) - Number(a.monto_neto)).slice(0, 10)
        .map(l => ({ id: l.id, fecha: fmtDate(l.fecha), tarjeta: l.tarjeta_nombre, monto: Number(l.monto_neto), caja_destino: l.caja_destino_nombre })),
    };

    // Por tarjeta — listado abreviado para el frontend.
    const porTarjetaArr = Array.from(porTarjeta.values())
      .filter(g => g.cobros.length + g.liquidaciones.length > 0)
      .map(g => ({
        tarjeta: g.tarjeta,
        saldoAntes: g.saldoAntes,
        saldoProyectado: g.saldoProyectado,
        cobros: g.cobros.length,
        totalCobros: g.totalCobros,
        liquidaciones: g.liquidaciones.length,
        totalLiq: g.totalLiq,
      }));

    if (cobros.length === 0 && liquidaciones.length === 0) {
      log('✓ Nada que backfillear. Todas las tarjetas tienen su trazabilidad al día.');
      await client.query('ROLLBACK');
      return {
        apply, cobros: 0, liquidaciones: 0,
        porTarjeta: porTarjetaArr, muestras, hayNegativos: false, skipped: true,
      };
    }

    if (!apply) {
      log('Para aplicar:  node scripts/backfill-caja-tarjetas.js --apply');
      log('');
      await client.query('ROLLBACK');
      return {
        apply: false, cobros: cobros.length, liquidaciones: liquidaciones.length,
        porTarjeta: porTarjetaArr, muestras, hayNegativos,
      };
    }

    // ── APPLY ──
    // INSERTs directos (NO postCajaMovimiento) — durante la reconstrucción,
    // los saldos intermedios pueden bajar bajo 0 si una liquidación viene
    // antes que su cobro contraparte en el orden. Validamos saldo FINAL
    // por tarjeta al cierre.
    if (hayNegativos) {
      throw err400(`El saldo proyectado de al menos una tarjeta quedaría negativo. ABORTADO sin tocar la DB.`);
    }

    // B2 audit trail: ver comentario en backfill-caja-financiera.
    const uid = userId ?? null;

    // TANDA 2 trazab: batch INSERT con UNNEST.
    const cobrosOk = await insertCajaMovimientosBatch(client,
      cobros.map(c => ({
        caja_id: c.metodo_pago_id, fecha: c.fecha, tipo: 'ingreso',
        monto: c.monto_neto,
        origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: c.id,
        concepto: CONCEPTOS.backfillCobro(c.venta_id),
        user_id: uid,
      }))
    );
    const liqOk = await insertCajaMovimientosBatch(client,
      liquidaciones.map(l => ({
        caja_id: l.metodo_pago_id, fecha: l.fecha, tipo: 'egreso',
        monto: l.monto_neto,
        origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: l.id,
        concepto: CONCEPTOS.backfillLiquidacion(l.caja_destino_nombre),
        user_id: uid,
      }))
    );

    // Sanity check post-apply: ninguna caja-tarjeta puede quedar en negativo.
    // TANDA 2 trazab: 1 query bulk para todos los saldos finales (vs N).
    const saldosFinalesMap = await getSaldosTodasTarjetas(client);
    for (const g of porTarjeta.values()) {
      if (g.cobros.length + g.liquidaciones.length === 0) continue;
      const saldoFinal = saldosFinalesMap.get(g.tarjeta.id) ?? 0;
      if (saldoFinal < 0) {
        throw err400(`Saldo final de "${g.tarjeta.nombre}" es negativo (${fmtARS(saldoFinal)}). ROLLBACK.`);
      }
    }

    await client.query('COMMIT');
    log(`✓ ${cobrosOk} ingresos por cobros`);
    log(`✓ ${liqOk} egresos por liquidaciones`);
    log(`✓ Saldo final validado >= 0 por cada tarjeta`);
    log(`COMMIT.`);
    return {
      apply: true, cobros: cobrosOk, liquidaciones: liqOk,
      porTarjeta: porTarjetaArr, muestras,
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

if (require.main === module) {
  main();
}

module.exports = {
  runBackfill,
  listarCobrosPendientes,
  listarLiquidacionesPendientes,
  getTarjetas,
  getSaldoTarjeta,
};
