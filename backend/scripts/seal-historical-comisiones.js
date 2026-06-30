#!/usr/bin/env node
/**
 * seal-historical-comisiones.js — sellar el % histórico de comisiones.
 *
 * Auditoría 2026-06-30 D-01 — Bug P0 "cambiar pct retroactivo afecta KPIs".
 *
 * La migration `20260701000001_comision_pct_snapshot.js` agregó:
 *   · comprobantes.pct_aplicado        (NUMERIC(6,3), NULL = pre-snapshot)
 *   · venta_pagos.comision_pct_snapshot (NUMERIC(6,3), NULL = pre-snapshot)
 *
 * Los syncs nuevos hacen sealing LAZY (primer touch post-deploy). Pero hasta
 * que ocurra ese primer touch, la fila vieja sigue siendo "vulnerable" si por
 * algún error un sync se invocara con el path de fila nueva. Para cerrar la
 * ventana, este script PRE-SELLA todo el histórico de forma matemática:
 *
 *   1. comprobantes activos con pct_aplicado IS NULL AND monto > 0
 *        pct_aplicado := round(monto_financiera / monto × 100, 3)
 *
 *   2. venta_pagos con comision_pct_snapshot IS NULL, cruzando con el
 *      tarjeta_movimientos del mismo (venta_id, metodo_pago_id) ACTIVO:
 *        comision_pct_snapshot := round(tm.monto_comision / tm.monto_bruto × 100, 3)
 *
 *      (los pagos sin tarjeta_movimiento — efectivo, USD, CC — quedan NULL;
 *       no tienen comisión que sellar, son inmunes al bug por construcción.)
 *
 * Por qué no es destructivo:
 *   · NO modifica monto, monto_financiera, monto_neto ni monto_bruto/monto_comision
 *     (las fuentes de verdad). Solo POPULA columnas nuevas que estaban NULL.
 *   · Idempotente: correrlo dos veces NO sobrescribe filas ya sealadas (WHERE
 *     pct_aplicado IS NULL).
 *
 * Cómo correr:
 *   node scripts/seal-historical-comisiones.js              # dry-run
 *   node scripts/seal-historical-comisiones.js --apply      # ejecutar
 *   node scripts/seal-historical-comisiones.js --verbose    # detalle por fila
 *
 * Validación post-apply:
 *   Cualquier edición posterior de una venta vieja NO debe alterar monto_financiera
 *   ni tarjeta_movimientos.monto_comision (verificable con audit_logs).
 */

const db = require('../src/config/database');
const { parseCommonArgs, err400, fmtDate } = require('./lib/backfillUtils');

// Advisory lock ID único — distinto de financiera (0x6AC8F2A0+), tarjetas y
// comision-total-metodos (0x7C312000). Previene 2 sealings concurrentes.
const ADVISORY_LOCK_ID = 0x7D413000;

function printHelp() {
  console.log(`seal-historical-comisiones.js — sellar % histórico de comisiones (Auditoría 2026-06-30 D-01).

Uso:
  node scripts/seal-historical-comisiones.js [opts]

Opts:
  --apply         Aplica los cambios (default: dry-run, hace ROLLBACK).
  --verbose, -v   Imprime cada fila sellada.
  --help, -h      Muestra esta ayuda.

Qué hace:
  1. comprobantes con pct_aplicado IS NULL AND monto > 0
       → pct_aplicado := round(monto_financiera / monto × 100, 3)
  2. venta_pagos con comision_pct_snapshot IS NULL, cruzados con su
     tarjeta_movimiento activo del mismo (venta_id, metodo_pago_id)
       → comision_pct_snapshot := round(monto_comision / monto_bruto × 100, 3)

Idempotente. No modifica los montos originales.

Ejemplos:
  node scripts/seal-historical-comisiones.js              # reporte dry-run
  node scripts/seal-historical-comisiones.js --apply      # aplicar`);
}

