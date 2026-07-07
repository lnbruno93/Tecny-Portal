/**
 * 20260707000003_plantillas_garantia_placeholder_negocio.js
 *
 * Contexto completo del bug + diagnóstico en el commit del PR
 * `fix/plantillas-garantia-tenant-nombre-runtime` — 2026-07-07.
 *
 * Resumen:
 *   - Las plantillas de garantía tenían el nombre del negocio hardcoded
 *     en el texto (originalmente "iPro | Tech Reseller" del seed 2026-05-24,
 *     luego editado en algunos tenants a "Tecny | Tech Reseller" o solo
 *     "Tecny").
 *   - El fix de código del 2026-07-03 (commit 3213561) hizo que el PDF use
 *     `tenant.nombre` en el BRAND del header y el footer, pero el body de
 *     la garantía sigue usando `garantia_texto` de la DB tal cual — con el
 *     nombre viejo dentro.
 *   - Diseño correcto (Lucas 2026-07-07): las plantillas guardan el
 *     placeholder `{{negocio}}` en el texto. El frontend hace
 *     `renderPlantilla(texto, tenant.nombre)` para resolverlo al nombre
 *     real del tenant en runtime.
 *
 * Esta migration hace el backfill de data existente:
 *   - Reemplaza los pies conocidos ("iPro | Tech Reseller",
 *     "Tecny | Tech Reseller", "Tecny Tech | Reseller", "Tecny", "iPro")
 *     al FINAL del texto por `{{negocio}}` (preservando el "| Tech Reseller"
 *     si estaba, así el pie queda uniforme).
 *   - NO toca plantillas ya editadas con nombres custom del tenant (ej.
 *     "Celnyx | Tech Reseller", "Tek Haus", cualquier otro nombre).
 *   - NO toca menciones de "iPro"/"Tecny" en el medio del body.
 *
 * Idempotente — corre 2 veces no cambia nada extra.
 */

/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Reemplaza el pie de firma "\\n\\n<Tecny|iPro>[...variantes...]" al FINAL
    -- del texto por "\\n\\n{{negocio}} | Tech Reseller" (si el pie original
    -- tenía "| Tech Reseller" o similar) o simplemente "\\n\\n{{negocio}}" si
    -- era solo "Tecny" o "iPro" sin sufijo.
    --
    -- Usamos 2 UPDATEs separadas para preservar la variante con "| Tech Reseller"
    -- (que es la más común y le da un pie de firma consistente a los tenants).
    -- Todo con regexp_replace anclado al final (con \\s*$ para tolerar whitespace
    -- trailing) y case-insensitive.

    -- 1. Pies con sufijo "Tech Reseller" o "Reseller" → convertir a
    --    "\\n\\n{{negocio}} | Tech Reseller".
    UPDATE plantillas_garantia
       SET texto = regexp_replace(
         texto,
         E'\\n\\n(Tecny|iPro)( Tech)?( ?\\\\| ?(Tech )?Reseller)\\\\s*$',
         E'\\n\\n{{negocio}} | Tech Reseller',
         'in'
       )
     WHERE deleted_at IS NULL
       AND texto ~* E'\\n\\n(Tecny|iPro)( Tech)?( ?\\\\| ?(Tech )?Reseller)\\\\s*$';

    -- 2. Pies SOLO "Tecny" o "iPro" (sin "| Tech Reseller") → convertir a
    --    "\\n\\n{{negocio}}".
    UPDATE plantillas_garantia
       SET texto = regexp_replace(
         texto,
         E'\\n\\n(Tecny|iPro)( Tech)?\\\\s*$',
         E'\\n\\n{{negocio}}',
         'in'
       )
     WHERE deleted_at IS NULL
       AND texto ~* E'\\n\\n(Tecny|iPro)( Tech)?\\\\s*$';
  `);
};

exports.down = (pgm) => {
  // No revertible determinísticamente — la data pre-migration difería por
  // tenant (unos "iPro | Tech Reseller", otros "Tecny", etc.). Si algún
  // tenant necesita restaurar su pie exacto, lo edita desde Config →
  // Plantillas de Garantía. El diff antes/después queda en `audit_logs` si
  // el sistema audita cambios a plantillas.
  pgm.sql('SELECT 1;');
};
