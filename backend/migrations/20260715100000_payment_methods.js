/**
 * Métodos de pago maestros + FK en tenants.
 *
 * 2026-07-15 (task #132, feature): la pantalla Facturación necesita mostrar
 * y editar el método de pago de cada tenant. Lucas quiere una lista maestra
 * editable (con opciones que él setea previamente) y asignar UNO por tenant.
 *
 * Diseño:
 *   · payment_methods: catálogo global (admin-managed). Sin RLS — solo se
 *     accede vía /api/super-admin/*.
 *   · tenants.metodo_pago_id: FK opcional. ON DELETE SET NULL para que
 *     eliminar un método no borre el tenant, solo lo deje "sin método".
 *
 * Semántica del soft-delete:
 *   · Un método "inactivo" (activo=false) NO aparece en el dropdown de
 *     asignación, PERO tenants ya asignados a ese método siguen mostrándolo
 *     en la tabla. Cuando Lucas los reasigne, ese método quedará sin uso.
 *   · Hard-delete solo permitido si no hay tenants apuntando (el endpoint
 *     backend lo enforcea, no la DB — la FK ON DELETE SET NULL permitiría
 *     borrar sin problemas pero desasignaría tenants sin aviso).
 *
 * Sin seed en la migration: dejar que Lucas configure sus propios métodos
 * desde el UI. Si hace falta seed más adelante (para nuevos tenants), se
 * agrega en una migration siguiente sin tocar esta.
 */

exports.up = (pgm) => {
  // pgcrypto ya está creada por migraciones anteriores (UUIDs).
  pgm.sql(`
    CREATE TABLE payment_methods (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre       TEXT NOT NULL,
      activo       BOOLEAN NOT NULL DEFAULT true,
      orden        INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT payment_methods_nombre_not_empty CHECK (length(trim(nombre)) > 0)
    );

    -- Unicidad case-insensitive del nombre. Evita "Tarjeta" vs "tarjeta"
    -- como métodos distintos que en la UI se ven igual.
    CREATE UNIQUE INDEX payment_methods_nombre_unique_ci
      ON payment_methods (LOWER(TRIM(nombre)));

    -- Orden explícito para el dropdown. Índice ayuda al ORDER BY que hace el
    -- endpoint list.
    CREATE INDEX payment_methods_orden_idx ON payment_methods (orden, nombre);

    -- FK opcional en tenants. NULL = "sin método asignado".
    ALTER TABLE tenants
      ADD COLUMN metodo_pago_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL;

    CREATE INDEX tenants_metodo_pago_id_idx ON tenants (metodo_pago_id) WHERE metodo_pago_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN IF EXISTS metodo_pago_id;
    DROP TABLE IF EXISTS payment_methods;
  `);
};
