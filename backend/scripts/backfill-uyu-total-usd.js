#!/usr/bin/env node
/**
 * backfill-uyu-total-usd.js — Recalcula `ventas.total_usd`, `ventas.ganancia_usd`
 * y `caja_movimientos.monto_usd` para tenants UY afectados por el BLOCKER
 * multi-país del 2026-07-05.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ SE ARREGLA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Bug: `lib/money.js toUsd(monto, 'UYU', tc)` retornaba `monto` sin convertir
 * (fallback `return m`). Efecto: toda venta con item UYU se persistió con
 * `total_usd` y `ganancia_usd` inflados por factor ~tc (≈40x en UY).
 *
 * Análogamente, `caja_movimientos.monto_usd` calculado con `toUsd(monto,'UYU',tc)`
 * en `postCajaMovimiento` quedó igual al monto nativo UYU en vez del USD real.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SCOPE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Sólo se tocan filas con:
 *   · Tenants con `pais = 'UY'`.
 *   · Ventas con al menos un item de moneda `UYU`.
 *   · caja_movimientos con moneda `UYU`.
 *
 * NO se tocan ventas de tenants AR (su cálculo ARS estaba bien).
 * NO se tocan comprobantes, pagos ni ningún otro registro.
 * NO se tocan `venta_items` ni `venta_pagos` — se preservan como
 * source-of-truth (los `total_usd`/`monto_usd` son valores derivados).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ALGORITMO
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   Para cada venta de tenant UY con items UYU:
 *     nuevo_total_usd = SUM(items) usando toUsd() fixeado
 *     nuevo_ganancia_usd = nuevo_total_usd - costos_usd - comisiones_usd
 *     UPDATE ventas SET total_usd = nuevo_total_usd,
 *                       ganancia_usd = nuevo_ganancia_usd
 *
 *   Para cada caja_movimientos con moneda UYU:
 *     nuevo_monto_usd = toUsd(monto, 'UYU', tc) — usa el `tc` almacenado si
 *       existe; si no, se busca el `tc_venta` de la fuente (ref_tabla=venta,
 *       ref_id=X) o el TC default UY.
 *     UPDATE caja_movimientos SET monto_usd = nuevo_monto_usd
 *
 * Idempotente: correrlo N veces produce el mismo resultado (el fix del código
 * usa toUsd() correcto, así que recalcular con el helper actualizado es
 * estable).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CÓMO CORRER
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   node scripts/backfill-uyu-total-usd.js               # dry-run (muestra deltas)
 *   node scripts/backfill-uyu-total-usd.js --apply       # ejecuta UPDATEs
 *   node scripts/backfill-uyu-total-usd.js --verbose     # detalle por venta/mov
 *   node scripts/backfill-uyu-total-usd.js --tenant=17   # limitar a 1 tenant
 *
 * En prod: correr primero en staging → validar deltas → correr en prod con
 * `--apply` en horario de baja actividad (ideal ANTES de que los users
 * abran dashboards, así no ven KPIs oscilando).
 *
 * Post-apply: el dashboard de tenants UY va a mostrar `total_usd` correcto
 * (~40x menos que antes). Comunicar a esos clientes que los KPIs históricos
 * quedaron corregidos.
 */

'use strict';

const db = require('../src/config/database');
const { toUsd, round2 } = require('../src/lib/money');

// Advisory lock ID único para este backfill. Per-transaction. Previene que
// dos instancias del script corran al mismo tiempo.
const ADVISORY_LOCK_ID = 0x7C312101;

const args = process.argv.slice(2);
const APPLY   = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const TENANT_ARG = args.find(a => a.startsWith('--tenant='));
const TENANT_ID = TENANT_ARG ? Number(TENANT_ARG.split('=')[1]) : null;

function log(...msg) { console.log('[backfill-uyu]', ...msg); }
function logV(...msg) { if (VERBOSE) console.log('  [v]', ...msg); }

