/**
 * 20260711100000_share_links_usados.js
 *
 * Feature: Share link público de Equipos Usados.
 *
 * Un tenant puede generar un link público (sin login) para compartir con
 * clientes por WhatsApp/redes. El link muestra el listado de equipos usados
 * disponibles en tiempo real. Solo lectura, filtrado a `condicion='usado'
 * AND estado='disponible' AND precio_venta > 0`.
 *
 * Diseño (2026-07-11, validado con Lucas + mockups en /tmp/kpis-mockups):
 *   - 1 link permanente por tenant (no uno por compartida). El operador
 *     lo pone en su bio de IG / status de WhatsApp / etc. y no lo cambia
 *     salvo que rote el token intencionalmente.
 *   - Rotación de token: reemplaza el token por uno nuevo (24 chars random).
 *     El link viejo queda inválido. Útil si se comparte por accidente.
 *   - Desactivación: `activo=false`. El link viejo devuelve "no disponible"
 *     (no 404 — más humano para el cliente que lo tenía guardado).
 *   - Analytics básicos: `share_link_views` con IP hasheada + user-agent
 *     recortado + timestamp. Sin cookies ni tracking de conversión.
 *
 * ## Tablas
 *
 * ### `share_links` (multi-tenant con RLS)
 *
 *   - `id` SERIAL PK
 *   - `tenant_id` INT FK UNIQUE (un solo link por tenant)
 *   - `token` TEXT UNIQUE (24 chars random, sin ambigüedades tipo 0/O)
 *   - `tipo` TEXT (por ahora solo 'usados_disponibles' — reservado para
 *     futuros tipos: 'ventas_pendientes', etc.)
 *   - `activo` BOOL DEFAULT true
 *   - `whatsapp` TEXT nullable — número de contacto que aparece en el pie
 *     del preview público. Sin formato específico.
 *   - `mensaje_extra` TEXT nullable (max 200 chars) — texto libre del
 *     operador para poner debajo del título ("Consultá por financiación").
 *   - `mostrar_bateria` BOOL DEFAULT true — algunos tenants prefieren no
 *     mostrar batería al público.
 *   - `mostrar_precio` BOOL DEFAULT true — algunos prefieren "consultar
 *     por WhatsApp" para el precio. Si false, el equipo se muestra igual
 *     pero sin monto.
 *   - `created_at`, `updated_at`, `rotated_at` (nullable, momento del último
 *     rotate)
 *
 * ### `share_link_views` (analytics — sin RLS, insertadas por el endpoint público)
 *
 *   - `id` BIGSERIAL PK
 *   - `share_link_id` INT FK (ON DELETE CASCADE — si el link se borra, se
 *     borra el histórico también)
 *   - `ip_hash` TEXT (SHA-256 primer 16 chars del IP + salt del env)
 *   - `user_agent_short` TEXT nullable (primer 100 chars del UA, para
 *     saber si viene de WhatsApp preview, browser mobile, etc.)
 *   - `visto_en` TIMESTAMPTZ DEFAULT NOW()
 *
 * ### RLS
 *
 *   - `share_links`: `tenant_isolation` (mismo patrón que clases_producto).
 *     El endpoint público NO usa RLS del user — usa admin pool con filtro
 *     directo por `token` (misma decisión que `tenantStatus.js` para
 *     lecturas cross-tenant seguras).
 *   - `share_link_views`: SIN RLS. Los reads son solo agregados desde el
 *     backend admin (query cross-tenant no es un problema — el admin
 *     puede ver todo). Los inserts vienen del endpoint público.
 *
 * ### Índices
 *
 *   - `share_links.token` UNIQUE (lookup por token en el endpoint público).
 *   - `share_links.tenant_id` UNIQUE (un link por tenant, enforce por DB).
 *   - `share_link_views (share_link_id, visto_en DESC)` — para queries de
 *     "vistas último mes / únicos hoy / último acceso".
 *
 * Rollback (down): DROP ambas tablas. No hay dependencias externas.
 */

exports.up = async (pgm) => {
  // ─── 1. share_links ──────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS share_links (
      id              SERIAL PRIMARY KEY,
      tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      token           TEXT NOT NULL,
      tipo            TEXT NOT NULL DEFAULT 'usados_disponibles',
      activo          BOOLEAN NOT NULL DEFAULT true,
      whatsapp        TEXT,
      mensaje_extra   TEXT,
      mostrar_bateria BOOLEAN NOT NULL DEFAULT true,
      mostrar_precio  BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotated_at      TIMESTAMPTZ,
      CONSTRAINT share_links_token_valid CHECK (LENGTH(token) BETWEEN 12 AND 64),
      CONSTRAINT share_links_tipo_valid CHECK (tipo IN ('usados_disponibles')),
      CONSTRAINT share_links_mensaje_len CHECK (mensaje_extra IS NULL OR LENGTH(mensaje_extra) <= 200),
      CONSTRAINT share_links_whatsapp_len CHECK (whatsapp IS NULL OR LENGTH(whatsapp) <= 40)
    );
  `);

  // ─── 2. Índices ──────────────────────────────────────────────────
  // token: UNIQUE global — el endpoint público hace lookup directo por
  // token sin RLS. Si el mismo token existiera en 2 tenants (imposible
  // porque genRandomToken() es criptográficamente único, pero defensa),
  // habría ambigüedad.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_share_links_token
      ON share_links (token);
  `);

  // tenant_id UNIQUE — enforce por DB que un tenant tenga UN solo link.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_share_links_tenant
      ON share_links (tenant_id);
  `);

  // ─── 3. RLS ──────────────────────────────────────────────────────
  // Mismo patrón que clases_producto (migration 20260708000002).
  pgm.sql(`
    ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE share_links FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON share_links
      USING (tenant_id = current_setting('app.current_tenant', true)::int);
  `);

  // ─── 4. Trigger updated_at ───────────────────────────────────────
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at_share_links()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_share_links_updated_at ON share_links;
    CREATE TRIGGER trg_share_links_updated_at
      BEFORE UPDATE ON share_links
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at_share_links();
  `);

  // ─── 5. share_link_views (analytics) ─────────────────────────────
  // BIGSERIAL: podría crecer rápido si un link es viral. Sin RLS
  // porque el endpoint público inserta sin contexto de tenant (usa el
  // admin pool). Los reads son solo desde el admin backend por link.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS share_link_views (
      id                BIGSERIAL PRIMARY KEY,
      share_link_id     INT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
      ip_hash           TEXT NOT NULL,
      user_agent_short  TEXT,
      visto_en          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT share_link_views_ip_hash_len CHECK (LENGTH(ip_hash) BETWEEN 8 AND 64),
      CONSTRAINT share_link_views_ua_len CHECK (user_agent_short IS NULL OR LENGTH(user_agent_short) <= 200)
    );
  `);

  // Index para agregados: "vistas último mes", "únicos hoy", "último acceso".
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_share_link_views_link_visto
      ON share_link_views (share_link_id, visto_en DESC);
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS share_link_views CASCADE;`);
  pgm.sql(`DROP TABLE IF EXISTS share_links CASCADE;`);
  pgm.sql(`DROP FUNCTION IF EXISTS set_updated_at_share_links() CASCADE;`);
};
