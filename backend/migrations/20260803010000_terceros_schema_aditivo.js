/* eslint-disable camelcase */
/**
 * Terceros refactor — Fase 1 PR 1.1: schema aditivo (task #149).
 *
 * Design doc: docs/TERCEROS_REFACTOR_PLAN.md
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * Hoy no se puede modelar un tercero que es SIMULTÁNEAMENTE cliente y
 * proveedor. `clientes_cc` y `proveedores` son tablas disjuntas.
 *
 * Caso concreto (reportado por Lucas + otro cliente):
 *   - Kevin le compró 4 PlayStations + 1 Samsung → Kevin debe USD 5000
 *     (registrado en clientes_cc).
 *   - Lucas le compró PlayStations a Kevin y adelantó USD 2500 (registrado
 *     en proveedores).
 *   - Saldo neto real: Kevin debe 2500 USD. El sistema muestra 2 saldos
 *     separados sin poder consolidar.
 *
 * ── Cambios de este PR (Fase 1 PR 1.1) ────────────────────────────────
 *
 * PURAMENTE ADITIVO. NO migra datos, NO toca tablas viejas, NO expone
 * endpoints. Solo crea las 3 tablas nuevas del modelo unificado más su
 * RLS canónica. Datos coexisten hasta PR 1.2 (migración) + PR 1.3
 * (endpoints) + Fase 2 (UI) + Fase 3 (cutover).
 *
 * 1. `terceros` — entidad unificada con flags `es_cliente` +
 *    `es_proveedor` (pueden ser ambos true).
 * 2. `tercero_movimientos` — movimientos con `tipo` signed. El saldo del
 *    tercero = SUM(monto_usd × signo(tipo)).
 * 3. `tercero_items` — clone de items_movimiento_cc para preservar
 *    detalles ricos (imei_serial, verificado, color, modelo, etc.).
 *
 * ── Preservación de datos legacy ──────────────────────────────────────
 *
 * Cada tabla incluye campos `legacy_cliente_cc_id` / `legacy_proveedor_id`
 * para trazar cada fila migrada de vuelta a su origen. Facilita:
 *   - Reversión (rollback per-tenant si algo sale mal)
 *   - Auditoría (comparar saldo pre/post)
 *   - Grep-based tooling (buscar movs viejos por origen)
 *
 * NO tocamos ni referenciamos con FK a las tablas viejas — coexistencia
 * limpia. Cuando Fase 3 cierre las tablas viejas, se pueden dropear
 * estos campos legacy sin cambiar la lógica principal.
 *
 * ── Tipos de movimiento ───────────────────────────────────────────────
 *
 * Union type que cubre AMBOS mundos:
 *
 *   Aumentan saldo (tercero nos debe MÁS):
 *     · venta                  (le vendimos)
 *     · pago_enviado           (nosotros le pagamos — ej. anticipo a
 *                              proveedor que es también cliente)
 *     · adelanto_dado          (le adelantamos plata)
 *     · devolucion_compra      (nos devolvió algo que le habíamos
 *                              comprado antes)
 *
 *   Bajan saldo (tercero nos debe MENOS o le debemos MÁS):
 *     · compra                 (le compramos)
 *     · pago_recibido          (nos pagó)
 *     · adelanto_recibido      (nos adelantó plata)
 *     · devolucion_venta       (le devolvimos algo que nos había
 *                              comprado)
 *     · entrega_mercaderia     (nos entregó productos para cancelar
 *                              deuda — task #150 lo introdujo en
 *                              proveedor_movimientos)
 *     · mercaderia_recibida    (le entregamos productos para cancelar
 *                              deuda — mercaderia_recibida en
 *                              movimientos_cc)
 *
 *   Sign-preservado (puede ser +/-):
 *     · saldo_inicial          (al alta del tercero, deuda heredada
 *                              o crédito heredado)
 *
 * El saldo real se computa en `lib/tercerosSaldo.js` (PR 1.3) con un
 * CASE unificado — mismo pattern que `lib/saldoCC.js` +
 * `lib/saldoProveedor.js` (task #150, Fase 0).
 *
 * ── RLS ───────────────────────────────────────────────────────────────
 *
 * Las 3 tablas usan `enableTenantRlsFor()` del canónico (FORCE RLS con
 * policy `tenant_isolation` + predicate fail-closed). Ver
 * `lib/rlsCanonical.js` — se agregan las 3 tablas a `TABLAS_TENANT_SCOPED`
 * en el mismo PR para que la startup assertion las verifique.
 *
 * ── Rollback ──────────────────────────────────────────────────────────
 *
 * `down()` DROP las 3 tablas nuevas (con CASCADE por seguridad — el
 * único ref circular es tercero_items → tercero_movimientos → terceros).
 * Sistema queda idéntico a pre-migration porque nada las consumía.
 *
 * DATA LOSS RISK: cero mientras no arranque Fase 1 PR 1.2 (que migra
 * datos reales). Este PR llega vacío a prod. Si se rolleó con datos
 * migrados, restore desde backup B2 (backups Railway diarios).
 */