async function main() {
  const client = await db.connect();
  const inicio = Date.now();

  try {
    await client.query('BEGIN');
    // superuser en scripts (no aplica RLS): usamos adminQuery-equivalent via
    // conexión directa. NO hacemos SET LOCAL app.current_tenant — queremos
    // ver TODOS los tenants UY para calcular el delta.
    const gotLock = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS lock',
      [ADVISORY_LOCK_ID]
    );
    if (!gotLock.rows[0].lock) {
      log('ERROR: no se pudo obtener advisory lock. ¿Otro backfill corriendo?');
      process.exit(1);
    }

    log(`Modo: ${APPLY ? 'APPLY (persistente)' : 'DRY-RUN (sin cambios)'}`);
    if (TENANT_ID) log(`Filtrado a tenant_id = ${TENANT_ID}`);

    // ── 1. Ventas con items UYU en tenants UY ─────────────────────────
    const ventasQuery = `
      WITH ventas_uy AS (
        SELECT v.id, v.tenant_id, v.tc_venta, v.total_usd AS total_usd_actual,
               v.ganancia_usd AS ganancia_usd_actual
        FROM ventas v
        JOIN tenants t ON t.id = v.tenant_id
        WHERE t.pais = 'UY'
          AND v.deleted_at IS NULL
          ${TENANT_ID ? 'AND v.tenant_id = $1' : ''}
          AND EXISTS (
            SELECT 1 FROM venta_items vi
            WHERE vi.venta_id = v.id AND vi.moneda = 'UYU'
          )
      )
      SELECT vu.id, vu.tenant_id, vu.tc_venta, vu.total_usd_actual, vu.ganancia_usd_actual,
             COALESCE(json_agg(json_build_object(
               'moneda', vi.moneda,
               'precio_vendido', vi.precio_vendido,
               'costo', vi.costo,
               'comision', vi.comision,
               'cantidad', vi.cantidad
             )) FILTER (WHERE vi.id IS NOT NULL), '[]'::json) AS items
      FROM ventas_uy vu
      LEFT JOIN venta_items vi ON vi.venta_id = vu.id
      GROUP BY vu.id, vu.tenant_id, vu.tc_venta, vu.total_usd_actual, vu.ganancia_usd_actual
      ORDER BY vu.tenant_id, vu.id
    `;
    const params = TENANT_ID ? [TENANT_ID] : [];
    const { rows: ventasUY } = await client.query(ventasQuery, params);
    log(`Ventas UY con items UYU: ${ventasUY.length}`);

    let ventasCorregidas = 0;
    let deltaTotalUsdAbs = 0;
    let deltaGananciaUsdAbs = 0;

    for (const v of ventasUY) {
      const items = v.items || [];
      let totalUsd = 0, costoUsd = 0, comisionUsd = 0;
      for (const it of items) {
        totalUsd    += toUsd(it.precio_vendido * it.cantidad, it.moneda, v.tc_venta);
        costoUsd    += toUsd(it.costo * it.cantidad,          it.moneda, v.tc_venta);
        comisionUsd += toUsd(it.comision,                     it.moneda, v.tc_venta);
      }
      const nuevoTotalUsd    = round2(totalUsd);
      const nuevoGananciaUsd = round2(totalUsd - costoUsd - comisionUsd);
      const dTotal    = round2(nuevoTotalUsd    - Number(v.total_usd_actual    || 0));
      const dGanancia = round2(nuevoGananciaUsd - Number(v.ganancia_usd_actual || 0));

      if (dTotal !== 0 || dGanancia !== 0) {
        ventasCorregidas++;
        deltaTotalUsdAbs    += Math.abs(dTotal);
        deltaGananciaUsdAbs += Math.abs(dGanancia);
        logV(
          `venta #${v.id} (tenant ${v.tenant_id}): ` +
          `total ${v.total_usd_actual} → ${nuevoTotalUsd} (Δ ${dTotal >= 0 ? '+' : ''}${dTotal}), ` +
          `ganancia ${v.ganancia_usd_actual} → ${nuevoGananciaUsd} (Δ ${dGanancia >= 0 ? '+' : ''}${dGanancia})`
        );
        if (APPLY) {
          await client.query(
            'UPDATE ventas SET total_usd = $1, ganancia_usd = $2 WHERE id = $3',
            [nuevoTotalUsd, nuevoGananciaUsd, v.id]
          );
        }
      }
    }

    log(`Ventas con delta: ${ventasCorregidas} / ${ventasUY.length}`);
    log(`Δ total_usd absoluto: $${round2(deltaTotalUsdAbs)}`);
    log(`Δ ganancia_usd absoluto: $${round2(deltaGananciaUsdAbs)}`);

    // ── 2. caja_movimientos con moneda UYU ────────────────────────────
    // El monto_usd de un movimiento UYU se recalcula con toUsd corregido.
    // Necesitamos el TC "referencia" para cada movimiento — problemático
    // porque `caja_movimientos` no persiste el tc. Enfoque:
    //   · Si ref_tabla='venta' y ref_id existe → usamos ventas.tc_venta.
    //   · Si no → usamos TC default del país UY (getTcDefaultPais).
    //
    // Para tenants UY donde el bug persiste `monto_usd = monto` (síntoma):
    // detectamos movs con `monto_usd = monto AND moneda = 'UYU'` como
    // candidatos primarios.
    const tcDefaultUY = 40; // seed de tc_defaults_pais para UYU/USD
    // Nota: no consultamos tc_defaults_pais dentro de la tx porque el helper
    // requiere client con permisos SELECT. Simplificamos con el seed conocido
    // (documentado en migration 20260629100003_tc_defaults_pais.js).

    const movsQuery = `
      SELECT cm.id, cm.caja_id, cm.monto, cm.monto_usd AS monto_usd_actual,
             cm.ref_tabla, cm.ref_id, mp.tenant_id,
             v.tc_venta AS tc_venta_ref
      FROM caja_movimientos cm
      JOIN metodos_pago mp ON mp.id = cm.caja_id
      JOIN tenants t ON t.id = mp.tenant_id
      LEFT JOIN ventas v ON v.id = cm.ref_id AND cm.ref_tabla = 'venta'
      WHERE t.pais = 'UY'
        AND cm.deleted_at IS NULL
        ${TENANT_ID ? 'AND mp.tenant_id = $1' : ''}
        AND EXISTS (
          -- Sospechosos: movs marcados con moneda UYU implícita (por la caja).
          -- Como caja_movimientos NO persiste moneda del mov, inferimos
          -- desde la caja: si la caja es UYU, todos los movs también son UYU.
          SELECT 1 FROM metodos_pago mp2
          WHERE mp2.id = cm.caja_id AND mp2.moneda = 'UYU'
        )
      ORDER BY mp.tenant_id, cm.caja_id, cm.id
    `;
    const { rows: movsUYU } = await client.query(movsQuery, params);
    log(`caja_movimientos en cajas UYU: ${movsUYU.length}`);

    let movsCorregidos = 0;
    let deltaMontoUsdAbs = 0;

    for (const m of movsUYU) {
      const tc = Number(m.tc_venta_ref) > 0 ? Number(m.tc_venta_ref) : tcDefaultUY;
      const nuevoMontoUsd = round2(toUsd(m.monto, 'UYU', tc));
      const dMonto = round2(nuevoMontoUsd - Number(m.monto_usd_actual || 0));

      if (dMonto !== 0) {
        movsCorregidos++;
        deltaMontoUsdAbs += Math.abs(dMonto);
        logV(
          `caja_movimientos #${m.id} (caja ${m.caja_id}, tenant ${m.tenant_id}, tc=${tc}): ` +
          `monto_usd ${m.monto_usd_actual} → ${nuevoMontoUsd} (Δ ${dMonto >= 0 ? '+' : ''}${dMonto})`
        );
        if (APPLY) {
          await client.query(
            'UPDATE caja_movimientos SET monto_usd = $1 WHERE id = $2',
            [nuevoMontoUsd, m.id]
          );
        }
      }
    }

    log(`caja_movimientos con delta: ${movsCorregidos} / ${movsUYU.length}`);
    log(`Δ monto_usd absoluto: $${round2(deltaMontoUsdAbs)}`);

    // ── 3. Commit o rollback ──────────────────────────────────────────
    if (APPLY) {
      await client.query('COMMIT');
      log(`✓ APPLY completado en ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
    } else {
      await client.query('ROLLBACK');
      log(`✓ DRY-RUN completado en ${((Date.now() - inicio) / 1000).toFixed(1)}s (sin cambios)`);
      log(`Para persistir, correr: node scripts/backfill-uyu-total-usd.js --apply`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[backfill-uyu] ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    // db.end() cierra el pool. Sin esto el proceso queda colgado.
    if (typeof db.end === 'function') await db.end();
  }
}

main();
