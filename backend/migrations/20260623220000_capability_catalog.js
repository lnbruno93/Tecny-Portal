/**
 * Migration: capability catalog + tenant roles + user capability overrides
 * (Fase F1 — Permisos granulares por capability).
 *
 * Decidido con Lucas 2026-06-23. Reemplazo del sistema flat de
 * `user_permissions(user_id, tool, enabled)` (14 booleans por user) por un
 * modelo capability-based con role base + overrides:
 *
 *   - 45 capabilities específicas del producto (no CRUD genérico) repartidas
 *     en 19 pantallas. Ejemplos: 'inventario.ver', 'inventario.ver_costos',
 *     'ventas.eliminar', 'cajas.conciliacion', 'b2b.cobranza_masiva'.
 *
 *   - Cada user del tenant tiene un `rol` base (owner | admin | vendedor |
 *     encargado | lectura | custom) que define un set default de
 *     capabilities. El owner del tenant puede overridear individualmente
 *     cualquier capability (set true para extender, false para retirar)
 *     desde la nueva pantalla de Usuarios (F2).
 *
 *   - JWT incluye las capabilities efectivas como `caps` claim → middleware
 *     `requireCapability` resuelve sin DB en el happy path (mismo pattern
 *     que `perms` actual). En F4 se hace el cutover: refactor de routes
 *     de requirePermission a requireCapability + remoción del sistema viejo.
 *
 * Coexistencia con el sistema actual (F1 = shadow mode):
 *
 *   Esta migration NO toca `user_permissions` ni ninguna route existente.
 *   Las 3 tablas nuevas viven al lado del sistema viejo. F2 agrega la UI
 *   nueva (puede leer ambos sistemas para mostrar el estado actual al
 *   owner). F3 refactorea routes. F4 hace el cutover final y dropea
 *   `user_permissions`.
 *
 * Schema (3 tablas):
 *
 *   1. `capability_catalog` — global (no tenant_id, sin RLS). Read-only
 *      seed con las 45 capabilities. Slug formato 'pantalla.capability'
 *      (ej. 'ventas.eliminar'). El frontend lo lee 1× para armar la UI.
 *      Cambios a este catálogo son schema changes (otra migration).
 *
 *   2. `tenant_user_roles` — rol base por (tenant_id, user_id). 1 fila
 *      por user/tenant. PK compuesta. CHECK constraint sobre rol con
 *      enum cerrado. RLS estricto (FORCE).
 *
 *   3. `user_capabilities` — overrides explícitos por (tenant_id, user_id,
 *      capability_slug). Cada fila es un override: enabled=true extiende
 *      el rol, enabled=false retira. Si no hay fila, vale lo que dicta el
 *      rol. PK compuesta + FK a capability_catalog. RLS estricto.
 *
 * Seed inicial (backfill para coexistencia):
 *
 *   - capability_catalog: 45 filas (las 45 capabilities, ver bloque
 *     CAPABILITIES más abajo).
 *
 *   - tenant_user_roles: 1 fila por (tenant_id, user_id) presente en
 *     `tenant_users`. Rol asignado:
 *       · users.role = 'admin' (global) → tenant_user_roles.rol = 'admin'
 *       · resto                         → tenant_user_roles.rol = 'custom'
 *     Custom carga 0 capabilities por default — el set efectivo viene
 *     SOLO de user_capabilities. Eso replica exactamente el flat
 *     user_permissions actual (los users empiezan sin permisos y el
 *     owner los va dando uno por uno).
 *
 *   - user_capabilities: para cada fila enabled=true en user_permissions
 *     legacy, inserto las capabilities que correspondan según el mapping
 *     PERM_TO_CAPS (ver bloque más abajo). De esta forma F4 puede flipear
 *     el middleware sin behavior change.
 *
 *   Idempotencia: ON CONFLICT DO NOTHING en todos los INSERTS del seed.
 *
 * RLS:
 *   Mismo patrón fail-closed que el resto del portal (predicate sin
 *   fallback NULL — TANDA 0c #294). USA NULLIF para evitar el bug
 *   pg_strtoint32_safe (#310, fix 20260618000001) en caso que algún
 *   handler nuevo olvide withTenant — defensa en depth.
 *
 * Reversible: down dropea las 3 tablas + función trigger. No hay datos
 * irreemplazables (la fuente de verdad de F1 sigue siendo
 * `user_permissions` hasta F4).
 */

