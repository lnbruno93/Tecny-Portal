/**
 * Fix multi-tenant — fase 2: `idx_metodos_pago_nombre` también era globalmente
 * único (LOWER(nombre) sin tenant_id). Eso bloqueaba que dos tenants distintos
 * tuvieran cajas con el mismo nombre — ej. "Efectivo Pesos" en cada uno.
 *
 * Misma motivación que migration 005 (idx_metodos_pago_financiera).
 * Separadas porque al editar 005 después del primer run, su segunda parte
 * (este fix) no se reaplicaba en envs donde la migration ya estaba registrada.
 *
 * Idempotente. Down restaura global — riesgoso si hay >1 tenant con misma caja.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_metodos_pago_nombre;
    CREATE UNIQUE INDEX idx_metodos_pago_nombre
      ON metodos_pago (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_metodos_pago_nombre;
    CREATE UNIQUE INDEX idx_metodos_pago_nombre
      ON metodos_pago (LOWER(nombre)) WHERE deleted_at IS NULL;
  `);
};
