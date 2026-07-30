/* eslint-disable camelcase */
/**
 * Migración — extender caja_movimientos.origen_check con 'relevo'.
 *
 * Feature RELEVO (2026-07-29): ajuste manual de saldo de una caja para
 * reconciliar contra la realidad. Casos de uso: pagos olvidados, gastos
 * fuera del sistema, movimientos por error no cargados. Ver
 * `backend/src/routes/cajas.js` handler POST /:id/relevo.
 *
 * Additive migration: agrega 'relevo' al CHECK constraint del origen sin
 * tocar filas existentes. Pattern idéntico a la migración `20260603000016`
 * que agregó 'proyecto'.
 *
 * Diseño del origen 'relevo':
 *   - `caja_movimientos.origen = 'relevo'`
 *   - `tipo` = 'ingreso' o 'egreso' según el signo del delta (server-side)
 *   - `monto` = abs(delta) — siempre positivo
 *   - `concepto` = la nota obligatoria que ingresa el user (min 10 chars,
 *     validado en el Zod schema)
 *   - `ref_tabla` / `ref_id` = NULL (no referencia otro registro; el relevo
 *     ES el registro primario del ajuste)
 *   - `user_id` = quien hizo el relevo (audit)
 *
 * Snapshot completo (saldo_anterior, saldo_nuevo, nota, usuario, timestamp)
 * queda en `audit_logs.despues` — no requiere columna nueva.
 *
 * Dashboard exclusion: queries del Dashboard filtran `AND origen <> 'relevo'`
 * para que los relevos NO cuenten como cobros/pagos operacionales.
 *
 * Reversibilidad: `down()` remueve 'relevo' del CHECK. Si existen filas
 * con `origen='relevo'`, el constraint nuevo fallará — hay que migrar
 * o soft-deletar esas filas antes del down.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN ('venta','b2b','financiera','envio','egreso','proveedor',
                        'ajuste','transferencia','cambio','tarjeta','proyecto','relevo'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir al set previo (sin 'relevo'). Si quedan filas con origen='relevo'
    -- (relevos ya ejecutados), el constraint nuevo fallará. Para bajar:
    --   1. Identificar los relevos: SELECT id FROM caja_movimientos WHERE origen='relevo';
    --   2. Decidir: soft-delete (deleted_at) o cambiar origen a 'ajuste'.
    --   3. Correr el down.
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN ('venta','b2b','financiera','envio','egreso','proveedor',
                        'ajuste','transferencia','cambio','tarjeta','proyecto'));
  `);
};
