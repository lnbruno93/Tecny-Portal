/* eslint-disable camelcase */
/**
 * Feature: contacto_tipos editables per-tenant (task #290).
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * Los tipos de contacto (Cliente / Amigo / Familiar / Inversor / Tecny Team)
 * estaban hardcoded en 3 lugares del frontend + un CHECK constraint en
 * `contactos.tipo` desde la migration inicial (20260521000001). Consecuencias:
 *
 *   1. **Divergencia UI**: Contactos.jsx mostraba el value raw legacy
 *      "ipro team" en el dropdown, mientras Cajas.jsx +
 *      ContactoPickerEmbedded.jsx aplicaban un pretty label "Tecny Team"
 *      via TIPO_LABEL mapping. El value en DB seguía siendo 'ipro team'
 *      (constraint no migrado post-rebrand 06-18).
 *
 *   2. **No extensible**: cada tenant tenía las mismas 5 opciones sin
 *      poder crear tipos custom para sus casos de negocio. Un cliente
 *      con casos como "distribuidor mayorista", "cliente VIP", "proveedor
 *      externo" no podía modelarlos.
 *
 * ── Cambios de este PR ────────────────────────────────────────────────
 *
 * 1. **Nueva tabla `contacto_tipos`** per-tenant con:
 *    · `slug` — value interno estable (referenciado por `contactos.tipo`).
 *    · `nombre` — label visible al user (editable sin migrar contactos).
 *    · `orden` — para ordenar el dropdown.
 *    · `activo` — soft-hide del dropdown sin romper contactos existentes.
 *    · `is_system` — flag que impide borrar los 5 defaults (owner puede
 *                    renombrar el label, cambiar orden, activar/desactivar,
 *                    pero no eliminarlos completamente).
 *    · `deleted_at` — soft delete estándar.
 *    · UNIQUE `(tenant_id, slug)` sobre rows vivos.
 *    RLS canónica via `enableTenantRlsFor()`.
 *
 * 2. **Seed 4 tipos universales per-tenant existente**: cliente, amigo,
 *    familiar, inversor con `is_system=true`. Aplican a todos los tenants.
 *
 * 3. **Seed 'ipro team' SOLO donde ya se usa**: buscamos qué tenants
 *    tienen contactos existentes con `tipo='ipro team'` y les seedeamos
 *    ese tipo (con label pretty "iPro Team", is_system=false para que
 *    puedan borrarlo/renombrar). Otros tenants NO reciben este tipo —
 *    su dropdown queda limpio. Corrección semántica: "Tecny" es el
 *    nombre de la herramienta, "iPro" era el tenant original (negocio
 *    de Lucas). El label correcto es "iPro Team" — el label previo
 *    "Tecny Team" era un error del rebrand.
 *
 * 3. **DROP CHECK constraint** de `contactos.tipo`. La validación pasa a
 *    la app (backend valida contra `SELECT slug FROM contacto_tipos WHERE
 *    tenant_id = X AND activo = true` al INSERT/UPDATE). No agregamos FK
 *    real para evitar acoplamiento — los contactos historicos con tipos
 *    que se soft-deletearon después no se rompen.
 *
 * 4. **Seed también para tenants NUEVOS**: helper `seedContactoTiposPara
 *    Tenant()` invocado desde signup.js (fuera de esta migration — ver PR
 *    del backend). Ese cambio va en el mismo commit.
 *
 * ── Rollback ──────────────────────────────────────────────────────────
 *
 * `down()`:
 *   1. Re-add CHECK constraint con los 5 valores originales (los contactos
 *      con tipos custom nuevos van a romper el rollback — aceptable, es
 *      rollback: se pierde el feature).
 *   2. DROP TABLE contacto_tipos CASCADE.
 *
 * DATA LOSS RISK del rollback: si el tenant creó tipos custom (fuera de
 * los 5 defaults) y hay contactos usándolos → el rollback rompe.
 * Aceptable: es rollback, y solo pasa si se activó el feature.
 */

