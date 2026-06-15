/* eslint-disable camelcase */
/**
 * Migración — PR 1 del proyecto multi-tenant (iPro SaaS).
 *
 * Objetivo: agregar el concepto de "tenant" (cliente del SaaS) al schema
 * existente sin romper ningún comportamiento actual. Tras esta migración:
 *
 *   - Existe la tabla `tenants` con el cliente original (id=1, "iPro Original").
 *   - Existe la tabla `tenant_users` que vincula users con tenants (un user
 *     puede pertenecer a varios tenants — escalable hacia equipos cross-org).
 *   - Cada tabla de negocio tiene `tenant_id NOT NULL REFERENCES tenants(id)`,
 *     todas las filas existentes backfilleadas con `tenant_id = 1`.
 *   - Indexes compuestos `(tenant_id, ...)` en las tablas hot para que las
 *     queries futuras filtradas por tenant sean rápidas.
 *
 * Lo que esta migración NO hace (queda para PRs siguientes):
 *   - Row-Level Security (RLS) — viene en PR 2.
 *   - Middleware que setea `app.current_tenant` por request — PR 3.
 *   - Refactor de endpoints existentes — PR 4 (modular).
 *   - Aislamiento de archivos en R2 por tenant — PR 5.
 *
 * Backward compatibility: TOTAL. El código actual sigue funcionando ignorando
 * `tenant_id`. Postgres acepta INSERTs sin tenant_id si la columna tiene
 * DEFAULT 1 (lo cual NO hacemos a propósito — queremos que los nuevos
 * endpoints SIEMPRE especifiquen tenant_id explícitamente, y los viejos
 * los iremos refactorando en PR 4 con el helper de session).
 *
 *   → ¿Por qué NOT NULL CON DEFAULT 1 entonces?
 *     Backward compat durante la transición (PR 1 → PR 4). Los endpoints
 *     existentes hacen INSERTs sin tenant_id; con DEFAULT 1 esos INSERTs
 *     siguen funcionando exactamente igual (van a tenant 1 = iPro Original).
 *     Cuando refactoremos los endpoints en PR 4 para setear tenant_id
 *     explícito en cada INSERT, una migration futura eliminará los DEFAULTs
 *     y forzará especificación explícita (cero ambigüedad para multi-tenant
 *     real). Hasta entonces, el DEFAULT garantiza que el portal de Lucas
 *     sigue funcionando exactamente igual.
 *
 * Caso especial: `audit_logs` (particionado por mes desde P-19, 2026-06-10):
 *   Agregamos `tenant_id INTEGER` (NULLABLE) — modificar una tabla particionada
 *   requiere cuidado y NOT NULL en todas las particiones existentes es costoso.
 *   Lo dejamos nullable; el handler `audit()` lo seteará en cada insert nuevo.
 *   Backfill: todos los logs históricos quedan asignados a tenant 1.
 *   Cuando volvamos a esta tabla (post-Fase-1), evaluamos sub-particionado por
 *   hash(tenant_id) — ver comentario en migración 20260611000004.
 *
 * Performance estimada del backfill:
 *   ~45 tablas × UPDATE de N filas. La base actual tiene ~50k filas total
 *   distribuidas. ALTER TABLE ... ADD COLUMN INTEGER es instant (Postgres 11+).
 *   UPDATE de 50k filas es ~10s en total. ALTER ... SET NOT NULL revalida
 *   (otros ~5s). Total esperado: <30s. Operación segura para deploy normal.
 */

exports.shorthands = undefined;

// ─── Lista canónica de tablas que llevan tenant_id NOT NULL ──────────────────
// Mantener ordenada por módulo para revisión humana. Si se agrega una tabla
// nueva al schema, evaluá si pertenece a esta lista — la regla es:
//   - ¿Es data del NEGOCIO (no del sistema)? → SÍ va acá.
//   - ¿Pertenece a un cliente específico? → SÍ va acá.
//   - ¿Es global (users, rate limits, sistema)? → NO.
const TABLAS_NEGOCIO = [
  // Ventas (retail + B2B legacy)
  'ventas', 'venta_items', 'venta_pagos', 'venta_comprobantes', 'ventas_rapidas', 'pagos',
  // Inventario (incluye catálogo de usados — feature canjes)
  'productos', 'categorias', 'depositos', 'vendedores', 'canjes', 'catalogo_usados',
  // Contactos & etiquetas
  'contactos', 'etiquetas',
  // B2B Cuentas Corrientes
  'clientes_cc', 'movimientos_cc', 'items_movimiento_cc',
  // Proveedores
  'proveedores', 'proveedor_movimientos', 'proveedor_movimiento_items',
  // Cajas
  'metodos_pago', 'caja_movimientos', 'movimientos_deudas', 'movimientos_inversiones',
  // Cambios de divisa
  'cambio_entidades', 'cambio_movimientos',
  // Tarjetas (entidades/planes fueron dropeadas en 20260530000002, ahora viven en metodos_pago)
  'tarjeta_movimientos',
  // Financiera
  'comprobantes',
  // Envíos
  'envios', 'envio_items',
  // Egresos
  'egresos', 'egreso_categorias', 'egresos_recurrentes',
  // Proyectos
  'proyectos', 'proyecto_participantes', 'proyecto_movimientos',
  // Operacional / config por tenant
  'alertas_config', 'conciliaciones', 'conciliacion_lineas',
  'plantillas_garantia', 'user_permissions',
  // Nota: `historial` fue dropeada en una migration posterior; reemplazada por audit_logs.
  // `tarjeta_entidades` / `tarjeta_planes` también fueron dropeadas (su lógica ahora vive en metodos_pago).
  // Tablas de sistema que NO llevan tenant_id: users, rate_limit_entries, audit_queue,
  // feature_flags, user_2fa, pgmigrations, tenants, tenant_users.
];

