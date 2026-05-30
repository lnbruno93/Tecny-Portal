/* eslint-disable camelcase */
/**
 * Migración — caja_id + tipo en proyecto_movimientos
 *
 * Gap detectado en mini-auditoría post-merge: los movimientos de proyecto
 * (ingreso/egreso de inversiones/gastos) NO se vinculaban a ninguna caja,
 * así que NO impactaban en el saldo del ledger ni aparecían en Capital.
 * Cargar una inversión de USD 5000 en un proyecto dejaba el saldo de las
 * cajas intacto, lo cual rompía el invariante "lo que sale de una caja
 * sale del ledger".
 *
 * Schema:
 *   - `caja_id INTEGER` FK → metodos_pago(id) ON DELETE SET NULL.
 *     NULL para movimientos legacy (anteriores al deploy) → no postearon
 *     a caja y mantienen ese comportamiento (no se retro-postean).
 *   - `tipo VARCHAR(10)` CHECK ('ingreso' | 'egreso'). Default 'egreso'
 *     porque los movimientos típicos son inversiones/gastos. NULL solo
 *     en filas legacy.
 *
 * Índice: caja_id WHERE caja_id IS NOT NULL (para queries del ledger).
 *
 * Reversibilidad: down() borra las columnas. Cualquier postCajaMovimiento
 * que ya haya impactado queda en caja_movimientos con ref_tabla
 * 'proyecto_movimientos' y ref_id válido — el down NO toca esos
 * registros del ledger (sería destructivo y muy difícil de revertir).
 * Si necesitás "deshacer" el deploy, primero corré los reverses desde
 * la app antes de bajar la migración.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE proyecto_movimientos
      ADD COLUMN IF NOT EXISTS caja_id INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS tipo    VARCHAR(10) CHECK (tipo IN ('ingreso', 'egreso'));

    CREATE INDEX IF NOT EXISTS idx_proy_mov_caja
      ON proyecto_movimientos (caja_id) WHERE caja_id IS NOT NULL;

    -- Extender el CHECK de caja_movimientos.origen para aceptar 'proyecto'.
    -- Antes: venta/b2b/financiera/envio/egreso/proveedor/ajuste/transferencia/cambio/tarjeta.
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN ('venta','b2b','financiera','envio','egreso','proveedor',
                        'ajuste','transferencia','cambio','tarjeta','proyecto'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir el CHECK al set previo (sin 'proyecto'). Si quedan filas con
    -- origen='proyecto', el constraint nuevo fallará — hay que borrar/migrar
    -- esas filas antes del down.
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN ('venta','b2b','financiera','envio','egreso','proveedor',
                        'ajuste','transferencia','cambio','tarjeta'));

    DROP INDEX IF EXISTS idx_proy_mov_caja;
    ALTER TABLE proyecto_movimientos
      DROP COLUMN IF EXISTS tipo,
      DROP COLUMN IF EXISTS caja_id;
  `);
};
