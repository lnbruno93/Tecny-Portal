/**
 * Migration: Red B2B — partnerships + operaciones cross-tenant schema (F1).
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 4.1. Esta migration
 * crea las 5 tablas necesarias para F1→F5 en un solo cambio de schema —
 * F1 sólo consume `tenant_partnerships` + `cross_tenant_notifications`,
 * pero el resto del schema queda creado para evitar churn en migrations
 * futuras (Lucas lo prefirió así explícitamente, ver diseño).
 *
 * Las 5 tablas:
 *
 *   1. tenant_partnerships
 *      Vínculo bilateral aceptado entre dos tenants. Convención
 *      `tenant_a_id < tenant_b_id` SIEMPRE (evita filas duplicadas (A,B)+(B,A)
 *      para el mismo vínculo). RLS especial DUAL: una fila es visible a AMBOS
 *      tenants involucrados (no es como las tablas estándar tenant_id=X).
 *      ENABLE RLS sin FORCE — las escrituras se hacen con db.adminQuery
 *      (BYPASSRLS / role tecny_admin), las lecturas pasan por la policy.
 *
 *   2. cross_tenant_operations
 *      La operación maestra (1 venta cross-tenant = 1 fila). Vacía en F1,
 *      schema completo para que F3 sólo agregue endpoints sin migration.
 *      RLS dual: visible a seller_tenant_id O buyer_tenant_id.
 *
 *   3. cross_tenant_operation_items
 *      Items de la operación maestra. Vacía en F1. CASCADE al borrar la op.
 *      Sin RLS propio — se accede siempre via JOIN con operations (cuya RLS
 *      ya filtra), y el contenido per-item no es PII sensible per se.
 *
 *   4. cross_tenant_pagos
 *      Pagos/cobros replicados entre partners. Vacía en F1. RLS dual igual
 *      que operations (resolved via JOIN a la op).
 *
 *   5. cross_tenant_notifications
 *      Inbox del tenant — RLS ESTÁNDAR por tenant_id receptor (no dual).
 *      Cada lado recibe sus propias notifications, no son compartidas.
 *      FORCE RLS estricto, mismo patrón que el resto del portal.
 *
 * Convención de RLS dual:
 *   Tablas con RLS dual NO usan FORCE (necesitamos que adminQuery / tecny_admin
 *   las pueda escribir sin pegarse al WITH CHECK). La defensa real está en el
 *   código del endpoint, que valida partnership activa ANTES de cambiar el
 *   SET LOCAL — ver lib/partnership.js + routes/redB2b/partnerships.js.
 *
 * Predicate fail-closed: NULLIF para evitar el bug pg_strtoint32_safe en
 * conexiones limpias sin SET LOCAL (mismo patrón que migrations recientes).
 *
 * Reversible: down dropea las 5 tablas en orden de dependencia (notifications
 * → pagos → items → operations → partnerships). El catalog entry de la
 * capability `cross_tenant.write` y los enum values de tenant_admin_actions
 * van en migrations separadas (mismo pattern que paid_until + admin actions).
 */

exports.shorthands = undefined;

// Predicate estándar fail-closed (NULLIF para evitar revientes en queries
// sin SET LOCAL — defensa en depth). Sólo aplica a tablas con RLS estándar
// (cross_tenant_notifications). Las tablas con RLS dual usan su propio
// predicate inline.
const PREDICATE_CLOSED = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;

// Predicate DUAL: una fila es visible si current_tenant matchea a tenant_a
// O tenant_b. Usado por tenant_partnerships + cross_tenant_operations. Los
// nombres de columnas cambian por tabla, por eso lo armamos como string
// template.
function dualPredicate(colA, colB) {
  return (
    `${colA} = NULLIF(current_setting('app.current_tenant', true), '')::int OR ` +
    `${colB} = NULLIF(current_setting('app.current_tenant', true), '')::int`
  );
}

