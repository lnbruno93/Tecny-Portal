/**
 * Tabla `site_landing_companies` — CMS Landing Fase 4: "Empresas que confiaron
 * en Tecny".
 *
 * 2026-07-18 (feature):
 *
 * Contexto: Lucas quiere una sección de logos de marcas / empresas que ya son
 * clientes o partners de Tecny, editable desde el back office con capacidad
 * para 30-40 logos. Va a lucir como carrusel auto-scroll estilo Stripe/Vercel
 * ("Trusted by"). Los logos se suben como archivos PNG/SVG desde el admin.
 *
 * Por qué tabla nueva y NO extensión de `site_landing_config`:
 *   · El singleton `site_landing_config` guarda campos de texto + arrays cortos
 *     (testimonials, faq). Meter 30-40 logos en base64 dentro de un JSONB
 *     inflaría la row entera a 400KB-1.2MB — y ese payload viaja completo en
 *     cada request de GET /api/public/site-config (que sirve TODO el CMS a la
 *     landing). Con tabla dedicada podemos servir metadata liviana en
 *     /site-config y pedir los logos por endpoint separado con cache HTTP 24h.
 *   · Operaciones granulares: add/remove/reorder son 1 row cada una en vez de
 *     re-enviar el array completo con semántica PUT.
 *   · Escala: si crece a 100+ logos en el futuro, no hay que refactorear.
 *
 * Storage de los logos: reutilizamos el helper `lib/fileStore.js` con las
 * mismas columnas que comprobantes y productos usan (`logo_data`, `logo_key`,
 * `logo_nombre`, `logo_tipo`, `logo_size`). Driver `db` = base64 en la columna,
 * driver `r2` = key en R2. El backend se abstrae con fileStore.put/get/remove.
 * En prod hoy Tecny usa driver `r2` (Cloudflare R2), staging/dev pueden usar
 * `db`.
 *
 * Sin RLS: es config global de la landing pública de Tecny, no per-tenant
 * (igual que `site_landing_config`). El acceso lo controla `requireSuperAdmin`
 * en las rutas admin.
 *
 * Índices:
 *   · idx (deleted_at, position) para el GET public ordenado y filtrado por
 *     activos, sin scan completo.
 *   · unique (LOWER(nombre)) parcial WHERE deleted_at IS NULL para evitar
 *     cargar la misma empresa dos veces por accidente.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('site_landing_companies', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    nombre: {
      type: 'text',
      notNull: true,
    },
    // ── Storage del logo (fileStore protocol) ────────────────────────────────
    // logo_data: base64 cuando driver=db. NULL cuando driver=r2 (fila migrada).
    // logo_key:  path del objeto en R2 (ej. ipro/prod/t1/site-landing/<uuid>.png).
    //            NULL cuando driver=db.
    // Exactamente uno de los dos tiene valor (los dos NULL ⇒ upload roto).
    logo_data:   { type: 'text', notNull: false },
    logo_key:    { type: 'text', notNull: false },
    logo_nombre: { type: 'text', notNull: false }, // filename original
    logo_tipo:   { type: 'text', notNull: false }, // mime type
    logo_size:   { type: 'integer', notNull: false }, // bytes
    // ── Orden y meta ─────────────────────────────────────────────────────────
    // position: orden manual desde el admin (flechas ↑↓). 0-indexed, gaps
    // permitidos (no hay reglas duras — solo se ordena por este campo ASC).
    position: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    // Soft-delete para poder revertir borrados accidentales sin perder el
    // archivo (fileStore.remove SÍ borra del bucket — el soft-delete queda por
    // si se cambia esa política en el futuro).
    deleted_at: {
      type: 'timestamptz',
      notNull: false,
    },
  });

  // Índice compuesto para el GET public: WHERE deleted_at IS NULL ORDER BY position.
  pgm.sql(`
    CREATE INDEX idx_site_landing_companies_active_position
      ON site_landing_companies (position)
      WHERE deleted_at IS NULL;
  `);

  // Unique parcial: no dos empresas con el mismo nombre (case-insensitive)
  // entre las activas. Si se soft-borra una, se puede cargar otra con el
  // mismo nombre — típico patrón "reuse after delete".
  pgm.sql(`
    CREATE UNIQUE INDEX idx_site_landing_companies_nombre_unique
      ON site_landing_companies (LOWER(nombre))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('site_landing_companies');
};
