#!/usr/bin/env node
/**
 * backfill-comision-total-metodos.js — popular el costo financiero histórico.
 *
 * Tema C.2 (2026-06-13). PR C.1 agregó la columna `ventas.comision_total_metodos`
 * con DEFAULT 0 y wireó el sync en POST/PUT/DELETE de venta. Pero las ventas
 * pre-C.1 quedaron en 0 por DEFAULT — ganancia bruta inflada en el dashboard
 * para toda la historia.
 *
 * Este script reconstruye la columna corriendo `syncComisionTotalMetodos` sobre
 * cada venta activa (estado != 'cancelado', deleted_at IS NULL). El helper es
 * idempotente: lee de tarjeta_movimientos + comprobantes (fuentes congeladas
 * al momento del cobro) y escribe el valor calculado en la columna.
 *
 * Por qué no es destructivo:
 *   · NO crea ni borra filas — solo UPDATE en la columna nueva.
 *   · NO toca tarjeta_movimientos ni comprobantes (fuentes de verdad).
 *   · NO toca ganancia_usd ni total_usd.
 *   · Idempotente: correrlo N veces deja el mismo valor.
 *
 * Cómo correr:
 *   node scripts/backfill-comision-total-metodos.js              # dry-run
 *   node scripts/backfill-comision-total-metodos.js --apply      # ejecutar
 *   node scripts/backfill-comision-total-metodos.js --verbose    # detalle por venta
 *
 * Validación post-apply:
 *   El dashboard mensual (PR C.3) restará comision_total_metodos a la
 *   ganancia bruta. Si después del backfill ves ganancias netas más bajas que
 *   las reportadas históricamente, es esperado — esa era la "ganancia
 *   inflada" pre-fix. Documentar el delta para que no se interprete como
 *   pérdida nueva.
 */

const db = require('../src/config/database');
const { syncComisionTotalMetodos, sumComisionesMetodosUsd } = require('../src/lib/comisionesMetodos');
const { fmtDate, err400 } = require('./lib/backfillUtils');

// Advisory lock ID único — distinto de financiera (0x6AC8F2A0+) y tarjetas.
// Per-transaction; previene 2 backfills concurrentes del MISMO script.
const ADVISORY_LOCK_ID = 0x7C312000;

function fmtUsd(n) {
  return 'USD ' + (Number(n) || 0).toFixed(2);
}

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
  console.log(`backfill-comision-total-metodos.js — popular costo financiero histórico.

Uso:
  node scripts/backfill-comision-total-metodos.js [opts]

Opts:
  --apply         Aplica los cambios (default: dry-run).
  --verbose, -v   Imprime cada venta cuya columna cambia.
  --help, -h      Muestra esta ayuda.

Ejemplos:
  node scripts/backfill-comision-total-metodos.js                # reporte
  node scripts/backfill-comision-total-metodos.js --apply        # aplicar`);
}

/**
 * Lista ventas activas elegibles para backfill. Filtramos por:
 *   · estado != 'cancelado' (las canceladas tienen sus filas fuente soft-deleted
 *     → SUM = 0, que ya es el DEFAULT; no necesitan UPDATE).
 *   · deleted_at IS NULL (consistencia con el resto del módulo).
 *
 * Ordenamos por id para que el reporte sea reproducible.
 */
async function listarVentasActivas(client) {
  const { rows } = await client.query(`
    SELECT id, order_id, fecha, cliente_nombre,
           comision_total_metodos AS valor_actual
      FROM ventas
     WHERE deleted_at IS NULL AND estado != 'cancelado'
     ORDER BY id
  `);
  return rows;
}

/**
 * Ejecuta el backfill dentro de una transacción. apply=false → ROLLBACK
 * (los UPDATE no se persisten, pero los valores proyectados son reales).
 *
 * `silent` y `userId` siguen el contrato de los otros backfills (uso desde
 * endpoint admin). Acá `userId` NO se usa directamente — comision_total_metodos
 * no tiene audit trail propio; el cambio queda implícito en el commit.
 */