async function runSeal({ apply, verbose, silent } = {}) {
  const log = silent ? () => {} : (...args) => console.log(...args);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS got', [ADVISORY_LOCK_ID]
    );
    if (!lockRows[0]?.got) {
      throw err400('Otro seal-historical-comisiones ya está en curso. Esperá que termine y reintentá.');
    }

    log('═'.repeat(70));
    log(`  Sealing histórico de comisiones (Auditoría 2026-06-30 D-01)  ·  ${apply ? 'APPLY' : 'DRY-RUN'}`);
    log('═'.repeat(70));
    log('');

    // ── 1. comprobantes ────────────────────────────────────────────────────
    // Filas elegibles: pct_aplicado IS NULL, monto > 0, monto_financiera IS NOT NULL.
    // (deleted_at IS NULL — solo activas. Filas soft-deleted quedan tal cual.)
    const { rows: compList } = await client.query(`
      SELECT id, venta_id, monto, monto_financiera,
             ROUND(monto_financiera * 100.0 / monto, 3) AS pct_derivado
        FROM comprobantes
       WHERE pct_aplicado IS NULL
         AND deleted_at IS NULL
         AND monto > 0
         AND monto_financiera IS NOT NULL
       ORDER BY id
    `);
    log(`Comprobantes a sellar:   ${compList.length}`);

    if (verbose && compList.length > 0) {
      log('─── Comprobantes ────────────────────────────────────────────');
      for (const r of compList) {
        log(`  comp #${r.id}  venta=${r.venta_id ?? '-'}  monto=${r.monto}  fin=${r.monto_financiera}  → pct=${r.pct_derivado}`);
      }
    }

    if (apply && compList.length > 0) {
      await client.query(`
        UPDATE comprobantes
           SET pct_aplicado = ROUND(monto_financiera * 100.0 / monto, 3)
         WHERE pct_aplicado IS NULL
           AND deleted_at IS NULL
           AND monto > 0
           AND monto_financiera IS NOT NULL
      `);
    }

    // ── 2. venta_pagos ─────────────────────────────────────────────────────
    // Filas elegibles: comision_pct_snapshot IS NULL, con un tarjeta_movimiento
    // activo asociado (mismo venta_id + metodo_pago_id). Si no hay tm asociado
    // (efectivo / USD / CC), no hay comisión que sellar → queda NULL.
    const { rows: vpList } = await client.query(`
      SELECT vp.id AS vp_id, vp.venta_id, vp.metodo_pago_id,
             tm.id AS tm_id, tm.monto_bruto, tm.monto_comision,
             ROUND(tm.monto_comision * 100.0 / tm.monto_bruto, 3) AS pct_derivado
        FROM venta_pagos vp
        JOIN tarjeta_movimientos tm
          ON tm.venta_id = vp.venta_id
         AND tm.metodo_pago_id = vp.metodo_pago_id
         AND tm.tipo = 'cobro'
         AND tm.deleted_at IS NULL
         AND tm.monto_bruto > 0
       WHERE vp.comision_pct_snapshot IS NULL
       ORDER BY vp.id
    `);
    log(`Venta_pagos a sellar:    ${vpList.length}`);

    if (verbose && vpList.length > 0) {
      log('─── Venta_pagos ─────────────────────────────────────────────');
      for (const r of vpList) {
        log(`  vp #${r.vp_id}  venta=${r.venta_id}  mp=${r.metodo_pago_id}  bruto=${r.monto_bruto}  com=${r.monto_comision}  → pct=${r.pct_derivado}`);
      }
    }

    if (apply && vpList.length > 0) {
      // UPDATE en bloque con derivación matemática. Usamos un subquery con
      // DISTINCT ON por (venta_id, metodo_pago_id) por si hay >1 mov (poco
      // probable: el sync borra y recrea uno por pago) — tomamos el más
      // reciente.
      await client.query(`
        UPDATE venta_pagos vp
           SET comision_pct_snapshot = sub.pct_derivado
          FROM (
            SELECT DISTINCT ON (tm.venta_id, tm.metodo_pago_id)
                   tm.venta_id, tm.metodo_pago_id,
                   ROUND(tm.monto_comision * 100.0 / tm.monto_bruto, 3) AS pct_derivado
              FROM tarjeta_movimientos tm
             WHERE tm.tipo = 'cobro'
               AND tm.deleted_at IS NULL
               AND tm.monto_bruto > 0
             ORDER BY tm.venta_id, tm.metodo_pago_id, tm.id DESC
          ) sub
         WHERE vp.comision_pct_snapshot IS NULL
           AND vp.venta_id = sub.venta_id
           AND vp.metodo_pago_id = sub.metodo_pago_id
      `);
    }

    log('');
    if (!apply) {
      log('Para aplicar:  node scripts/seal-historical-comisiones.js --apply');
      log('');
      await client.query('ROLLBACK');
      return {
        apply: false,
        comprobantes_sellados: compList.length,
        venta_pagos_sellados: vpList.length,
      };
    }

    await client.query('COMMIT');
    log(`✓ ${compList.length} comprobantes sellados`);
    log(`✓ ${vpList.length} venta_pagos sellados`);
    log('COMMIT.');
    return {
      apply: true,
      comprobantes_sellados: compList.length,
      venta_pagos_sellados: vpList.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const { args } = parseCommonArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }
  try {
    await runSeal(args);
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

module.exports = { runSeal };
