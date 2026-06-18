/**
 * Migration: rename tenant 1 de "iPro Original" a "Tecny" (rebrand #324).
 *
 * Contexto: hasta hoy el producto se llamaba "iPro" (con el subtítulo
 * histórico "Tech Reseller · Celnyx"). Tras la compra del dominio
 * tecnyapp.com pasamos a ser "Tecny" como marca. Toda la UI + emails ya
 * dicen "Tecny" (PR #324). Falta solo este rename del tenant 1, que es
 * el portal histórico de Lucas y aparece embebido en el JWT (tenant_id=1).
 *
 * Idempotencia: el WHERE filtra por `nombre = 'iPro Original'`. Si la
 * migration corre por segunda vez (o el tenant fue renombrado por otro
 * camino), el UPDATE es no-op. Seguro de re-correr en dev/staging/prod.
 *
 * Slug: cambia de 'ipro' a 'tecny'. La constraint del schema exige
 * `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (min 2 chars) — 'tecny' cumple. Como
 * no usamos slug en URLs todavía (eso queda para multi-tenant routing
 * por subdominio en una TANDA futura), renombrarlo no rompe nada.
 *
 * Riesgo de colisión del slug: hay UNIQUE constraint en `tenants.slug`.
 * Si otro tenant ya tiene slug 'tecny' (no debería — Lucas no creó otros
 * tenants signupeados con ese nombre), el UPDATE falla. En ese caso,
 * resolverlo manualmente con un sufijo (`tecny-1`, etc).
 *
 * Down: revierte al nombre histórico. Útil para dev local si querés volver.
 * En staging/prod no esperamos correr el down.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE tenants
       SET nombre = 'Tecny',
           slug = 'tecny'
     WHERE id = 1
       AND nombre = 'iPro Original';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE tenants
       SET nombre = 'iPro Original',
           slug = 'ipro'
     WHERE id = 1
       AND nombre = 'Tecny';
  `);
};
