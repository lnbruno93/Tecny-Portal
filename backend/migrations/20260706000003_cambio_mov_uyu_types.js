/* eslint-disable camelcase */
/**
 * Extiende el CHECK constraint `cambio_movimientos.tipo` para admitir UYU.
 *
 * Contexto (audit 2026-07-06 correctness P1): el módulo Cambios de Divisa
 * nació 100% para el par ARS/USD (tipos hardcoded 'entrega_ars' + 'recibo_usd').
 * Cuando se agregó multi-país (F1-F5 mergeados 2026-06-29+) y un tenant UY
 * empezó a operar en UYU, los pagos cross-tenant B2B en UYU calculaban la
 * diferencia cambiaria bien y la persistían en el snapshot de
 * `cross_tenant_pagos.diferencia_cambiaria_ars` (nombre legacy), pero NO
 * podían asentarla en Cambios de Divisa porque el CHECK no admitía el tipo
 * UYU → el asiento se skippeaba silenciosamente (comentario explícito en
 * `crossTenantPagos.js:289-300`).
 *
 * Consecuencia: los reportes de Cambios de Divisa para tenants UY están
 * incompletos — subestiman ganancia/pérdida cambiaria en el histórico.
 *
 * Estrategia:
 *   - Agregar 'entrega_uyu' + 'recibo_usd_uy' al CHECK. Mantenemos
 *     'recibo_usd' como legacy (implícitamente asociado a ARS por la UI).
 *   - El sufijo '_uy' en 'recibo_usd_uy' identifica que el par es UYU/USD
 *     (aunque los USD son fungibles, el linaje contable importa para el
 *     drilldown en la UI).
 *
 * Deuda técnica pendiente (documentada, PR aparte):
 *   - Columna `monto_ars` mantiene el nombre legacy pero en filas UYU
 *     contiene monto UYU. La UI Cambios (`frontend/src/pages/Cambios.jsx`)
 *     hoy hardcodea el label "ARS" — post-merge de este PR, tenants UY
 *     verán label incorrecto en la grilla. Se corrige en follow-up chico
 *     con condicional según `tenants.pais`.
 *
 * Idempotente: el DROP CONSTRAINT + ADD CONSTRAINT se puede correr N veces
 * sin efecto colateral (siempre queda con el CHECK extendido).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cambio_movimientos DROP CONSTRAINT IF EXISTS cambio_movimientos_tipo_check;
    ALTER TABLE cambio_movimientos ADD CONSTRAINT cambio_movimientos_tipo_check
      CHECK (tipo IN ('entrega_ars','recibo_usd','entrega_uyu','recibo_usd_uy'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir el backfill primero: borrar filas con tipos UYU antes de
    -- restringir el CHECK (sino el ADD CONSTRAINT viola por filas existentes).
    DELETE FROM cambio_movimientos WHERE tipo IN ('entrega_uyu','recibo_usd_uy');

    ALTER TABLE cambio_movimientos DROP CONSTRAINT IF EXISTS cambio_movimientos_tipo_check;
    ALTER TABLE cambio_movimientos ADD CONSTRAINT cambio_movimientos_tipo_check
      CHECK (tipo IN ('entrega_ars','recibo_usd'));
  `);
};
