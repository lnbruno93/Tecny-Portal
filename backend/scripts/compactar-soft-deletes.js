#!/usr/bin/env node
/**
 * compactar-soft-deletes.js — hard-delete de soft-deletes antiguos.
 *
 * #B-2 follow-up de la auditoría: las tablas con `deleted_at` nunca se purgan,
 * acumulando rows "fantasma" que pesan en índices y backups. Este script lo
 * resuelve manualmente (NO es un cron automático): hay que correrlo deliberadamente
 * cada N meses para mantener la DB compacta.
 *
 * Política conservadora:
 *   - Solo tablas explícitamente listadas (TABLAS_COMPACTABLES abajo).
 *   - Solo rows con deleted_at < NOW() - INTERVAL '12 months' por default.
 *   - NUNCA toca audit_logs, historial, comprobantes ni productos (decisiones
 *     auditadas; preferimos pagar el storage antes que perder trazabilidad).
 *   - DRY-RUN por default — solo cuenta filas. Para borrar realmente:
 *     `node scripts/compactar-soft-deletes.js --execute`.
 *
 * Cómo correr:
 *   # Reporte (no destructivo):
 *   $ node scripts/compactar-soft-deletes.js
 *
 *   # Borrar (con confirmación interactiva):
 *   $ node scripts/compactar-soft-deletes.js --execute
 *
 *   # Cambiar ventana de retención:
 *   $ node scripts/compactar-soft-deletes.js --months=24
 *
 *   # Solo una tabla específica:
 *   $ node scripts/compactar-soft-deletes.js --table=caja_movimientos
 */

const db = require('../src/config/database');

// Whitelist: solo tablas seguras de compactar. Razón por tabla:
//
//   caja_movimientos        — ledger de cajas. Soft-delete = anulación contable.
//                             Tras 12 meses la trazabilidad está en audit_logs.
//   movimientos_deudas      — pagos/cobros sobre deudas legacy.
//   movimientos_inversiones — ídem inversiones legacy.
//
// Tablas hijo que se borran via CASCADE (no usan deleted_at):
//   items_movimiento_cc, proveedor_movimiento_items, envio_items, canjes
//   — el script las detecta y skipea con un warning. No corren riesgo de
//   acumular fantasmas porque cuando borra el padre, los hijos van con él
//   físicamente (CASCADE).
//
// Tablas NOTABLY excluidas (con deleted_at pero NO compactables):
//   productos        — auditoría regulatoria (IMEI, números de serie).
//   ventas           — auditoría regulatoria + reportes financieros.
//   movimientos_cc   — saldos clientes (los reportes históricos los necesitan).
//   envios           — ídem ventas.
//   proveedor_movimientos — saldos proveedores.
//   tarjeta_movimientos   — saldos tarjetas.
//   cambio_movimientos    — saldos cuevas.
//   clientes_cc, proveedores, contactos, vendedores — entidades, no transacciones.
//   audit_logs, historial — registro auditable.
//   comprobantes, pagos   — bonificación contable.
const TABLAS_COMPACTABLES = [
  'caja_movimientos',
  'movimientos_deudas',
  'movimientos_inversiones',
];

function parseArgs(argv) {
  const args = { execute: false, months: 12, table: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--execute') args.execute = true;
    else if (arg.startsWith('--months=')) args.months = Number(arg.slice(9));
    else if (arg.startsWith('--table=')) args.table = arg.slice(8);
    else if (arg === '--help' || arg === '-h') {
      console.log('Uso: node scripts/compactar-soft-deletes.js [--execute] [--months=N] [--table=X]');
      process.exit(0);
    }
  }
  return args;
}

async function tableExists(table) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

async function hasDeletedAt(table) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'deleted_at'`,
    [table]
  );
  return rows.length > 0;
}

async function countCompactables(table, months) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${table}
       WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - ($1::text || ' months')::interval`,
    [months]
  );
  return rows[0].n;
}

async function deleteCompactables(table, months) {
  const { rowCount } = await db.query(
    `DELETE FROM ${table}
       WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - ($1::text || ' months')::interval`,
    [months]
  );
  return rowCount;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Number.isFinite(args.months) || args.months < 1) {
    console.error('--months debe ser un entero positivo (mínimo 1).');
    process.exit(1);
  }

  const targets = args.table
    ? (TABLAS_COMPACTABLES.includes(args.table) ? [args.table] : [])
    : TABLAS_COMPACTABLES;

  if (targets.length === 0) {
    console.error(`Tabla "${args.table}" no está en la whitelist TABLAS_COMPACTABLES.`);
    console.error(`Whitelist: ${TABLAS_COMPACTABLES.join(', ')}`);
    process.exit(1);
  }

  console.log('━'.repeat(60));
  console.log(`Compactación de soft-deletes — ventana: ${args.months} meses`);
  console.log(`Modo: ${args.execute ? 'EJECUTAR (destructivo)' : 'DRY-RUN (solo conteo)'}`);
  console.log('━'.repeat(60));

  let totalAborrar = 0;
  const counts = {};
  for (const table of targets) {
    if (!(await tableExists(table))) {
      console.log(`  ${table.padEnd(30)} — tabla no existe (skip)`);
      continue;
    }
    if (!(await hasDeletedAt(table))) {
      console.log(`  ${table.padEnd(30)} — sin columna deleted_at (skip; revisar whitelist)`);
      continue;
    }
    const n = await countCompactables(table, args.months);
    counts[table] = n;
    totalAborrar += n;
    console.log(`  ${table.padEnd(30)} ${String(n).padStart(8)} filas`);
  }
  console.log('━'.repeat(60));
  console.log(`Total a compactar: ${totalAborrar} filas`);

  if (totalAborrar === 0) {
    console.log('Nada para hacer. ✓');
    process.exit(0);
  }

  if (!args.execute) {
    console.log('\nDRY-RUN: no se borró nada. Para ejecutar, agregá --execute.');
    process.exit(0);
  }

  // Confirmación interactiva.
  console.log(`\n⚠  Esto borrará PERMANENTEMENTE ${totalAborrar} filas. No se puede deshacer.`);
  console.log('   (Hacé un backup de la DB antes si tenés dudas.)');
  const readline = require('readline').createInterface({
    input: process.stdin, output: process.stdout,
  });
  const answer = await new Promise(r => readline.question('Escribí "BORRAR" para confirmar: ', r));
  readline.close();

  if (answer.trim() !== 'BORRAR') {
    console.log('Cancelado.');
    process.exit(0);
  }

  console.log('\nEjecutando…');
  for (const table of targets) {
    if (!counts[table]) continue;
    const deleted = await deleteCompactables(table, args.months);
    console.log(`  ${table.padEnd(30)} ${String(deleted).padStart(8)} filas borradas`);
  }
  console.log('━'.repeat(60));
  console.log('Listo. Considerá correr VACUUM ANALYZE en cada tabla afectada.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