// Indexes compuestos `(tenant_id, ...)` para queries hot. Por tabla, definimos
// los indexes adicionales que tiene sentido pre-crear ahora (en lugar de
// agregarlos uno por uno en PRs futuras). Solo cubrimos lo crítico — más
// indexes pueden agregarse después si una query específica lo necesita.
const INDEXES_HOT = {
  ventas:           ['(tenant_id, fecha DESC) WHERE deleted_at IS NULL'],
  venta_items:      ['(tenant_id, venta_id)'],
  productos:        ['(tenant_id, deleted_at) WHERE deleted_at IS NULL'],
  movimientos_cc:   ['(tenant_id, cliente_cc_id, fecha DESC) WHERE deleted_at IS NULL'],
  proveedor_movimientos: ['(tenant_id, proveedor_id, fecha DESC) WHERE deleted_at IS NULL'],
  caja_movimientos: ['(tenant_id, caja_id, fecha DESC)'],
  tarjeta_movimientos: ['(tenant_id, metodo_pago_id, fecha DESC) WHERE deleted_at IS NULL'],
  envios:           ['(tenant_id, fecha DESC) WHERE deleted_at IS NULL'],
  egresos:          ['(tenant_id, fecha DESC) WHERE deleted_at IS NULL'],
  contactos:        ['(tenant_id, deleted_at) WHERE deleted_at IS NULL'],
  clientes_cc:      ['(tenant_id, deleted_at) WHERE deleted_at IS NULL'],
  proveedores:      ['(tenant_id, deleted_at) WHERE deleted_at IS NULL'],
};

