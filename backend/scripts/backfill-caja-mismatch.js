#!/usr/bin/env node
/**
 * backfill-caja-mismatch.js — Fase B fix #4 audit 2026-07-07.
 *
 * Corrige data histórica de `caja_movimientos` donde el `monto` quedó en
 * la moneda del pago en lugar de la moneda de la caja. Contexto completo
 * en `backend/src/lib/backfillCajaMismatch.js` y en el design doc del PR
 * Fase A. TL;DR: pre-fix, `syncVentaCaja` copiaba `venta_pagos.monto`
 * crudo → el saldo de la caja se calculaba mezclando monedas → tenants
 * con pagos cross-moneda tenían saldos incoherentes en el dashboard.
 *
 * Este script:
 *   1. DRY-RUN por default: hace UN SOLO SELECT cross-tenant (via
 *      db.adminQuery + BYPASSRLS), aplica el helper puro `analizarCandidato`
 *      a cada row, y emite el reporte por tenant al stdout. Read-only —
 *      cero riesgo, cero locks, se puede correr en prod mientras
 *      operadores usan el sistema.
 *
 *   2. APPLY (--apply --tenant-slug X): abre tx, advisory lock específico
 *      del tenant, UPDATE los reparables, valida saldos de las cajas
 *      afectadas post-UPDATE, audit_log de cada cambio, COMMIT.
 *
 * Guardrails (SIEMPRE solidez):
 *   · Sólo 1 tenant por vez en apply (--tenant-slug obligatorio).
 *   · Advisory lock per-tx: 2 corridas del mismo tenant en paralelo aborta.
 *   · Cada UPDATE queda en audit_logs con `origen='backfill-caja-mismatch-fase-b'`
 *     + diff antes/después (para poder revertir puntualmente si hace falta).
 *   · Nunca toca movs "revisar_manual" — los listamos y decidís vos.
 *   · Nunca toca movs "skip" (misma moneda / USD↔USDT paridad / ya
 *     convertido POST-fix).
 *
 * Uso:
 *   # Dry-run cross-tenant (default):
 *   $ node scripts/backfill-caja-mismatch.js
 *
 *   # Dry-run verbose (lista cada row):
 *   $ node scripts/backfill-caja-mismatch.js --verbose
 *
 *   # Dry-run filtrado a un tenant:
 *   $ node scripts/backfill-caja-mismatch.js --tenant-slug tekhaus
 *
 *   # APPLY (persistente) — sólo 1 tenant:
 *   $ node scripts/backfill-caja-mismatch.js --apply --tenant-slug tekhaus
 */

const db = require('../src/config/database');
const { armarReporte } = require('../src/lib/backfillCajaMismatch');

// Advisory lock ID arbitrario estable (int32). Diferente de los otros
// backfills (financiera: 0x6AC8F1FC, tarjetas: distinto) para permitir que
// corran en paralelo si algún día el operador arranca dos scripts distintos.
// XOR con hash del tenant_id se hace en runtime — 2 tenants pueden backfillear
// concurrentemente sin colisionar.
const ADVISORY_LOCK_BASE = 0x7A4F16D2;

