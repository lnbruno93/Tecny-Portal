/**
 * Migration: caja_transferencias (#505 — Movimientos de Caja).
 *
 * Feature nueva: registrar traslados internos de dinero entre 2 cajas propias
 * del negocio (ej. sacar USD del banco → efectivo USD, mover ARS de caja1 a
 * caja2). NO es una venta ni un egreso — es plata que ya era tuya y sigue
 * siendo tuya, solo cambió de "contenedor".
 *
 * Diferencia con lo que ya existe:
 *   - `egresos` → 1 caja, la plata SALE del negocio (proveedor, luz, sueldos).
 *   - `cambio_movimientos` → 2 cajas + 2 monedas + financiera EXTERNA
 *     (cambista Bruno, MEP, etc.).
 *   - `caja_transferencias` (nuevo) → 2 cajas propias, MISMA moneda, sin
 *     financiera. Simple traslado interno.
 *
 * Modelo:
 *   - `monto` es lo que efectivamente entra a la caja destino.
 *   - `costo` (opcional) es la comisión bancaria — sale de la caja origen
 *     ADEMÁS del monto (ej. banco cobra $500 por el retiro). Si es 0/null,
 *     no hay costo y sale solo el monto.
 *   - `caja_origen_id` != `caja_destino_id` (CHECK): no tiene sentido
 *     transferirse a sí misma.
 *   - `monto > 0` (CHECK): no aceptamos transferencias vacías.
 *   - `costo >= 0` (CHECK): la comisión no puede ser negativa (sería un
 *     ingreso, que se registra distinto).
 *   - Al crear, el handler postea 2 asientos al ledger `caja_movimientos`:
 *       · caja_origen: egreso por (monto + costo), origen='transferencia'
 *       · caja_destino: ingreso por monto, origen='transferencia'
 *     El enum `caja_movimientos.origen` ya soporta 'transferencia' desde la
 *     migration 20260529000001. No hace falta ampliar el CHECK.
 *   - Al eliminar (soft delete), se reversan los 2 asientos del ledger.
 *
 * RLS: tenant-scoped estándar. Mismo patrón que venta_emails_enviados
 * (20260630100001) y el resto de tablas post-multitenant.
 *
 * Índices:
 *   - Lookup principal: "últimas transferencias del tenant" para el historial
 *     de la pantalla (tenant_id, fecha DESC, id DESC).
 *   - Filtros por caja: (caja_origen_id) y (caja_destino_id) para
 *     "mostrame los movimientos de la caja X" (feature potencial futura).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE caja_transferencias (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      fecha            DATE NOT NULL,
      caja_origen_id   INTEGER NOT NULL REFERENCES metodos_pago(id) ON DELETE RESTRICT,
      caja_destino_id  INTEGER NOT NULL REFERENCES metodos_pago(id) ON DELETE RESTRICT,
      moneda           TEXT NOT NULL CHECK (moneda IN ('ARS','USD','USDT','UYU')),
      monto            NUMERIC(14,2) NOT NULL CHECK (monto > 0),
      costo            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (costo >= 0),
      descripcion      TEXT,
      user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- Invariante: no se puede transferir de una caja a sí misma.
      CONSTRAINT chk_cajas_distintas CHECK (caja_origen_id <> caja_destino_id)
    );

    -- Lookup principal: historial "últimas del tenant".
    CREATE INDEX idx_caja_transf_tenant_fecha
      ON caja_transferencias (tenant_id, fecha DESC, id DESC)
      WHERE deleted_at IS NULL;

    -- Filtro por caja origen (para futuros filtros / detalles por caja).
    CREATE INDEX idx_caja_transf_origen
      ON caja_transferencias (caja_origen_id)
      WHERE deleted_at IS NULL;

    -- Filtro por caja destino.
    CREATE INDEX idx_caja_transf_destino
      ON caja_transferencias (caja_destino_id)
      WHERE deleted_at IS NULL;

    -- RLS estándar (tenant-scoped). FORCE para blindar contra role owner
    -- (solo BYPASSRLS del admin pool puede ver cross-tenant).
    ALTER TABLE caja_transferencias ENABLE ROW LEVEL SECURITY;
    ALTER TABLE caja_transferencias FORCE  ROW LEVEL SECURITY;
    CREATE POLICY caja_transferencias_tenant_isolation ON caja_transferencias
      USING (tenant_id = current_setting('app.current_tenant', true)::integer);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS caja_transferencias_tenant_isolation ON caja_transferencias;
    DROP INDEX IF EXISTS idx_caja_transf_destino;
    DROP INDEX IF EXISTS idx_caja_transf_origen;
    DROP INDEX IF EXISTS idx_caja_transf_tenant_fecha;
    DROP TABLE IF EXISTS caja_transferencias;
  `);
};
