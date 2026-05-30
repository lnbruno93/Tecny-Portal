/* eslint-disable camelcase */
/**
 * Migración — Tabla de configuración de Alertas.
 *
 * Cada tipo de alerta tiene un row con su estado (activa/inactiva) y sus
 * parámetros (jsonb). El evaluador en runtime corre las queries de los
 * tipos activos.
 *
 * Tipos del MVP (seed inicial):
 *   - caja_negativa     — caja con saldo < 0 (sin umbral).
 *   - stock_bajo        — productos con cantidad < umbral_unidades.
 *   - cc_mora           — clientes con saldo > 0 sin pago hace > dias_sin_pago.
 *   - proveedor_atrasado — proveedores con saldo > 0 sin movimiento hace > dias_sin_movimiento.
 *
 * Permite agregar más tipos sin migraciones nuevas (solo INSERT manual al
 * deploy o seed). La constraint UNIQUE en `tipo` evita duplicados.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS alertas_config (
      id          SERIAL PRIMARY KEY,
      tipo        TEXT NOT NULL UNIQUE,
      activa      BOOLEAN NOT NULL DEFAULT true,
      parametros  JSONB NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Seed inicial: los 4 tipos del MVP, todos activos con defaults sensatos.
    INSERT INTO alertas_config (tipo, activa, parametros) VALUES
      ('caja_negativa',      true, '{}'),
      ('stock_bajo',         true, '{"umbral_unidades": 5}'),
      ('cc_mora',            true, '{"dias_sin_pago": 30}'),
      ('proveedor_atrasado', true, '{"dias_sin_movimiento": 30}')
    ON CONFLICT (tipo) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS alertas_config;`);
};