function parseArgs(argv) {
  const args = { apply: false, verbose: false, tenantSlug: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--tenant-slug') { args.tenantSlug = rest[++i]; }
    else if (a.startsWith('--tenant-slug=')) { args.tenantSlug = a.slice('--tenant-slug='.length); }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else {
      console.error(`Flag desconocido: ${a}. Usá --help.`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`backfill-caja-mismatch.js — Fase B fix #4 audit 2026-07-07.

Corrige históricos donde caja_movimientos.monto quedó crudo en moneda del
pago en lugar de convertido a moneda de la caja.

Uso:
  node scripts/backfill-caja-mismatch.js [opts]

Opts:
  --apply                Aplica los cambios (default: dry-run puro).
  --tenant-slug <slug>   Filtra a 1 tenant. OBLIGATORIO con --apply.
  --verbose, -v          Imprime cada row analizada.
  --help, -h             Muestra esta ayuda.

Ejemplos:
  node scripts/backfill-caja-mismatch.js                          # reporte cross-tenant
  node scripts/backfill-caja-mismatch.js --tenant-slug tekhaus    # dry-run 1 tenant
  node scripts/backfill-caja-mismatch.js --apply --tenant-slug tekhaus  # aplicar
`);
}

// ─── SQL del cross-tenant SELECT ─────────────────────────────────────────────
//
// Junta caja_movimientos + venta_pagos + metodos_pago + tenants. Filtra sólo
// donde:
//   - ref_tabla='ventas' (el bug es en el path syncVentaCaja).
//   - deleted_at IS NULL en las 3 tablas (no queremos revivir data ya
//     soft-deleteada por el operador).
//   - hay mismatch de moneda (vp.moneda != mp.moneda).
//
// El resto del filtrado (skip ya-convertidos, skip USD/USDT paridad,
// clasificar entre reparar/revisar_manual) lo hace `analizarCandidato` en
// memoria — es lógica pura, más fácil de testear que embeberla en SQL.
const SELECT_CANDIDATOS = `
  SELECT
    cm.id                       AS caja_movimiento_id,
    cm.caja_id                  AS caja_id,
    cm.monto                    AS mov_monto,
    cm.monto_usd                AS mov_monto_usd,
    cm.ref_id                   AS venta_id,
    v.order_id                  AS order_id,
    vp.monto                    AS pago_monto,
    vp.moneda                   AS pago_moneda,
    vp.tc                       AS pago_tc,
    mp.moneda                   AS caja_moneda,
    mp.nombre                   AS caja_nombre,
    t.id                        AS tenant_id,
    t.slug                      AS tenant_slug
  FROM caja_movimientos cm
  JOIN metodos_pago mp   ON mp.id = cm.caja_id                    AND mp.deleted_at IS NULL
  JOIN ventas v          ON v.id  = cm.ref_id                     AND v.deleted_at  IS NULL
  JOIN venta_pagos vp    ON vp.venta_id = cm.ref_id
                        AND vp.metodo_pago_id = cm.caja_id
                        AND vp.es_cuenta_corriente = false
  JOIN tenants t         ON t.id = cm.tenant_id
  WHERE cm.ref_tabla = 'ventas'
    AND cm.deleted_at IS NULL
    AND vp.moneda != mp.moneda
    /* Filtro tenant opcional (usa NULL-safe compare) */
    AND ($1::text IS NULL OR t.slug = $1)
  ORDER BY t.slug, cm.caja_id, cm.id
`;

// ─── DRY-RUN ─────────────────────────────────────────────────────────────────

async function runDryRun(args) {
  const rows = await db.adminQuery(async (client) => {
    const { rows } = await client.query(SELECT_CANDIDATOS, [args.tenantSlug]);
    return rows;
  });

  const reporte = armarReporte(rows);

  // Imprimir resumen legible + JSON completo al final (para pipe a jq).
  const tenants = Object.entries(reporte.tenants);
  const totalReparables    = tenants.reduce((s, [, t]) => s + t.reparables.length, 0);
  const totalManual        = tenants.reduce((s, [, t]) => s + t.revisar_manual.length, 0);
  const totalSkip          = tenants.reduce((s, [, t]) => s + t.skip.count, 0);

  console.error('── Reporte dry-run backfill caja mismatch ──');
  console.error(`Total rows candidatas escaneadas: ${reporte.total_rows}`);
  console.error(`  · Auto-reparables:   ${totalReparables}`);
  console.error(`  · Revisar manual:    ${totalManual}`);
  console.error(`  · Skip (correcto):   ${totalSkip}`);
  console.error(`Tenants afectados: ${tenants.length}`);
  console.error('');

  for (const [slug, t] of tenants) {
    console.error(`[${slug}] cajas_afectadas=${t.cajas_afectadas} reparables=${t.reparables.length} revisar_manual=${t.revisar_manual.length} skip=${t.skip.count}`);
    if (args.verbose && t.reparables.length > 0) {
      console.error(`  Reparables (primeros 5):`);
      for (const r of t.reparables.slice(0, 5)) {
        console.error(`    · mov#${r.caja_movimiento_id} caja "${r.caja_nombre}" (${r.caja_moneda})`
          + ` orden ${r.order_id}: ${r.pago_monto} ${r.pago_moneda} → ${r.mov_monto_nuevo} ${r.caja_moneda}`
          + ` (delta ${r.delta >= 0 ? '+' : ''}${r.delta})`);
      }
    }
    if (args.verbose && t.revisar_manual.length > 0) {
      console.error(`  Revisar manual (primeros 5):`);
      for (const r of t.revisar_manual.slice(0, 5)) {
        console.error(`    · mov#${r.caja_movimiento_id} caja "${r.caja_nombre}" (${r.caja_moneda})`
          + ` orden ${r.order_id}: ${r.pago_monto} ${r.pago_moneda} — razón: ${r.razon}`);
      }
    }
  }

  console.error('');
  console.error('── JSON completo (stdout) ──');
  // JSON al stdout para pipe a jq/archivo. Todo lo humano fue a stderr.
  console.log(JSON.stringify(reporte, null, 2));
}

// ─── APPLY ──────────────────────────────────────────────────────────────────

// Hash bajo de un string a int31, para XORear con el ADVISORY_LOCK_BASE y
// permitir que 2 tenants distintos backfilleen concurrentemente sin
// colisionar en el mismo lock ID.
function tenantLockOffset(tenantSlug) {
  let h = 0;
  for (let i = 0; i < tenantSlug.length; i++) {
    h = ((h << 5) - h + tenantSlug.charCodeAt(i)) | 0;
  }
  return Math.abs(h) & 0x7FFFFFFF;
}

async function runApply(args) {
  if (!args.tenantSlug) {
    console.error('✗ --apply requiere --tenant-slug <slug>. Sólo aplicamos 1 tenant por vez.');
    process.exit(2);
  }

  await db.adminQuery(async (client) => {
    await client.query('BEGIN');
    try {
      const lockId = ADVISORY_LOCK_BASE ^ tenantLockOffset(args.tenantSlug);
      const { rows: lockRows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS got', [lockId]);
      if (!lockRows[0]?.got) {
        throw new Error(`Otro backfill del tenant "${args.tenantSlug}" está en curso. Esperá.`);
      }

      // Resolver tenant_id — validamos que existe antes de tocar nada.
      const { rows: trows } = await client.query(
        `SELECT id, slug, nombre, pais FROM tenants WHERE slug = $1 AND deleted_at IS NULL`,
        [args.tenantSlug]
      );
      if (trows.length === 0) throw new Error(`Tenant "${args.tenantSlug}" no existe o está soft-deleted.`);
      const tenant = trows[0];
      console.error(`Tenant: ${tenant.slug} (id=${tenant.id}, país=${tenant.pais})`);

      // Volver a correr el análisis pero scoped al tenant, así vemos exactamente
      // lo que vamos a tocar HOY (data pudo haber cambiado desde el dry-run).
      const { rows } = await client.query(SELECT_CANDIDATOS, [args.tenantSlug]);
      const reporte = armarReporte(rows);
      const bucket = reporte.tenants[args.tenantSlug];
      if (!bucket || bucket.reparables.length === 0) {
        console.error('No hay movs auto-reparables para este tenant. Nada que hacer.');
        await client.query('ROLLBACK');
        return;
      }

      console.error(`Aplicando ${bucket.reparables.length} UPDATEs...`);

      // Snapshot de saldos ANTES de tocar (por caja afectada) para reporte final.
      const cajaIds = [...new Set(bucket.reparables.map(r => r.caja_id))];
      const saldosAntes = await getSaldosDeCajas(client, cajaIds);

      // UPDATEs uno por uno + audit_log por cambio. Se puede bulkificar
      // con UNNEST si escala mal, pero para volúmenes esperados (decenas a
      // pocos cientos por tenant) preferimos claridad + audit granular.
      for (const r of bucket.reparables) {
        // Diff antes/después para auditoría — permite revertir mov por mov si
        // en el futuro descubrimos un caso mal manejado.
        const antes = {
          monto:     Number(r.mov_monto_actual),
          monto_usd: null, // lo leemos abajo para evitar carrera
        };

        // Leemos monto_usd actual atómico con el UPDATE (SELECT ... FOR UPDATE
        // no hace falta acá porque estamos en tx serializable-safe con
        // advisory lock — nadie más está tocando estos movs).
        const { rows: prevRows } = await client.query(
          `SELECT monto_usd FROM caja_movimientos WHERE id = $1`, [r.caja_movimiento_id]
        );
        antes.monto_usd = Number(prevRows[0]?.monto_usd || 0);

        await client.query(
          `UPDATE caja_movimientos
              SET monto = $1, monto_usd = $2
            WHERE id = $3 AND deleted_at IS NULL`,
          [r.mov_monto_nuevo, r.mov_monto_usd_nuevo, r.caja_movimiento_id]
        );

        // Nota: `accion` tiene CHECK (INSERT/UPDATE/DELETE) — usamos 'UPDATE'
        // (es lo que semánticamente es) y taggeamos el origen dentro del JSONB
        // para poder filtrar `datos_antes @> '{"origen_backfill":"fase-b-mismatch"}'`
        // cuando querés auditar los cambios del backfill.
        await client.query(
          `INSERT INTO audit_logs
             (tabla, accion, registro_id, datos_antes, datos_despues, user_id, tenant_id, created_at)
           VALUES ('caja_movimientos', 'UPDATE', $1, $2::jsonb, $3::jsonb, NULL, $4, NOW())`,
          [
            r.caja_movimiento_id,
            JSON.stringify({
              monto: antes.monto,
              monto_usd: antes.monto_usd,
              moneda_original_pago: r.pago_moneda,
              tc: r.pago_tc,
              origen_backfill: 'fase-b-mismatch',
            }),
            JSON.stringify({
              monto: r.mov_monto_nuevo,
              monto_usd: r.mov_monto_usd_nuevo,
              moneda_caja: r.caja_moneda,
              origen_backfill: 'fase-b-mismatch',
            }),
            tenant.id,
          ]
        );
      }

      // Snapshot de saldos DESPUÉS para reporte + validación no-negatividad.
      const saldosDespues = await getSaldosDeCajas(client, cajaIds);
      for (const s of saldosDespues) {
        if (Number(s.saldo) < 0) {
          throw new Error(`Caja "${s.nombre}" (id=${s.caja_id}) quedaría negativa (${s.saldo} ${s.moneda}) — ROLLBACK.`);
        }
      }

      // Reporte de cambios de saldo por caja.
      console.error('');
      console.error('Deltas de saldo por caja:');
      const antesMap = new Map(saldosAntes.map(s => [s.caja_id, s]));
      for (const d of saldosDespues) {
        const a = antesMap.get(d.caja_id);
        console.error(`  · "${d.nombre}" (${d.moneda}): ${a?.saldo || 0} → ${d.saldo}`
          + ` (delta ${Number(d.saldo) - Number(a?.saldo || 0)})`);
      }

      await client.query('COMMIT');
      console.error('');
      console.error(`✓ COMMIT — ${bucket.reparables.length} movs corregidos en tenant "${args.tenantSlug}".`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

// Devuelve saldo actual de las cajas dadas (leyendo mp.saldo_inicial + suma
// de ingresos/egresos). Usado para el reporte antes/después del apply.
async function getSaldosDeCajas(client, cajaIds) {
  if (cajaIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT mp.id AS caja_id, mp.nombre, mp.moneda,
            mp.saldo_inicial + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) AS saldo
       FROM metodos_pago mp
       LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
      WHERE mp.id = ANY($1::int[])
      GROUP BY mp.id, mp.nombre, mp.moneda, mp.saldo_inicial
      ORDER BY mp.id`,
    [cajaIds]
  );
  return rows;
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.apply) await runApply(args);
    else            await runDryRun(args);
  } catch (err) {
    console.error('');
    console.error(`✗ ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    await db.end().catch(() => {});
    await db.endAdmin().catch(() => {});
  }
}

if (require.main === module) main();

// Export para tests unitarios (no cubrimos apply desde tests por ser mutación
// contra DB real — el helper puro `analizarCandidato`/`armarReporte` tiene
// coverage completa en tests/backfillCajaMismatch.test.js).
module.exports = { parseArgs, tenantLockOffset, SELECT_CANDIDATOS };
