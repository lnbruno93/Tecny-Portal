/**
 * Migration: extender canjes.moneda CHECK constraint para aceptar UYU (+ USDT).
 *
 * 2026-07-12 (auditoría TOTAL Stock P1-6, Pattern B multi-país UYU):
 *
 * Contexto: la migration original de ventas.js (20260524000002_ventas.js:151)
 * definió `canjes.moneda TEXT NOT NULL DEFAULT 'USD' CHECK (moneda IN
 * ('USD','ARS'))`. Post-multi-país (F1-F5), el schema Zod de canjes usa
 * `MonedaEnum.default('USD')` (schemas/_common.js:23) que acepta
 * `['USD','ARS','UYU','USDT']`.
 *
 * Efecto (bug P1 escenario):
 *  1. Tenant UY carga venta con canje: `canje.moneda='UYU'`, `valor_toma=15000`.
 *  2. POST /ventas → Zod pasa (schema acepta UYU).
 *  3. INSERT INTO canjes rompe con `23514: check constraint canjes_moneda_check`.
 *  4. Rollback total de la venta. El operador ve 500 con mensaje SQL opaco.
 *
 * También: el dashboard convierte UYU en el CASE (ventas.js:621, 637)
 * asumiendo que llegan filas con `moneda='UYU'`. Contradicción con el
 * CHECK actual → dead code para el path UYU.
 *
 * Fix: DROP + ADD del constraint para incluir 'UYU' y 'USDT'. Backfill no
 * requerido — no hay data corrupta pre-existente (el CHECK rechazaba UYU
 * en el INSERT, así que nada llegó a la tabla con moneda='UYU').
 *
 * Down: revierte al CHECK original `('USD','ARS')`. Solo funciona si no
 * hay filas con moneda='UYU' o 'USDT' — si las hay (post-fix, algún tenant
 * UY las creó), la down rebota con 23514 y hay que borrar/migrar esas
 * filas antes de rollbackear. Comportamiento esperado.
 *
 * Multi-tenant: canjes NO tiene tenant_id (es hijo de ventas via venta_id).
 * El CHECK es global, sin impacto multi-tenant.
 */

exports.up = (pgm) => {
  // DROP + ADD atómico dentro de una transacción implícita del migrator.
  // node-pg-migrate wrappea cada `up` en BEGIN/COMMIT — si el ADD falla
  // por alguna fila corrupta, el DROP también se revierte.
  pgm.sql(`
    ALTER TABLE canjes
      DROP CONSTRAINT IF EXISTS canjes_moneda_check;

    ALTER TABLE canjes
      ADD CONSTRAINT canjes_moneda_check
      CHECK (moneda IN ('USD','ARS','UYU','USDT'));
  `);
};

exports.down = (pgm) => {
  // Revertir al CHECK original. Si hay filas UYU/USDT vivas al momento del
  // rollback, este ALTER rebotará con 23514 — el operador debe limpiar
  // primero. Preferimos ese rebote a un silent data loss.
  pgm.sql(`
    ALTER TABLE canjes
      DROP CONSTRAINT IF EXISTS canjes_moneda_check;

    ALTER TABLE canjes
      ADD CONSTRAINT canjes_moneda_check
      CHECK (moneda IN ('USD','ARS'));
  `);
};
