// stockPlantilla — schema canónico de la plantilla XLSX/CSV para carga de stock.
//
// 2026-07-31 (task #266): extraído de Inventario.jsx para compartir con
// CompraProveedorModal. Objetivo: que "descargar plantilla" e "importar
// XLSX" tengan el mismo shape en ambos módulos (Inventario > Importar y
// Compras > Proveedores > Cargar compra). Pedido de cliente Nook Tech.
//
// Módulos que consumen esto:
//   · frontend/src/screens/Inventario.jsx (import XLSX/CSV masivo)
//   · frontend/src/components/CompraProveedorModal.jsx (import XLSX
//     que popula el spreadsheet editable del modal)
//
// Backward compat: si un operador tiene un XLSX viejo con headers
// distintos, el parser (frontend/src/lib/importStock.js `normHeader` +
// `STOCK_ALIASES`) descarta paréntesis y matchea sinónimos. Podemos
// evolucionar los labels sin romper archivos históricos.
//
// Backend: ambos módulos POSTean a `/proveedores/movimientos/bulk`, que
// registra un `proveedor_movimiento` (tipo=compra) + los productos en
// Inventario en una sola transacción atómica.

import { writeXlsx } from './xlsx';
import { downloadBlob } from './downloadBlob';
import { exportCsv } from './exportCsv';

// Encabezados EXACTOS de la planilla del negocio (misma base para importar
// y exportar). El orden importa — `productoARow()` en Inventario.jsx asume
// este orden para exportar.
//
// 2026-07-25: última columna cambió de "ID DEPOSITO(SÓLO NÚMERO)" a
// "DEPOSITO(nombre o ID)". El backend ya soportaba nombre pero el header
// forzaba al operador a memorizar IDs. Ahora acepta nombre y auto-crea
// si no existe (mismo patrón que CATEGORIA post-fix XLSX PR #876).
//
// Sufijos "(solo iph)" / "(solo acc)" son labels-hint para operadores no
// técnicos — indican qué campos son relevantes según el tipo de producto.
// El parser los ignora (`normHeader` descarta paréntesis).
// 2026-08-01 (task #273): columna "TC COSTO" agregada. Es OBLIGATORIA cuando
// MONEDA COSTO es ARS o UYU (regla PO Lucas — todo el stock se mide en USD;
// con este TC el backend convierte al vuelo y unifica el KPI valorizado).
// Vacía cuando MONEDA COSTO es USD/USDT (no aplica). Ubicada JUSTO después
// de MONEDA COSTO para que el operador la vea al lado del campo relacionado.
export const PLANTILLA_HEADERS = [
  'Nombre',
  'GB(solo iph)',
  'BATERIA(solo iph)',
  'COLOR(solo iph)',
  'COSTO',
  'MONEDA COSTO(ARS/USD)',
  'TC COSTO(si moneda ARS/UYU)',
  'PRECIO',
  'MONEDA PRECIO(ARS/USD)',
  'IMEI(solo iph)',
  'TIPO(unitario, stock)',
  'CATEGORIA',
  'PROVEEDOR',
  'STOCK(solo acc)',
  'DEPOSITO(nombre o ID)',
];

// Filas de ejemplo: un celular (IMEI, sin STOCK) y un accesorio (STOCK,
// sin IMEI). Sirven de guía visual para el operador que abre la plantilla.
//
// 2026-07-25: depósito ejemplo cambiado de "1" (ID numérico) a "Principal"
// (nombre) para reforzar que el nombre es aceptado + más intuitivo.
// 2026-08-01 (task #273): ejemplos incluyen TC COSTO — vacío para USD
// (no aplica) y populado para el 2do que muestra un caso ARS.
export const PLANTILLA_EJEMPLO = [
  ['iPhone 15 Pro', '256', '92', 'Natural', '800', 'USD', '', '950', 'USD', '356938035643809', 'Unitario', 'iPhone Nuevo', 'Juan Distribuidor', '', 'Principal'],
  ['Funda iPhone 15', '', '', '', '4500', 'ARS', '1500', '10500', 'ARS', '', 'stock', 'Accesorios', 'Mayorista Acc', '20', 'Principal'],
];

/**
 * Descarga la plantilla XLSX con headers + 2 filas de ejemplo.
 * Usado desde el botón "Descargar plantilla" tanto en Inventario como en
 * Compras > Proveedores > Cargar compra. Un solo file, un solo schema.
 */
export function descargarPlantillaXlsx() {
  downloadBlob(
    writeXlsx([PLANTILLA_HEADERS, ...PLANTILLA_EJEMPLO]),
    'plantilla_stock.xlsx',
  );
}

/**
 * Descarga la plantilla CSV con headers + 2 filas de ejemplo.
 * Alternativa a XLSX para operadores con Excel restringido o LibreOffice
 * viejo. Mismo schema — solo cambia el formato del container.
 */
export function descargarPlantillaCsv() {
  const rowsToObjects = PLANTILLA_EJEMPLO.map(r =>
    Object.fromEntries(PLANTILLA_HEADERS.map((h, i) => [h, r[i]])),
  );
  const cols = PLANTILLA_HEADERS.map(h => ({ key: h, label: h }));
  exportCsv('plantilla_stock.csv', rowsToObjects, cols);
}