const { enableTenantRlsFor } = require('../src/lib/rlsCanonical');

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ─── 1. Tabla contacto_tipos ────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE contacto_tipos (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug          TEXT NOT NULL,
      nombre        TEXT NOT NULL,
      orden         INTEGER NOT NULL DEFAULT 0,
      activo        BOOLEAN NOT NULL DEFAULT TRUE,
      is_system     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ,
      CONSTRAINT contacto_tipos_slug_no_vacio CHECK (length(trim(slug)) > 0),
      CONSTRAINT contacto_tipos_nombre_no_vacio CHECK (length(trim(nombre)) > 0)
    );

    -- UNIQUE parcial: solo entre rows vivos. Permite re-crear un slug que
    -- se había soft-borrado (aunque el flow normal es "reactivar" en vez
    -- de borrar).
    CREATE UNIQUE INDEX idx_contacto_tipos_tenant_slug
      ON contacto_tipos (tenant_id, slug)
      WHERE deleted_at IS NULL;

    -- Index para el listado ordenado del dropdown.
    CREATE INDEX idx_contacto_tipos_tenant_orden
      ON contacto_tipos (tenant_id, orden, nombre)
      WHERE deleted_at IS NULL AND activo = TRUE;
  `);

  // ─── 2. Seed 4 tipos universales para TODOS los tenants ─────────────
  //
  // Orden crítico (post-mortem P0 08-03): los seeds VAN ANTES de
  // enableTenantRlsFor(contacto_tipos). Razón: enableTenantRlsFor aplica
  // ENABLE + FORCE ROW LEVEL SECURITY + policy `WITH CHECK (tenant_id =
  // NULLIF(current_setting('app.current_tenant', true), '')::int)`. En
  // el contexto de la migration NO hay app.current_tenant seteado →
  // NULLIF resuelve NULL → cualquier INSERT viola WITH CHECK → migration
  // falla → Railway container stops. Reproducido en prod con PR #986
  // (revert PR #993). El fix es: seedear PRIMERO (tabla recién CREATE,
  // RLS aún disabled — INSERT libre), enableTenantRlsFor DESPUÉS (los
  // rows ya seedeados no re-validan WITH CHECK, solo INSERTs futuros).
  //
  // Cliente/Amigo/Familiar/Inversor aplican a cualquier negocio.
  // `is_system=true` previene DELETE desde el CRUD. Owner puede renombrar
  // (nombre), reordenar (orden), o desactivar (activo=false) pero no
  // eliminar completamente. Idempotente vía ON CONFLICT DO NOTHING.
  pgm.sql(`
    INSERT INTO contacto_tipos (tenant_id, slug, nombre, orden, activo, is_system)
    SELECT t.id, defs.slug, defs.nombre, defs.orden, TRUE, TRUE
      FROM tenants t
      CROSS JOIN (
        VALUES
          ('cliente',  'Cliente',  1),
          ('amigo',    'Amigo',    2),
          ('familiar', 'Familiar', 3),
          ('inversor', 'Inversor', 4)
      ) AS defs(slug, nombre, orden)
      WHERE t.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  `);

  // ─── 3. Seed slug legacy 'ipro team' SOLO donde ya se usa ───────────
  //
  // Correción semántica (Lucas 2026-08-03): "Tecny" es el nombre de la
  // herramienta, "iPro" era el tenant original (negocio de Lucas). El
  // slug legacy 'ipro team' refiere al "equipo de iPro" — el nombre
  // pretty correcto es "iPro Team", no "Tecny Team". Y ese tipo NO tiene
  // sentido para otros tenants (Nook Tech, Tek Haus, etc.) — solo aplica
  // al tenant iPro.
  //
  // En vez de asumir tenant_id=1 (frágil), buscamos qué tenants tienen
  // contactos existentes con `tipo='ipro team'` y les seedeamos el tipo
  // (con is_system=false, así lo pueden borrar/renombrar libremente).
  // Los demás tenants NO reciben este tipo — su dropdown queda limpio
  // con solo los 4 universales.
  //
  // Post-migration, tenants nuevos NUNCA reciben 'ipro team' (ver
  // lib/seedContactoTipos.js — solo los 4 universales). Este tipo es
  // puramente backward-compat para tenants con data histórica.
  //
  // Pattern runbook 08-01: `contactos` tiene FORCE RLS activo — sin
  // app.current_tenant en migration, un SELECT devuelve 0 rows silente
  // (fail-closed). Aplicamos NO FORCE temporal para que el SELECT
  // funcione, INSERT, y restauramos FORCE. Todo dentro de la tx de
  // node-pg-migrate → invariante preservado si algo falla (ROLLBACK
  // restaura FORCE automáticamente).
  pgm.sql(`
    ALTER TABLE contactos NO FORCE ROW LEVEL SECURITY;

    INSERT INTO contacto_tipos (tenant_id, slug, nombre, orden, activo, is_system)
    SELECT DISTINCT c.tenant_id, 'ipro team', 'iPro Team', 5, TRUE, FALSE
      FROM contactos c
      JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
     WHERE c.tipo = 'ipro team'
       AND c.deleted_at IS NULL
    ON CONFLICT DO NOTHING;

    ALTER TABLE contactos FORCE ROW LEVEL SECURITY;
  `);

  // ─── 4. RLS canónica sobre contacto_tipos ──────────────────────────
  //
  // DESPUÉS del seed — ver comentario del paso 2 sobre por qué. Los rows
  // ya insertados quedan intactos (RLS no re-valida rows existentes al
  // enable); solo aplica a INSERT/UPDATE/DELETE futuros desde la app.
  enableTenantRlsFor(pgm, 'contacto_tipos');

  // ─── 5. DROP CHECK constraint de contactos.tipo ─────────────────────
  //
  // La validación pasa a la app. Backend valida en INSERT/UPDATE que el
  // tipo esté en contacto_tipos activo del tenant. Ver
  // backend/src/routes/contactos.js (validación pos-Zod).
  //
  // Nota: NO migro los values existentes de `contactos.tipo` (ej. cambiar
  // 'ipro team' → 'tecny_team'). Eso requeriría el pattern del runbook
  // 08-01 (ALTER TABLE NO FORCE + UPDATE + FORCE) y no es necesario — el
  // label pretty 'iPro Team' viene ahora del JOIN con contacto_tipos.
  pgm.sql(`
    ALTER TABLE contactos DROP CONSTRAINT IF EXISTS contactos_tipo_check;
  `);
};

exports.down = (pgm) => {
  // Re-add CHECK constraint con los 5 valores originales. Los contactos
  // con tipos custom nuevos van a fallar el ALTER — aceptable, es rollback.
  pgm.sql(`
    ALTER TABLE contactos
      ADD CONSTRAINT contactos_tipo_check
      CHECK (tipo IN ('amigo','familiar','cliente','inversor','ipro team'));

    DROP TABLE IF EXISTS contacto_tipos CASCADE;
  `);
};
