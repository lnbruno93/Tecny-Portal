/* eslint-disable camelcase */
/**
 * Feature: trazabilidad Deudas ↔ Cajas + Inversiones ↔ Cajas (task Lucas 2026-08-03).
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * Bug reportado por Lucas 2026-08-03: en Cajas > Deudas a cobrar,
 * cerrar una deuda con `tipo=pago` solo insertaba en `movimientos_deudas`
 * — no reflejaba el ingreso de cash en ninguna caja. Consecuencia:
 * la deuda desaparecía en la vista Deudas pero el saldo de Cajas no
 * crecía. Falla de trazabilidad + double-entry bookkeeping.
 *
 * Mismo gap en:
 *   - Deudas cobrar (debe): cuando registro "le presté 500 USD",
 *     la caja de efectivo USD no baja
 *   - Inversiones: cuando un inversor me trae 5000 USD, ninguna caja
 *     lo refleja
 *
 * ── Cambios ──────────────────────────────────────────────────────────
 *
 * 1. **`movimientos_deudas.caja_id`** (INT nullable, FK a metodos_pago):
 *    - NULL en rows históricos (backward compat)
 *    - Los nuevos movimientos: REQUERIDO cuando tipo=pago (enforced en Zod)
 *      + OPCIONAL cuando tipo=debe (usuario puede omitir si el préstamo
 *      no salió de una caja específica, ej. dinero prometido futuro)
 *
 * 2. **`movimientos_deudas.tc`** (NUMERIC 14,4 nullable):
 *    - Para convertir monto_ars → USD_display si la caja destino es USD.
 *    - Necesario porque `postCajaMovimiento` calcula `monto_usd` con TC
 *      contextual (mismo pattern que Ventas/Envíos ya usan).
 *
 * 3. **`movimientos_inversiones.caja_id`** (INT nullable, FK):
 *    - NULL en rows históricos.
 *    - Los nuevos: REQUERIDO siempre (una inversión SIEMPRE alimenta una caja).
 *
 * 4. **`movimientos_inversiones.tc`** (NUMERIC 14,4 nullable):
 *    - Simétrico al de deudas. Las inversiones son USD-only por diseño
 *      del modal, pero si un tenant registra USDT en una caja USDT (grupo
 *      USD), no hace falta TC. Se pide solo si aparece necesidad.
 *
 * 5. **`caja_movimientos.origen`** extendido con `'deuda'` e `'inversion'`:
 *    - DROP + ADD del CHECK constraint (mismo pattern del PR relevo
 *      2026-07-29). Backward compat: enum previo sigue soportado.
 *
 * ── Seguridad ────────────────────────────────────────────────────────
 *
 * Sin backfill sobre tablas RLS → NO reproduce el P0 08-01. La migration
 * es 100% DDL puro (ALTER TABLE ADD COLUMN + ALTER CONSTRAINT). Corre
 * limpia bajo `ipro_app` NOSUPERUSER porque los ADD COLUMN sobre tablas
 * con FORCE RLS no requieren tocar rows existentes (los rows nuevos
 * heredan NULL en la columna nueva, no viola WITH CHECK del policy).
 *
 * Verificado con job CI `Migrations from-scratch as ipro_app NOSUPERUSER`.
 *
 * ── Rollback ─────────────────────────────────────────────────────────
 *
 * `down()`:
 *   1. Revertir CHECK constraint origen (drop 'deuda' e 'inversion' — falla
 *      si hay filas usando esos values; hay que soft-delete o migrar antes)
 *   2. DROP COLUMN caja_id + tc de las 2 tablas
 *
 * DATA LOSS del rollback: los links a caja_id se pierden. Los movimientos
 * quedan pero sin el link → pierde trazabilidad (aceptable en rollback).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ─── 1. movimientos_deudas: caja_id + tc ────────────────────────────
  pgm.sql(`
    ALTER TABLE movimientos_deudas
      ADD COLUMN caja_id INTEGER REFERENCES metodos_pago(id),
      ADD COLUMN tc      NUMERIC(14,4);

    -- Index parcial: solo rows con caja_id set (mayoría nueva post-cutover).
    -- Sirve para queries de reverso al DELETE (reverseCajaMovimientos).
    CREATE INDEX IF NOT EXISTS idx_mov_deudas_caja
      ON movimientos_deudas (caja_id)
      WHERE caja_id IS NOT NULL;
  `);

  // ─── 2. movimientos_inversiones: caja_id + tc ───────────────────────
  pgm.sql(`
    ALTER TABLE movimientos_inversiones
      ADD COLUMN caja_id INTEGER REFERENCES metodos_pago(id),
      ADD COLUMN tc      NUMERIC(14,4);

    CREATE INDEX IF NOT EXISTS idx_mov_inv_caja
      ON movimientos_inversiones (caja_id)
      WHERE caja_id IS NOT NULL;
  `);

  // ─── 3. caja_movimientos.origen: extender enum ──────────────────────
  //
  // Mismo pattern del PR RELEVO (migration 20260729200000):
  //   1. DROP constraint viejo
  //   2. ADD constraint con enum extendido
  //
  // Backward compat: todos los origenes previos siguen soportados. Nuevos:
  //   - 'deuda'    → caja_movimiento generado desde movimientos_deudas
  //   - 'inversion' → caja_movimiento generado desde movimientos_inversiones
  pgm.sql(`
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN (
        'venta','b2b','financiera','envio','egreso','proveedor',
        'ajuste','transferencia','cambio','tarjeta','proyecto','relevo',
        'deuda','inversion'
      ));
  `);
};

exports.down = (pgm) => {
  // Revertir CHECK constraint al set previo (sin 'deuda' e 'inversion').
  // Si quedan filas con estos values, el ADD CONSTRAINT falla — hay que
  // migrar/soft-deletear antes.
  pgm.sql(`
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN (
        'venta','b2b','financiera','envio','egreso','proveedor',
        'ajuste','transferencia','cambio','tarjeta','proyecto','relevo'
      ));

    DROP INDEX IF EXISTS idx_mov_deudas_caja;
    DROP INDEX IF EXISTS idx_mov_inv_caja;

    ALTER TABLE movimientos_deudas
      DROP COLUMN IF EXISTS caja_id,
      DROP COLUMN IF EXISTS tc;

    ALTER TABLE movimientos_inversiones
      DROP COLUMN IF EXISTS caja_id,
      DROP COLUMN IF EXISTS tc;
  `);
};