exports.up = (pgm) => {
  pgm.sql(`
    -- ─── 1. tenant_partnerships ────────────────────────────────────────────
    -- Vínculo bilateral aceptado. Convención SIEMPRE: tenant_a_id < tenant_b_id
    -- (evita duplicar el mismo vínculo como (A,B) + (B,A)). Los endpoints
    -- ordenan IDs ascendente ANTES de cualquier WHERE — ver lib/partnership.js.
    CREATE TABLE tenant_partnerships (
      id BIGSERIAL PRIMARY KEY,

      tenant_a_id INTEGER NOT NULL REFERENCES tenants(id),
      tenant_b_id INTEGER NOT NULL REFERENCES tenants(id),
      CHECK (tenant_a_id < tenant_b_id),
      UNIQUE (tenant_a_id, tenant_b_id),

      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),

      -- Quién invitó. Guardamos ambos campos (tenant + user) para no
      -- asumir nada (el user pudo dejar de existir post-invite).
      invited_by_tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      invited_by_user_id   INTEGER NOT NULL REFERENCES users(id),
      invited_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      invitation_message   TEXT,

      -- Aceptación (NULL hasta status='active').
      accepted_by_user_id INTEGER REFERENCES users(id),
      accepted_at         TIMESTAMPTZ,

      -- Revocación (NULL hasta status='revoked'). El tenant que revocó queda
      -- registrado para cooldown anti-spam de re-invite (24h, enforced en
      -- el endpoint POST /invite).
      revoked_by_tenant_id INTEGER REFERENCES tenants(id),
      revoked_by_user_id   INTEGER REFERENCES users(id),
      revoked_at           TIMESTAMPTZ,
      revoked_reason       TEXT,

      -- State machine validator: garantiza que los campos correspondan al status.
      CHECK (
        (status = 'pending'  AND accepted_at IS NULL AND revoked_at IS NULL) OR
        (status = 'active'   AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
        (status = 'revoked'  AND revoked_at IS NOT NULL)
      ),

      -- Si el invitador es tenant_a o tenant_b — debe ser uno de los dos.
      CHECK (invited_by_tenant_id IN (tenant_a_id, tenant_b_id)),
      -- Si revoked, el revocador también debe ser uno de los dos.
      CHECK (
        revoked_by_tenant_id IS NULL
        OR revoked_by_tenant_id IN (tenant_a_id, tenant_b_id)
      )
    );

    COMMENT ON TABLE tenant_partnerships IS
      'Vínculo bilateral aceptado entre dos tenants Tecny (Red B2B F1). Convención tenant_a_id < tenant_b_id. RLS dual: visible a ambos tenants involucrados.';

    -- Índices: queries calientes son "mis partnerships activas" (filtradas por
    -- mi tenant, status=active). Partial indexes para sumar solo lo útil.
    CREATE INDEX idx_tenant_partnerships_a_active
      ON tenant_partnerships(tenant_a_id) WHERE status = 'active';
    CREATE INDEX idx_tenant_partnerships_b_active
      ON tenant_partnerships(tenant_b_id) WHERE status = 'active';
    -- Para listar invitaciones pendientes recibidas/enviadas:
    CREATE INDEX idx_tenant_partnerships_invited_for
      ON tenant_partnerships(invited_by_tenant_id, status);
    -- Para el cooldown anti-spam de re-invite: lookup del último revoke
    -- entre los mismos dos tenants. Ordena por revoked_at DESC.
    CREATE INDEX idx_tenant_partnerships_pair_revoked
      ON tenant_partnerships(tenant_a_id, tenant_b_id, revoked_at)
      WHERE status = 'revoked';

    -- RLS DUAL: visible si current_tenant matchea a tenant_a O tenant_b.
    -- NO usamos FORCE porque las escrituras se hacen con tecny_admin
    -- (BYPASSRLS) — pegarle FORCE rechazaría incluso al super-admin de la
    -- plataforma. La defensa real está en el código del endpoint que
    -- valida partnership activa antes de mutar.
    ALTER TABLE tenant_partnerships ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_partnerships_select ON tenant_partnerships
      FOR SELECT TO PUBLIC
      USING (${dualPredicate('tenant_a_id', 'tenant_b_id')});

    -- ─── 2. cross_tenant_operations ────────────────────────────────────────
    -- Maestro de operación cross-tenant. Vacía en F1, schema completo para
    -- que F3 sólo agregue endpoints. RLS dual (seller O buyer).
    CREATE TABLE cross_tenant_operations (
      id BIGSERIAL PRIMARY KEY,
      partnership_id BIGINT NOT NULL REFERENCES tenant_partnerships(id),

      seller_tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      buyer_tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      CHECK (seller_tenant_id <> buyer_tenant_id),

      -- FKs lógicas a ventas/compras del lado correspondiente. No FK física
      -- porque cada tabla está RLS-scoped a su propio tenant — joins
      -- cross-schema complejos no valen la pena. F3 agrega defensive trigger.
      seller_venta_id INTEGER NOT NULL,
      buyer_compra_id INTEGER NOT NULL,

      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'frozen'))
        DEFAULT 'active',

      -- Cache de totales para queries rápidas de conciliación. La verdad
      -- sigue siendo seller_venta + buyer_compra.
      total_usd NUMERIC(14, 2) NOT NULL,
      total_ars NUMERIC(14, 2) NOT NULL,
      tc_used   NUMERIC(10, 4) NOT NULL,

      created_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- Track de última modificación si fue editada (F3+).
      last_modified_by_user_id INTEGER REFERENCES users(id),
      last_modified_at         TIMESTAMPTZ
    );

    COMMENT ON TABLE cross_tenant_operations IS
      'Operación cross-tenant maestra (Red B2B F3). 1 venta cross-tenant = 1 fila. Vacía hasta F3. RLS dual.';

    CREATE INDEX idx_cross_ops_seller
      ON cross_tenant_operations(seller_tenant_id, status, created_at DESC);
    CREATE INDEX idx_cross_ops_buyer
      ON cross_tenant_operations(buyer_tenant_id, status, created_at DESC);
    CREATE INDEX idx_cross_ops_partnership
      ON cross_tenant_operations(partnership_id);

    ALTER TABLE cross_tenant_operations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY cross_ops_select ON cross_tenant_operations
      FOR SELECT TO PUBLIC
      USING (${dualPredicate('seller_tenant_id', 'buyer_tenant_id')});

    -- ─── 3. cross_tenant_operation_items ───────────────────────────────────
    -- Items de la operación. Vacía hasta F3.
    CREATE TABLE cross_tenant_operation_items (
      id BIGSERIAL PRIMARY KEY,
      cross_tenant_operation_id BIGINT NOT NULL
        REFERENCES cross_tenant_operations(id) ON DELETE CASCADE,

      -- Cada item tiene un producto en cada lado (mapeo seller_producto → buyer_producto).
      seller_producto_id INTEGER NOT NULL,
      buyer_producto_id  INTEGER NOT NULL,

      cantidad             INTEGER     NOT NULL CHECK (cantidad > 0),
      precio_unitario_usd  NUMERIC(12, 2) NOT NULL,
      precio_unitario_ars  NUMERIC(14, 2) NOT NULL,

      -- Track de edición de item (F3+).
      original_cantidad             INTEGER,
      original_precio_unitario_usd  NUMERIC(12, 2)
    );

    COMMENT ON TABLE cross_tenant_operation_items IS
      'Items de operación cross-tenant. Sin RLS propio — acceso siempre via JOIN con cross_tenant_operations (cuya RLS filtra).';

    CREATE INDEX idx_cross_op_items_op
      ON cross_tenant_operation_items(cross_tenant_operation_id);

    -- ─── 4. cross_tenant_pagos ─────────────────────────────────────────────
    -- Pagos replicados entre seller y buyer. Vacía hasta F4.
    CREATE TABLE cross_tenant_pagos (
      id BIGSERIAL PRIMARY KEY,
      cross_tenant_operation_id BIGINT NOT NULL
        REFERENCES cross_tenant_operations(id),

      -- FKs lógicas a cobros/pagos del lado correspondiente.
      seller_cobro_id INTEGER NOT NULL,
      buyer_pago_id   INTEGER NOT NULL,

      monto_usd NUMERIC(14, 2) NOT NULL,
      monto_ars NUMERIC(14, 2) NOT NULL,
      tc_used   NUMERIC(10, 4) NOT NULL,

      caja_seller_id INTEGER NOT NULL,
      caja_buyer_id  INTEGER NOT NULL,

      registered_by_side    TEXT NOT NULL CHECK (registered_by_side IN ('seller', 'buyer')),
      registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
      registered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      propagated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    COMMENT ON TABLE cross_tenant_pagos IS
      'Pagos cross-tenant replicados. Sin RLS propio — acceso via JOIN con cross_tenant_operations.';

    CREATE INDEX idx_cross_pagos_op ON cross_tenant_pagos(cross_tenant_operation_id);

    -- ─── 5. cross_tenant_notifications ─────────────────────────────────────
    -- Inbox del tenant. RLS ESTÁNDAR por tenant_id receptor (no dual) — cada
    -- lado recibe sus propias notifs. FORCE RLS estricto (mismo patrón que
    -- el resto del portal).
    CREATE TABLE cross_tenant_notifications (
      id BIGSERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),  -- receptor

      partnership_id            BIGINT REFERENCES tenant_partnerships(id),
      cross_tenant_operation_id BIGINT REFERENCES cross_tenant_operations(id),

      type TEXT NOT NULL CHECK (type IN (
        'invitation_received',
        'invitation_accepted',
        'invitation_rejected',
        'partnership_revoked',
        'operation_received',
        'operation_modified',
        'operation_cancelled',
        'payment_received',
        'payment_registered',
        'product_pending_review'
      )),

      -- Snapshot para renderizar la notif sin depender de joins en runtime
      -- (que podrían cambiar — ej. tenant rename, partnership revocada).
      payload JSONB NOT NULL,

      read_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    COMMENT ON TABLE cross_tenant_notifications IS
      'Inbox cross-tenant. Una fila por (notification, receptor tenant). RLS estándar por tenant_id receptor.';

    CREATE INDEX idx_cross_notif_unread
      ON cross_tenant_notifications(tenant_id, read_at)
      WHERE read_at IS NULL;
    CREATE INDEX idx_cross_notif_recent
      ON cross_tenant_notifications(tenant_id, created_at DESC);

    ALTER TABLE cross_tenant_notifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cross_tenant_notifications FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cross_tenant_notifications
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});

    -- ─── 6. ALTER contactos: linked_tenant_id ─────────────────────────────
    -- F1 accept ya crea/linkea contactos en ambos lados apuntando al tenant
    -- partner. La columna debe existir desde F1 — sin ella, el INSERT del
    -- accept fallaría. Originalmente el diseño la metía en F3, pero el
    -- accept de F1 ya necesita escribirla (sin esto el partner queda como
    -- contacto "fantasma" sin link al tenant real, perdiendo trazabilidad).
    --
    -- Decisión: la columna se agrega en F1; F3 sigue siendo el dueño de la
    -- semántica completa (las operations referencian estos contactos). Si
    -- F1 deploya sola y F3 nunca llega, la columna queda como metadata
    -- opcional que no rompe nada — todas las queries existentes la ignoran.
    ALTER TABLE contactos ADD COLUMN IF NOT EXISTS linked_tenant_id INTEGER REFERENCES tenants(id);

    CREATE INDEX IF NOT EXISTS idx_contactos_linked_tenant
      ON contactos(tenant_id, linked_tenant_id)
      WHERE linked_tenant_id IS NOT NULL;

    -- ─── 7. Capability cross_tenant.write ──────────────────────────────────
    -- Se agrega al catálogo. Default OFF — el owner del tenant la activa
    -- por vendedor desde Usuarios. orden = 2000 para que aparezca al final
    -- del listado (no choca con los ordenes existentes 101-1900).
    INSERT INTO capability_catalog (slug, pantalla, pantalla_label, capability, capability_label, orden)
    VALUES (
      'cross_tenant.write',
      'red_b2b',
      'Red B2B',
      'write',
      'Crear y gestionar partnerships Red B2B',
      2000
    )
    ON CONFLICT (slug) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Cleanup capability primero (FK al catálogo desde user_capabilities
    -- tiene ON DELETE CASCADE — se limpia automático).
    DELETE FROM capability_catalog WHERE slug = 'cross_tenant.write';

    -- Drop en orden inverso de dependencia.
    DROP TABLE IF EXISTS cross_tenant_notifications;
    DROP TABLE IF EXISTS cross_tenant_pagos;
    DROP TABLE IF EXISTS cross_tenant_operation_items;
    DROP TABLE IF EXISTS cross_tenant_operations;
    DROP TABLE IF EXISTS tenant_partnerships;

    DROP INDEX IF EXISTS idx_contactos_linked_tenant;
    ALTER TABLE contactos DROP COLUMN IF EXISTS linked_tenant_id;
  `);
};