exports.up = (pgm) => {
  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 1. CREAR TABLAS NUEVAS: tenants + tenant_users
    -- ────────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS tenants (
      id          SERIAL PRIMARY KEY,
      nombre      TEXT          NOT NULL,
      slug        TEXT          NOT NULL UNIQUE
                    CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$' AND char_length(slug) BETWEEN 2 AND 40),
      plan        TEXT          NOT NULL DEFAULT 'trial'
                    CHECK (plan IN ('trial', 'starter', 'pro', 'enterprise')),
      deleted_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX idx_tenants_active ON tenants (id) WHERE deleted_at IS NULL;
    CREATE INDEX idx_tenants_slug ON tenants (slug) WHERE deleted_at IS NULL;

    -- tenant_users: relación many-to-many entre users y tenants.
    --   - Un user puede pertenecer a 1 o más tenants (caso futuro: equipos
    --     que trabajan para varios clientes; super-admin que necesita ver
    --     varios tenants).
    --   - El rol es POR-tenant, no global. Un user puede ser "owner" en
    --     tenant A y "member" en tenant B.
    CREATE TABLE IF NOT EXISTS tenant_users (
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      rol        TEXT    NOT NULL DEFAULT 'member'
                   CHECK (rol IN ('owner', 'admin', 'member')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, user_id)
    );

    CREATE INDEX idx_tenant_users_user ON tenant_users (user_id);

    -- ────────────────────────────────────────────────────────────────────────
    -- 2. INSERTAR EL TENANT ORIGINAL (id=1, datos actuales de Lucas/iPro)
    -- ────────────────────────────────────────────────────────────────────────

    INSERT INTO tenants (id, nombre, slug, plan)
    VALUES (1, 'iPro Original', 'ipro', 'enterprise')
    ON CONFLICT (id) DO NOTHING;

    -- Setear la secuencia para que el próximo tenant tenga id=2
    SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1));

    -- Vincular TODOS los users existentes al tenant 1.
    -- Estrategia de rol:
    --   - El user con menor id (Lucas, históricamente) → 'owner'.
    --   - Resto de admins → 'admin'.
    --   - Resto → 'member'.
    INSERT INTO tenant_users (tenant_id, user_id, rol)
    SELECT
      1,
      u.id,
      CASE
        WHEN u.id = (SELECT MIN(id) FROM users WHERE deleted_at IS NULL) THEN 'owner'
        WHEN u.role = 'admin' THEN 'admin'
        ELSE 'member'
      END
    FROM users u
    WHERE u.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  `);

  // ──────────────────────────────────────────────────────────────────────────
  // 3. AGREGAR tenant_id A TODAS LAS TABLAS DE NEGOCIO
  //    Patrón en 3 pasos por tabla:
  //      a) ADD COLUMN tenant_id INTEGER (nullable temporalmente)
  //      b) Backfill UPDATE ... SET tenant_id = 1
  //      c) Add FK + NOT NULL + lockdown
  //    Usamos pgm.sql con cada tabla para que el error sea localizable.
  // ──────────────────────────────────────────────────────────────────────────
  for (const tabla of TABLAS_NEGOCIO) {
    pgm.sql(`
      -- ── ${tabla} ──
      -- DEFAULT 1 mantiene backward compat: INSERTs existentes sin tenant_id
      -- van automáticamente al tenant 1 (Lucas). Se eliminará en una migration
      -- futura post-refactor de endpoints (PR 4).
      ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1;
      UPDATE ${tabla} SET tenant_id = 1 WHERE tenant_id IS NULL;
      ALTER TABLE ${tabla} ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE ${tabla} ADD CONSTRAINT ${tabla}_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. CASO ESPECIAL: `audit_logs` (particionado por mes desde P-19).
  //    Agregamos tenant_id NULLABLE — postgres permite ALTER en parent table
  //    y lo propaga a las partitions. NULLABLE porque hacer NOT NULL en una
  //    tabla particionada con muchas particiones es costoso, y el código del
  //    handler `audit()` empezará a setear tenant_id en PR 3.
  //    El singleton `config` también tiene caso especial — su CHECK (id=1)
  //    impide tener 1-row-por-tenant; lo soltamos.
  // ──────────────────────────────────────────────────────────────────────────
  pgm.sql(`
    -- ── audit_logs (NULLABLE temporalmente) ──
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL;
    UPDATE audit_logs SET tenant_id = 1 WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;

    -- ── config (drop CHECK single_row, pasa a ser 1 row por tenant) ──
    ALTER TABLE config DROP CONSTRAINT IF EXISTS single_row;
    ALTER TABLE config ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1;
    UPDATE config SET tenant_id = 1 WHERE tenant_id IS NULL;
    ALTER TABLE config ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE config ADD CONSTRAINT config_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    -- La PK actual es (id) con default 1. Para multi-tenant: 1 row por tenant
    -- con PK compuesta (id, tenant_id). Cambio defensivo: agregamos UNIQUE
    -- (tenant_id, id) y mantenemos id como PK (un solo config por tenant
    -- usará id=1 siempre — convención).
    ALTER TABLE config DROP CONSTRAINT IF EXISTS config_pkey;
    ALTER TABLE config ADD PRIMARY KEY (tenant_id, id);
  `);

  // ──────────────────────────────────────────────────────────────────────────
  // 5. INDEXES COMPUESTOS EN TABLAS HOT
  //    Pre-crear estos índices ahora ahorra latency en queries futuras y
  //    evita tener que pelearnos con planner adaptations cuando agreguemos
  //    los WHERE tenant_id = $1 en los endpoints (PR 4).
  // ──────────────────────────────────────────────────────────────────────────
  for (const [tabla, defs] of Object.entries(INDEXES_HOT)) {
    for (const def of defs) {
      const safeName = `idx_${tabla}_tenant_${def.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}`;
      pgm.sql(`CREATE INDEX IF NOT EXISTS ${safeName} ON ${tabla} ${def};`);
    }
  }
};

exports.down = (pgm) => {
  // El down() revierte en orden inverso al up().
  // Nota: si después del up() se crearon tenants > 1 con sus propios datos,
  // el down() los va a perder (UPDATE tenant_id = 1 los unifica). El down está
  // pensado solo para revertir si la migración up falló o si en dev queremos
  // empezar de cero — NO para usar en prod después de que entren tenants.

  // 1. Drop indexes hot
  for (const [tabla, defs] of Object.entries(INDEXES_HOT)) {
    for (const def of defs) {
      const safeName = `idx_${tabla}_tenant_${def.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}`;
      pgm.sql(`DROP INDEX IF EXISTS ${safeName};`);
    }
  }

  // 2. Revertir caso especial config (restaurar singleton)
  pgm.sql(`
    ALTER TABLE config DROP CONSTRAINT IF EXISTS config_pkey;
    ALTER TABLE config DROP CONSTRAINT IF EXISTS config_tenant_id_fkey;
    ALTER TABLE config DROP COLUMN IF EXISTS tenant_id;
    ALTER TABLE config ADD PRIMARY KEY (id);
    ALTER TABLE config ADD CONSTRAINT single_row CHECK (id = 1);
  `);

  // 3. Revertir audit_logs
  pgm.sql(`
    DROP INDEX IF EXISTS idx_audit_logs_tenant;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS tenant_id;
  `);

  // 4. Drop tenant_id de cada tabla de negocio
  for (const tabla of TABLAS_NEGOCIO) {
    pgm.sql(`
      ALTER TABLE ${tabla} DROP CONSTRAINT IF EXISTS ${tabla}_tenant_id_fkey;
      ALTER TABLE ${tabla} DROP COLUMN IF EXISTS tenant_id;
    `);
  }

  // 5. Drop tablas nuevas
  pgm.sql(`
    DROP TABLE IF EXISTS tenant_users;
    DROP TABLE IF EXISTS tenants;
  `);
};
