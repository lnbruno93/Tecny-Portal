// TC para plantillas de egreso recurrente: sin él, los recurrentes en ARS generaban
// egresos con monto_usd = 0 (subcontaba los totales en USD hasta pagarlos).
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE egresos_recurrentes ADD COLUMN IF NOT EXISTS tc NUMERIC(14,4);');
};
exports.down = (pgm) => {
  pgm.sql('ALTER TABLE egresos_recurrentes DROP COLUMN IF EXISTS tc;');
};
