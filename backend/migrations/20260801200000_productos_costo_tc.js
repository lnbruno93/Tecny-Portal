/**
 * Migration: agregar `productos.costo_tc` — TC de compra para costos en ARS/UYU
 *
 * ── Contexto (regla PO Lucas 2026-08-01) ────────────────────────────────
 *
 * Cuando se carga un producto con costo en pesos (ARS/UYU), el operador
 * debe poder ingresar el TC del día para convertir a USD al instante.
 * Todo el stock se mide en USD, y el KPI "valorizado" debe unificar
 * costos de todas las monedas usando la conversión.
 *
 * Estado previo: `productos` tenía `costo` + `costo_moneda` pero NO TC.
 * Un producto en ARS quedaba SIN forma de saber a qué USD equivalía →
 * el KPI valorizado los reportaba en `inv_ars` separado (o no aparecían
 * en `inv_usd`), sub-valorizando el stock real.
 *
 * ── Q2 (decisión PO) ────────────────────────────────────────────────────
 *
 * Los productos legacy en ARS/UYU quedan con `costo_tc = NULL` (no
 * hacemos backfill retroactivo ficticio). El KPI unificado los excluye
 * y el Dashboard muestra un warning "N productos sin TC — completá para
 * incluirlos en el valorizado" (Q3 no-bloqueante).
 *
 * ── Shape ───────────────────────────────────────────────────────────────
 *
 * NUMERIC(20, 6) — mismo shape que `ventas.tc_venta` y otros TC del
 * sistema. Nullable porque:
 *   - costo_moneda='USD'/'USDT' → costo_tc NO aplica (siempre NULL).
 *   - costo_moneda='ARS'/'UYU' + producto legacy → NULL (a completar).
 *   - costo_moneda='ARS'/'UYU' + producto nuevo → NOT NULL (Zod refine
 *     al INSERT/UPDATE lo exige — DB tolera NULL por backward compat).
 *
 * CHECK constraint: `costo_tc IS NULL OR costo_tc > 0`. Evita 0/negativos
 * que causarían división por cero en las queries del valorizado.
 */

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE productos
      ADD COLUMN IF NOT EXISTS costo_tc NUMERIC(20, 6) DEFAULT NULL;
  `);

  // CHECK constraint separado por si la columna ya existe (idempotencia).
  // Lo agregamos con NOT VALID + VALIDATE para no bloquear si hay rows
  // existentes (no debería, es columna nueva).
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'productos_costo_tc_positive'
      ) THEN
        ALTER TABLE productos
          ADD CONSTRAINT productos_costo_tc_positive
          CHECK (costo_tc IS NULL OR costo_tc > 0);
      END IF;
    END $$;
  `);

  // Index parcial: solo indexamos rows donde costo_tc IS NOT NULL. Sirve
  // para queries futuras que filtren "productos con TC seteado" en el
  // contador del warning (COUNT WHERE costo_moneda IN (ARS,UYU) AND
  // costo_tc IS NULL). Al filtrar por NULL Postgres puede usar este
  // index en modo NOT EXISTS via anti-join. Cheap, ~1 KB por 1000 rows.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_productos_costo_tc_not_null
      ON productos (id)
      WHERE costo_tc IS NOT NULL;
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_productos_costo_tc_not_null;`);
  pgm.sql(`
    ALTER TABLE productos
      DROP CONSTRAINT IF EXISTS productos_costo_tc_positive;
  `);
  pgm.sql(`ALTER TABLE productos DROP COLUMN IF EXISTS costo_tc;`);
};