const { enableTenantRlsFor } = require('../src/lib/rlsCanonical');

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ─── 1. terceros ────────────────────────────────────────────────────
  //
  // Entidad unificada. Se puede ser cliente, proveedor, o ambos.
  //
  // FKs:
  //   · tenant_id: cascade delete si el tenant se elimina (nunca pasa
  //     en prod porque tenants son long-lived, pero mantiene consistencia
  //     si algún día se borra un tenant de test).
  //   · contacto_id: SET NULL si se borra el contacto. Es opcional — un
  //     tercero puede existir sin contacto asignado (ej. importado o
  //     dado de alta rápido con solo nombre).
  //
  // Índices:
  //   · (tenant_id, LOWER(nombre)) — búsqueda case-insensitive por nombre,
  //     que es el flow más común (dropdowns en Ventas / Cuentas).
  //   · (tenant_id, es_cliente) partial WHERE es_cliente = true — lookup
  //     rápido de "clientes activos" para el módulo Cuentas B2B.
  //   · (tenant_id, es_proveedor) partial WHERE es_proveedor = true —
  //     equivalente para el módulo Proveedores.
  //   · (tenant_id, legacy_cliente_cc_id) partial NOT NULL — para joins
  //     de migración inversa (encontrar el tercero originado en un
  //     cliente_cc específico).
  //   · (tenant_id, legacy_proveedor_id) partial NOT NULL — idem.
  //
  // CHECK constraint: al menos uno de los 2 flags debe estar en true.
  // Un tercero sin flags no tiene sentido operativo (no aparece en
  // ninguna pantalla).
  pgm.sql(`
    CREATE TABLE terceros (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id             INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      contacto_id           INTEGER          REFERENCES contactos(id) ON DELETE SET NULL,
      nombre                TEXT NOT NULL,
      apellido              TEXT,
      whatsapp              TEXT,
      ubicacion             TEXT,
      categoria             TEXT,                 -- VIP/A+/A- de clientes_cc, NULL para ex-proveedores
      notas                 TEXT,
      es_cliente            BOOLEAN NOT NULL DEFAULT FALSE,
      es_proveedor          BOOLEAN NOT NULL DEFAULT FALSE,
      saldo_inicial_usd     NUMERIC(14,2) NOT NULL DEFAULT 0,
      -- Legacy tracing (borrar en Fase 3 cutover):
      legacy_cliente_cc_id  INTEGER,              -- FK conceptual a clientes_cc.id (sin FK real: coexistencia)
      legacy_proveedor_id   INTEGER,              -- FK conceptual a proveedores.id
      -- Metadata:
      deleted_at            TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Invariante operativo:
      CONSTRAINT terceros_al_menos_un_flag CHECK (es_cliente = TRUE OR es_proveedor = TRUE)
    );

    CREATE INDEX idx_terceros_tenant_nombre_lower
      ON terceros (tenant_id, LOWER(nombre));

    CREATE INDEX idx_terceros_tenant_cliente
      ON terceros (tenant_id) WHERE es_cliente = TRUE AND deleted_at IS NULL;

    CREATE INDEX idx_terceros_tenant_proveedor
      ON terceros (tenant_id) WHERE es_proveedor = TRUE AND deleted_at IS NULL;

    CREATE INDEX idx_terceros_legacy_cliente_cc
      ON terceros (tenant_id, legacy_cliente_cc_id)
      WHERE legacy_cliente_cc_id IS NOT NULL;

    CREATE INDEX idx_terceros_legacy_proveedor
      ON terceros (tenant_id, legacy_proveedor_id)
      WHERE legacy_proveedor_id IS NOT NULL;
  `);

  // ─── 2. tercero_movimientos ─────────────────────────────────────────
  //
  // Movimientos signed. El saldo se computa con SUM(monto × signo(tipo)).
  //
  // CHECK en `tipo`: enumera los 10 tipos del union. Si más adelante hay
  // que agregar un tipo nuevo, requiere ALTER (aditiva).
  //
  // FKs opcionales:
  //   · caja_id: pago recibido/enviado que impacta caja específica.
  //   · venta_id: link a la venta original (para retail y B2B).
  //     Nullable porque proveedores no tienen ventas.
  //
  // Nueva FK `creado_por` (INTEGER users) NULLABLE — sirve para audit
  // trail. Legacy: los movimientos_cc de la app vieja NO trackean quién
  // los creó. El backfill de PR 1.2 llena NULL para movs migrados y sólo
  // los nuevos (post-cutover) traen el user_id.
  //
  // Multi-moneda: `moneda` DEFAULT 'USD' matchea el legacy (todos los
  // movs viejos son USD implícito). Migrations futuras podrían extender
  // a ARS/UYU nativo si el negocio lo requiere.
  //
  // Índices:
  //   · (tenant_id, tercero_id, fecha DESC) — timeline por tercero,
  //     query dominante (ficha detalle).
  //   · (tenant_id, fecha DESC) — dashboard cross-tercero (deudas por
  //     período).
  //   · (tenant_id, venta_id) partial NOT NULL — join reverso desde
  //     venta al mov (para saber si una venta ya fue pagada).
  pgm.sql(`
    CREATE TABLE tercero_movimientos (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id             INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      tercero_id            UUID    NOT NULL REFERENCES terceros(id) ON DELETE CASCADE,
      fecha                 DATE    NOT NULL,
      tipo                  TEXT    NOT NULL,
      monto_usd             NUMERIC(14,2) NOT NULL,
      monto_ars             NUMERIC(14,2),
      tc                    NUMERIC(14,4),
      moneda                TEXT    NOT NULL DEFAULT 'USD',
      caja_id               INTEGER          REFERENCES metodos_pago(id) ON DELETE SET NULL,
      venta_id              INTEGER          REFERENCES ventas(id) ON DELETE SET NULL,
      concepto              TEXT,
      creado_por            INTEGER          REFERENCES users(id) ON DELETE SET NULL,
      -- Legacy tracing (borrar en Fase 3):
      legacy_movimiento_cc_id       INTEGER,
      legacy_proveedor_movimiento_id INTEGER,
      -- Metadata:
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at            TIMESTAMPTZ,
      -- Invariantes:
      CONSTRAINT tercero_movimientos_tipo_valido CHECK (tipo IN (
        'venta',
        'compra',
        'pago_recibido',
        'pago_enviado',
        'adelanto_dado',
        'adelanto_recibido',
        'devolucion_venta',
        'devolucion_compra',
        'entrega_mercaderia',
        'mercaderia_recibida',
        'saldo_inicial'
      )),
      CONSTRAINT tercero_movimientos_moneda_valida CHECK (moneda IN ('USD', 'ARS', 'UYU')),
      CONSTRAINT tercero_movimientos_monto_no_negativo CHECK (monto_usd >= 0)
    );

    CREATE INDEX idx_tercero_movs_tenant_tercero_fecha
      ON tercero_movimientos (tenant_id, tercero_id, fecha DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_tercero_movs_tenant_fecha
      ON tercero_movimientos (tenant_id, fecha DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_tercero_movs_tenant_venta
      ON tercero_movimientos (tenant_id, venta_id)
      WHERE venta_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX idx_tercero_movs_legacy_cc
      ON tercero_movimientos (tenant_id, legacy_movimiento_cc_id)
      WHERE legacy_movimiento_cc_id IS NOT NULL;

    CREATE INDEX idx_tercero_movs_legacy_prov
      ON tercero_movimientos (tenant_id, legacy_proveedor_movimiento_id)
      WHERE legacy_proveedor_movimiento_id IS NOT NULL;
  `);

  // ─── 3. tercero_items ───────────────────────────────────────────────
  //
  // Ítems (líneas de detalle) de un movimiento. Espejo estructural de
  // `items_movimiento_cc` (B2B) + `proveedor_movimiento_items` (compra
  // proveedor) — mismos campos operativos.
  //
  // Preserva detalles ricos que hoy están duplicados entre las 2 tablas
  // viejas: IMEI, color, modelo, tamaño, notas, verificado, valor USD.
  //
  // Sin `tenant_id` propio: se hereda del movimiento padre vía JOIN. RLS
  // igual se activa con enableTenantRlsFor() usando expresión SELECT
  // sobre el padre (ver rlsCanonical.js — hay pattern para tablas
  // child-only sin tenant_id propio; en este caso lo agregamos para
  // consistencia con las hijas de la app vieja y para query performance).
  //
  // ON DELETE CASCADE en tercero_movimiento_id: borrar el mov borra sus
  // ítems (no queda basura huérfana).
  //
  // producto_id opcional: link al inventario si el ítem viene de un
  // producto trackeado (para syncing stock). Nullable porque muchos ítems
  // legacy no tenían producto_id (movimientos manuales).
  pgm.sql(`
    CREATE TABLE tercero_items (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id                 INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      tercero_movimiento_id     UUID NOT NULL REFERENCES tercero_movimientos(id) ON DELETE CASCADE,
      producto_id               INTEGER          REFERENCES productos(id) ON DELETE SET NULL,
      producto                  TEXT,                    -- nombre libre (legacy compat)
      modelo                    TEXT,
      tamano                    TEXT,
      color                     TEXT,
      imei_serial               TEXT,
      valor                     NUMERIC(14,2),
      verificado                BOOLEAN NOT NULL DEFAULT FALSE,
      notas                     TEXT,
      -- Legacy tracing (borrar en Fase 3):
      legacy_item_movimiento_cc_id      INTEGER,
      legacy_proveedor_movimiento_item_id INTEGER,
      -- Metadata:
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_tercero_items_movimiento
      ON tercero_items (tercero_movimiento_id);

    CREATE INDEX idx_tercero_items_tenant_producto
      ON tercero_items (tenant_id, producto_id)
      WHERE producto_id IS NOT NULL;

    CREATE INDEX idx_tercero_items_tenant_imei
      ON tercero_items (tenant_id, imei_serial)
      WHERE imei_serial IS NOT NULL;
  `);

  // ─── 4. RLS canónica ────────────────────────────────────────────────
  //
  // ENABLE + FORCE + policy `tenant_isolation` con predicate fail-closed.
  // Ver `lib/rlsCanonical.js` para el pattern completo — este helper
  // consolida las 3 acciones en 1 call por tabla.
  //
  // CRÍTICO: FORCE ROW LEVEL SECURITY es default del proyecto (53/57
  // tablas). Si en algún momento hay que hacer UPDATE/backfill sobre
  // estas tablas desde una migration, seguir el pattern del
  // `docs/RUNBOOK_MIGRATION_RLS_FORCE.md` (ALTER TABLE NO FORCE + UPDATE
  // + FORCE dentro de la tx) — usar `SET LOCAL row_security = off` NO
  // funciona con FORCE + NOSUPERUSER + sin BYPASSRLS.
  enableTenantRlsFor(pgm, 'terceros');
  enableTenantRlsFor(pgm, 'tercero_movimientos');
  enableTenantRlsFor(pgm, 'tercero_items');
};

exports.down = (pgm) => {
  // Reverse order (child → parent) para respetar FKs.
  // CASCADE por seguridad — el único ref circular sería tercero_items
  // → tercero_movimientos → terceros, ya cubierto por ON DELETE CASCADE.
  pgm.sql(`
    DROP TABLE IF EXISTS tercero_items CASCADE;
    DROP TABLE IF EXISTS tercero_movimientos CASCADE;
    DROP TABLE IF EXISTS terceros CASCADE;
  `);
};