async function runBackfill({ apply, verbose, silent } = {}) {
  const log = silent ? () => {} : (...args) => console.log(...args);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS got', [ADVISORY_LOCK_ID]
    );
    if (!lockRows[0]?.got) {
      throw err400('Otro backfill de comision_total_metodos ya está en curso. Esperá que termine y reintentá.');
    }

    const ventas = await listarVentasActivas(client);
    log('═'.repeat(70));
    log(`  Backfill ventas.comision_total_metodos  ·  ${apply ? 'APPLY' : 'DRY-RUN'}`);
    log('═'.repeat(70));
    log('');
    log(`Ventas activas elegibles: ${ventas.length}`);
    log('');

    // Por venta: calcular valor nuevo. Comparamos contra el actual para saber
    // si cambia (idempotencia + reporte preciso).
    const cambios = [];
    let totalDelta = 0;
    for (const v of ventas) {
      const nuevo  = await sumComisionesMetodosUsd(client, v.id);
      const actual = Number(v.valor_actual || 0);
      if (Math.abs(nuevo - actual) >= 0.005) { // tolerancia 0.5 centavo (round2)
        cambios.push({ ...v, valor_nuevo: nuevo, delta: nuevo - actual });
        totalDelta += (nuevo - actual);
      }
    }

    log(`Ventas que cambiarían: ${cambios.length} de ${ventas.length}`);
    log(`Suma total delta:       ${fmtUsd(totalDelta)}  (USD que pasarían de "ganancia" a "costo financiero")`);
    log('');

    if (cambios.length === 0) {
      log('✓ Nada que backfillear. Todas las ventas tienen la columna correcta.');
      await client.query('ROLLBACK');
      return {
        apply, total_ventas: ventas.length, ventas_cambiadas: 0,
        suma_delta_usd: 0, muestras: [], skipped: true,
      };
    }

    // Top 10 por delta absoluto — muestras impactantes para el reporte.
    const muestras = [...cambios]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10)
      .map(c => ({
        id: c.id, order_id: c.order_id, fecha: fmtDate(c.fecha),
        cliente: c.cliente_nombre || '(sin cliente)',
        actual: Number(c.valor_actual || 0),
        nuevo:  c.valor_nuevo,
        delta:  c.delta,
      }));

    log('─── Top 10 ventas por delta absoluto ────────────────────────');
    for (const m of muestras) {
      log(`  venta #${m.id}  ${m.order_id}  ${m.fecha}  ${m.cliente}`);
      log(`      ${fmtUsd(m.actual).padStart(14)} → ${fmtUsd(m.nuevo).padStart(14)}  (Δ ${fmtUsd(m.delta)})`);
    }
    log('');

    if (verbose) {
      log('─── TODAS las ventas que cambian ────────────────────────────');
      for (const c of cambios) {
        log(`  venta #${c.id}  ${c.order_id}  ${fmtDate(c.fecha)}  ${fmtUsd(c.valor_actual)} → ${fmtUsd(c.valor_nuevo)}`);
      }
      log('');
    }

    if (!apply) {
      log('Para aplicar:  node scripts/backfill-comision-total-metodos.js --apply');
      log('');
      await client.query('ROLLBACK');
      return {
        apply: false, total_ventas: ventas.length, ventas_cambiadas: cambios.length,
        suma_delta_usd: totalDelta, muestras,
      };
    }

    // ── APPLY ──
    // syncComisionTotalMetodos hace la misma cuenta + UPDATE. Re-corremos sobre
    // las que cambiaban (no las ya correctas) — más rápido y limpia el log.
    for (const c of cambios) {
      await syncComisionTotalMetodos(client, c.id);
    }

    await client.query('COMMIT');
    log(`✓ ${cambios.length} ventas actualizadas`);
    log(`✓ Suma total redirigida de "ganancia" a "costo financiero": ${fmtUsd(totalDelta)}`);
    log('COMMIT.');
    return {
      apply: true, total_ventas: ventas.length, ventas_cambiadas: cambios.length,
      suma_delta_usd: totalDelta, muestras,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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

module.exports = { runBackfill, listarVentasActivas };
