/**
 * 20260707000004_productos_imei_normalize_scientific.js
 *
 * Contexto (bug reportado por Lucas 2026-07-07):
 *   El picker de productos del modal Nueva Venta muestra 2 iPhone 17 Pro Max
 *   cuando se buscan los últimos 3 dígitos "411" del IMEI, pero al agregar el
 *   4to dígito ("4110") el dropdown queda vacío — aunque uno de los IMEIs
 *   (353427339414110) SÍ contiene "4110" al final.
 *
 * Root cause:
 *   Cuando el operador importa stock desde un .xlsx exportado por Google
 *   Sheets o Excel, los IMEIs de 15 dígitos se guardan en el XML del sheet
 *   como notación científica ("3.5342733941411E14") porque el motor los trata
 *   como número. El parser XLSX del front (frontend/src/lib/xlsx.js) lee el
 *   `<v>` tal cual y `importStock.js` lo persiste con solo un `.trim()` — sin
 *   normalizar. La columna `productos.imei` queda con ese string científico.
 *
 *   El frontend enmascara el problema en el display con `fmtImei()`
 *   (frontend/src/lib/format.ts) que convierte "3.5342733941411E14" →
 *   "353427339414110" a la hora de mostrar. Pero la BÚSQUEDA (ILIKE %4110%)
 *   consulta la DB directamente, y allí el valor sigue siendo el string
 *   científico — que NO contiene "4110" como sufijo contiguo. Bug latente
 *   desde el importador XLSX original (#44 carga robusta desde .xlsx, 2026).
 *
 * Fix:
 *   1) Esta migration hace backfill: normaliza cualquier IMEI que matchee la
 *      forma "\d+(\.\d+)?[eE]\+?\d+" al string de dígitos limpios.
 *      El cast `numeric → bigint → text` es determinístico:
 *        '3.5342733941411E14'::numeric = 353427339414110
 *        353427339414110::bigint::text = '353427339414110'
 *      Preserva el 0 trailing que Excel había comido al hacer notación
 *      científica (el número real es el mismo, solo la representación cambió).
 *
 *   2) El PR asociado agrega la MISMA normalización en `mapStockRows` del
 *      importador para evitar re-ocurrencias en futuros imports.
 *
 * Idempotente: la WHERE con regex sólo matchea filas AÚN en formato
 * científico. Correr 2 veces no cambia nada extra.
 *
 * Alcance: sólo `productos.imei`. Las tablas relacionadas por IMEI
 * (`venta_items.imei`, `proveedor_movimiento_items.imei_serial`) copian el
 * texto tal como venía del producto en el momento de la venta/compra, así
 * que no las tocamos — no son fuente de verdad y romper su valor histórico
 * complicaría auditoría sin beneficio (las búsquedas críticas ocurren sobre
 * `productos.imei` que es lo que popula el picker).
 */

/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Normaliza IMEIs guardados como notación científica desde imports XLSX.
    -- Regex ~ '^\\d+(\\.\\d+)?[eE]\\+?\\d+$' matchea "3.5342733941411E14",
    -- "1.23E+15", "1E14", etc. No matchea IMEIs limpios "353..." ni seriales
    -- alfanuméricos "SJW0KF7C5P6" (AirPods).
    --
    -- El cast usa numeric (arbitrario-precision, no float) + bigint para
    -- obtener el string entero exacto sin pérdida en los 15 dígitos.
    UPDATE productos
       SET imei = (imei::numeric::bigint)::text
     WHERE imei ~ '^\\d+(\\.\\d+)?[eE]\\+?\\d+$'
       AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  // No revertible — no hay forma determinística de reconstruir el string
  // científico original desde el número limpio (Excel elige la mantisa según
  // ancho de columna, precisión display, etc.). El valor semántico (el IMEI
  // como número) es el mismo antes/después, así que un rollback conceptual
  // no requiere revertir la data — sólo dejaría de aplicar la normalización
  // a filas futuras (que ahora también las cubre el fix en mapStockRows).
  pgm.sql('SELECT 1;');
};