exports.shorthands = undefined;

// ─── Catálogo canónico de capabilities (45) ────────────────────────────────
// Fuente de verdad: PermisosPreview.jsx (visual mockup) — ambos archivos
// DEBEN mantener el mismo set. Cuando se agregue/saque una capability:
//   1. Update PANTALLAS en frontend/src/screens/Usuarios.jsx (F2) o
//      lib/capabilityCatalog.js (backend).
//   2. Otra migration up agrega INSERT al capability_catalog.
//   3. Si la capability afecta el rol vendedor/encargado/lectura, update
//      backend/src/lib/roleDefaults.js y bumpear password_changed_at de
//      todos los users de esos roles para refrescar JWT.
const CAPABILITIES = [
  { pantalla: 'inicio', label: 'Inicio', items: [
    { id: 'actividad_reciente', label: 'Ver actividad reciente' },
  ]},
  { pantalla: 'resumen', label: 'Resumen del mes', items: [
    { id: 'ver', label: 'Ver Resumen del mes' },
  ]},
  { pantalla: 'ventas', label: 'Ventas', items: [
    { id: 'trabajar', label: 'Acceder al módulo' },
    { id: 'eliminar', label: 'Eliminar una venta' },
    { id: 'exportar', label: 'Exportar ventas' },
  ]},
  { pantalla: 'b2b', label: 'Venta & Gestión B2B', items: [
    { id: 'trabajar',        label: 'Acceder al módulo' },
    { id: 'cobranza_masiva', label: 'Hacer cobranza masiva' },
  ]},
  { pantalla: 'contactos', label: 'Contactos', items: [
    { id: 'ver',          label: 'Ver lista de contactos' },
    { id: 'crear_borrar', label: 'Agregar / eliminar contactos' },
  ]},
  { pantalla: 'cajas', label: 'Cajas', items: [
    { id: 'ver',             label: 'Ver cajas' },
    { id: 'crear',           label: 'Agregar caja' },
    { id: 'ver_deudas',      label: 'Ver deudas a cobrar' },
    { id: 'ver_inversiones', label: 'Ver inversiones' },
    { id: 'ver_360_capital', label: 'Ver 360 & Capital' },
    { id: 'conciliacion',    label: 'Conciliación bancaria' },
  ]},
  { pantalla: 'egresos', label: 'Egresos', items: [
    { id: 'ver',    label: 'Ver egresos' },
    { id: 'cargar', label: 'Cargar egresos' },
  ]},
  { pantalla: 'sanidad', label: 'Sanidad del Negocio', items: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { pantalla: 'inventario', label: 'Inventario', items: [
    { id: 'ver',             label: 'Ver inventario (sin costos)' },
    { id: 'ver_costos',      label: 'Ver costos de inventario' },
    { id: 'ver_movimientos', label: 'Ver variaciones de stock' },
    { id: 'ver_compras',     label: 'Ver columna de compras' },
    { id: 'exportar',        label: 'Exportar inventario' },
    { id: 'importar',        label: 'Importar inventario (XLSX)' },
    { id: 'vaciar_stock',    label: 'Vaciar stock disponible' },
  ]},
  { pantalla: 'proveedores', label: 'Proveedores | Compras', items: [
    { id: 'trabajar',        label: 'Acceder al módulo' },
    { id: 'eliminar_compra', label: 'Eliminar una compra' },
  ]},
  { pantalla: 'tarjetas', label: 'Tarjetas de Crédito', items: [
    { id: 'trabajar',     label: 'Acceder al módulo' },
    { id: 'cobro_previo', label: 'Cargar cobro previo' },
  ]},
  { pantalla: 'cambios', label: 'Cambios de Divisa', items: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { pantalla: 'financiera', label: 'Transferencias', items: [
    { id: 'trabajar',     label: 'Acceder al módulo' },
    { id: 'cobro_previo', label: 'Cargar cobro previo' },
  ]},
  { pantalla: 'cotizador', label: 'Cotizador', items: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { pantalla: 'usados', label: 'Usados y Cotizador', items: [
    { id: 'ver',            label: 'Ver el catálogo de usados' },
    { id: 'agregar_equipo', label: 'Agregar un equipo usado' },
    { id: 'exportar',       label: 'Exportar el catálogo' },
  ]},
  { pantalla: 'envios', label: 'Envíos', items: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { pantalla: 'proyectos', label: 'Proyectos', items: [
    { id: 'trabajar',                label: 'Acceder al módulo (ver/crear/editar)' },
    { id: 'eliminar',                label: 'Eliminar un proyecto' },
    { id: 'ver_costos',              label: 'Ver columna de costos' },
    { id: 'gestionar_participantes', label: 'Asignar / quitar participantes' },
  ]},
  { pantalla: 'historial', label: 'Historial', items: [
    { id: 'ver', label: 'Ver historial / auditoría' },
  ]},
  { pantalla: 'config', label: 'Configuración', items: [
    { id: 'general',       label: 'Tab General (comisiones, métodos de pago)' },
    { id: 'alertas',       label: 'Tab Alertas (configuración de alertas del tenant)' },
    { id: 'mantenimiento', label: 'Tab Mantenimiento (backfills, diagnóstico)' },
  ]},
];

// ─── Mapping de user_permissions (legacy) → capability slugs ───────────────
// Para backfill. Cada tool antiguo (14 boolean flags) se expande a las
// capabilities equivalentes en el catálogo nuevo. Pensado para preservar
// behavior tras el cutover F4 — quien tenía `enabled=true` en `cajas`
// arranca con TODAS las capabilities de Cajas + las "agregadas" históricamente
// (egresos.ver, sanidad.trabajar — ambas estaban gateadas por cajas).
//
// Notas:
//   - 'usuarios' (gestión de users) → no se mapea. Esa función va a
//     pertenecer al rol owner/admin del tenant en el sistema nuevo
//     (botón en la pantalla Usuarios — visible solo si role in (owner, admin)).
//   - inicio.actividad_reciente, resumen.ver, historial.ver, config.* —
//     no estaban gateadas en el sistema viejo (visibles para admin global
//     o por flag implícito). Quedan fuera del backfill; el owner del
//     tenant las habilita post-cutover desde la UI nueva.
const PERM_TO_CAPS = {
  cotizador:   ['cotizador.trabajar'],
  financiera:  ['financiera.trabajar', 'financiera.cobro_previo'],
  cajas:       [
    'cajas.ver', 'cajas.crear', 'cajas.ver_deudas', 'cajas.ver_inversiones',
    'cajas.ver_360_capital', 'cajas.conciliacion',
    // Históricamente todo lo de plata estaba detrás del flag 'cajas':
    'egresos.ver', 'egresos.cargar', 'sanidad.trabajar',
  ],
  envios:      ['envios.trabajar'],
  usuarios:    [], // gestionado por rol (owner/admin) en el sistema nuevo
  cuentas:     ['b2b.trabajar', 'b2b.cobranza_masiva'],
  usados:      ['usados.ver', 'usados.agregar_equipo', 'usados.exportar'],
  inventario:  [
    'inventario.ver', 'inventario.ver_costos', 'inventario.ver_movimientos',
    'inventario.ver_compras', 'inventario.exportar', 'inventario.importar',
    'inventario.vaciar_stock',
  ],
  ventas:      ['ventas.trabajar', 'ventas.eliminar', 'ventas.exportar'],
  proveedores: ['proveedores.trabajar', 'proveedores.eliminar_compra'],
  proyectos:   [
    'proyectos.trabajar', 'proyectos.eliminar',
    'proyectos.ver_costos', 'proyectos.gestionar_participantes',
  ],
  contactos:   ['contactos.ver', 'contactos.crear_borrar'],
  cambios:     ['cambios.trabajar'],
  tarjetas:    ['tarjetas.trabajar', 'tarjetas.cobro_previo'],
};

// ─── SQL generation helpers ────────────────────────────────────────────────
function sqlEscapeStr(s) {
  return s.replace(/'/g, "''");
}

function buildCatalogInsertValues() {
  const rows = [];
  let ordenPantalla = 0;
  for (const p of CAPABILITIES) {
    ordenPantalla += 1;
    let ordenCap = 0;
    for (const c of p.items) {
      ordenCap += 1;
      const slug = `${p.pantalla}.${c.id}`;
      const orden = ordenPantalla * 100 + ordenCap; // 101, 102, ..., 201, 202, ...
      rows.push(
        `('${sqlEscapeStr(slug)}', '${sqlEscapeStr(p.pantalla)}', '${sqlEscapeStr(p.label)}', ` +
        `'${sqlEscapeStr(c.id)}', '${sqlEscapeStr(c.label)}', ${orden})`
      );
    }
  }
  return rows.join(',\n      ');
}

// Predicate fail-closed CON NULLIF (mismo patrón que la fix 20260618000001).
// Sin esto, una query sin SET LOCAL revienta con pg_strtoint32_safe en lugar
// de devolver 0 rows. Defensa en depth: todas las queries de F1 corren
// dentro de withTenant, pero un olvido futuro no debe tirar 500.
const PREDICATE_CLOSED = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;

exports.up = (pgm) => {
  const catalogValues = buildCatalogInsertValues();

  pgm.sql(`
    -- ─── 1. capability_catalog ───────────────────────────────────────────
    -- Tabla global (sin tenant_id, sin RLS). Read-only en runtime: solo
    -- migrations la modifican. Lectura libre para todos los roles del
    -- portal — el frontend la fetchea 1× al cargar Usuarios y la cachea.
    CREATE TABLE capability_catalog (
      slug             VARCHAR(80)  PRIMARY KEY,
      pantalla         VARCHAR(40)  NOT NULL,
      pantalla_label   VARCHAR(80)  NOT NULL,
      capability       VARCHAR(40)  NOT NULL,
      capability_label VARCHAR(120) NOT NULL,
      orden            INTEGER      NOT NULL,
      UNIQUE (pantalla, capability)
    );

    COMMENT ON TABLE capability_catalog IS
      'Catálogo global de capabilities del portal (45 inicialmente). Slug formato pantalla.capability (ej. ventas.eliminar). Read-only en runtime — cambios via migrations.';

    -- Seed: 45 capabilities (ver bloque CAPABILITIES en el archivo migration).
    INSERT INTO capability_catalog (slug, pantalla, pantalla_label, capability, capability_label, orden) VALUES
      ${catalogValues}
    ON CONFLICT (slug) DO NOTHING;

    -- ─── 2. tenant_user_roles ────────────────────────────────────────────
    -- Rol base por (tenant_id, user_id). 1 fila por user/tenant.
    -- 'owner'    = dueño del tenant — bypass total (admin del tenant).
    -- 'admin'    = acceso total operativo, no gestiona usuarios/suscripción.
    -- 'vendedor' = ventas + contactos + inventario sin costos.
    -- 'encargado'= vendedor + cajas (read-only) + proyectos.
    -- 'lectura'  = solo lectura para auditor/contador externo.
    -- 'custom'   = sin defaults — el rol no carga capabilities, las maneja
    --              el owner del tenant uno por uno desde user_capabilities.
    --              Es la opción "compatible con sistema viejo": un user
    --              custom con overrides explícitos = el modelo flat actual.
    CREATE TABLE tenant_user_roles (
      tenant_id  INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id    INTEGER     NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      rol        VARCHAR(20) NOT NULL
                 CHECK (rol IN ('owner', 'admin', 'vendedor', 'encargado', 'lectura', 'custom')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, user_id)
    );

    COMMENT ON TABLE tenant_user_roles IS
      'Rol base de cada user en cada tenant. Define el set default de capabilities. Overrides van en user_capabilities.';

    -- Trigger updated_at (mismo pattern que proyecciones_mensuales).
    CREATE OR REPLACE FUNCTION trg_tenant_user_roles_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    CREATE TRIGGER tenant_user_roles_set_updated_at
      BEFORE UPDATE ON tenant_user_roles
      FOR EACH ROW EXECUTE FUNCTION trg_tenant_user_roles_updated_at();

    -- RLS estricto (FORCE, fail-closed). El predicate usa NULLIF para
    -- compatibility con queries en conexiones limpias (no revienta, devuelve
    -- 0 rows) — defensa en depth ante olvidos de withTenant en F2/F3/F4.
    ALTER TABLE tenant_user_roles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_user_roles FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON tenant_user_roles
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});

    -- ─── 3. user_capabilities ────────────────────────────────────────────
    -- Overrides explícitos por (tenant_id, user_id, capability_slug).
    -- enabled=true  → fuerza la capability ON (incluso si el rol no la da).
    -- enabled=false → fuerza la capability OFF (incluso si el rol la da).
    -- Sin fila → vale el default del rol.
    --
    -- FK a capability_catalog garantiza integridad: no se puede insertar
    -- un override sobre un slug inexistente. ON DELETE CASCADE en
    -- capability_catalog → si una migration futura saca una capability,
    -- los overrides asociados desaparecen automáticamente.
    CREATE TABLE user_capabilities (
      tenant_id       INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id         INTEGER     NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      capability_slug VARCHAR(80) NOT NULL REFERENCES capability_catalog(slug) ON DELETE CASCADE,
      enabled         BOOLEAN     NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, user_id, capability_slug)
    );

    COMMENT ON TABLE user_capabilities IS
      'Overrides granulares por (tenant_id, user_id, capability_slug). Sin fila = default del rol. Con fila = forzar ON/OFF.';

    -- Índice secundario para listar overrides por user (las queries del
    -- endpoint GET /api/capabilities/users hacen WHERE user_id IN (...)).
    CREATE INDEX idx_user_capabilities_tenant_user
      ON user_capabilities(tenant_id, user_id);

    -- RLS estricto fail-closed, mismo predicate que tenant_user_roles.
    ALTER TABLE user_capabilities ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_capabilities FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON user_capabilities
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});

    -- ─── 4. Backfill: tenant_user_roles ──────────────────────────────────
    -- Para cada fila (tenant_id, user_id) en tenant_users, seedeamos rol:
    --   · users.role = 'admin' (global) → 'admin' (acceso operativo total)
    --   · resto                         → 'custom' (replica el comportamiento
    --     del sistema viejo: arranca sin capabilities, el owner las da)
    --
    -- IMPORTANTE: este backfill corre dentro del scope RLS de cada tenant
    -- (set_config) porque tenant_user_roles tiene FORCE RLS — el INSERT
    -- necesita el tenant context para pasar el WITH CHECK.
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT tu.tenant_id, tu.user_id, u.role AS user_role
          FROM tenant_users tu
          JOIN users u ON u.id = tu.user_id
         WHERE u.deleted_at IS NULL
      LOOP
        PERFORM set_config('app.current_tenant', r.tenant_id::text, true);
        INSERT INTO tenant_user_roles (tenant_id, user_id, rol)
        VALUES (
          r.tenant_id,
          r.user_id,
          CASE WHEN r.user_role = 'admin' THEN 'admin' ELSE 'custom' END
        )
        ON CONFLICT (tenant_id, user_id) DO NOTHING;
      END LOOP;
    END $$;

    -- ─── 5. Backfill: user_capabilities desde user_permissions ───────────
    -- Map flat tools → capability slugs (ver bloque PERM_TO_CAPS).
    -- Solo seedeamos para users con rol = 'custom' (admin no necesita
    -- overrides — los bypassa por rol).
    --
    -- Si un user no admin tenía cajas=true → arranca con TODAS las caps
    -- de cajas+egresos+sanidad como overrides ON. Tras el cutover F4 las
    -- routes van a chequear las caps específicas → behavior idéntico.
    --
    -- Mismo patrón set_config para escapar a RLS (FORCE en user_capabilities
    -- + user_permissions también tiene RLS desde 20260616000002).
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT
          up.tenant_id,
          up.user_id,
          up.tool,
          tur.rol
        FROM user_permissions up
        JOIN tenant_user_roles tur
          ON tur.tenant_id = up.tenant_id AND tur.user_id = up.user_id
        WHERE up.enabled = true
          AND tur.rol = 'custom'  -- admin bypassea, no necesita seed
      LOOP
        PERFORM set_config('app.current_tenant', r.tenant_id::text, true);
        -- Expandimos el tool a sus capability slugs. Lo hacemos en SQL
        -- inline para no tener que pasar el mapping desde el helper JS:
        -- usamos un VALUES literal por tool conocido. Tools desconocidos
        -- (debugging) se skipean silenciosamente.
        CASE r.tool
          WHEN 'cotizador'   THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES (r.tenant_id, r.user_id, 'cotizador.trabajar', true)
            ON CONFLICT DO NOTHING;
          WHEN 'financiera'  THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'financiera.trabajar',     true),
              (r.tenant_id, r.user_id, 'financiera.cobro_previo', true)
            ON CONFLICT DO NOTHING;
          WHEN 'cajas'       THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'cajas.ver',             true),
              (r.tenant_id, r.user_id, 'cajas.crear',           true),
              (r.tenant_id, r.user_id, 'cajas.ver_deudas',      true),
              (r.tenant_id, r.user_id, 'cajas.ver_inversiones', true),
              (r.tenant_id, r.user_id, 'cajas.ver_360_capital', true),
              (r.tenant_id, r.user_id, 'cajas.conciliacion',    true),
              (r.tenant_id, r.user_id, 'egresos.ver',           true),
              (r.tenant_id, r.user_id, 'egresos.cargar',        true),
              (r.tenant_id, r.user_id, 'sanidad.trabajar',      true)
            ON CONFLICT DO NOTHING;
          WHEN 'envios'      THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES (r.tenant_id, r.user_id, 'envios.trabajar', true)
            ON CONFLICT DO NOTHING;
          WHEN 'cuentas'     THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'b2b.trabajar',        true),
              (r.tenant_id, r.user_id, 'b2b.cobranza_masiva', true)
            ON CONFLICT DO NOTHING;
          WHEN 'usados'      THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'usados.ver',            true),
              (r.tenant_id, r.user_id, 'usados.agregar_equipo', true),
              (r.tenant_id, r.user_id, 'usados.exportar',       true)
            ON CONFLICT DO NOTHING;
          WHEN 'inventario'  THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'inventario.ver',             true),
              (r.tenant_id, r.user_id, 'inventario.ver_costos',      true),
              (r.tenant_id, r.user_id, 'inventario.ver_movimientos', true),
              (r.tenant_id, r.user_id, 'inventario.ver_compras',     true),
              (r.tenant_id, r.user_id, 'inventario.exportar',        true),
              (r.tenant_id, r.user_id, 'inventario.importar',        true),
              (r.tenant_id, r.user_id, 'inventario.vaciar_stock',    true)
            ON CONFLICT DO NOTHING;
          WHEN 'ventas'      THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'ventas.trabajar', true),
              (r.tenant_id, r.user_id, 'ventas.eliminar', true),
              (r.tenant_id, r.user_id, 'ventas.exportar', true)
            ON CONFLICT DO NOTHING;
          WHEN 'proveedores' THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'proveedores.trabajar',        true),
              (r.tenant_id, r.user_id, 'proveedores.eliminar_compra', true)
            ON CONFLICT DO NOTHING;
          WHEN 'proyectos'   THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'proyectos.trabajar',                true),
              (r.tenant_id, r.user_id, 'proyectos.eliminar',                true),
              (r.tenant_id, r.user_id, 'proyectos.ver_costos',              true),
              (r.tenant_id, r.user_id, 'proyectos.gestionar_participantes', true)
            ON CONFLICT DO NOTHING;
          WHEN 'contactos'   THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'contactos.ver',          true),
              (r.tenant_id, r.user_id, 'contactos.crear_borrar', true)
            ON CONFLICT DO NOTHING;
          WHEN 'cambios'     THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES (r.tenant_id, r.user_id, 'cambios.trabajar', true)
            ON CONFLICT DO NOTHING;
          WHEN 'tarjetas'    THEN
            INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
            VALUES
              (r.tenant_id, r.user_id, 'tarjetas.trabajar',     true),
              (r.tenant_id, r.user_id, 'tarjetas.cobro_previo', true)
            ON CONFLICT DO NOTHING;
          ELSE
            -- 'usuarios' u otros tools no mapeados: skip silencioso.
            NULL;
        END CASE;
      END LOOP;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS user_capabilities;
    DROP TABLE IF EXISTS tenant_user_roles;
    DROP TABLE IF EXISTS capability_catalog;
    DROP FUNCTION IF EXISTS trg_tenant_user_roles_updated_at();
  `);
};
