'use strict';

// fileStore — abstracción para uploads/downloads de archivos.
//
// 2026-06-12 P-03 Fase 1: solo driver `db`, no-op funcional. Los blobs siguen
// viviendo en columnas TEXT base64 de PostgreSQL (comprobantes.archivo_data,
// productos.foto_data, venta_comprobantes.archivo_data). El propósito de esta
// fase es introducir la capa de abstracción en los call sites sin cambio
// funcional — así Fase 2 (driver R2) es solo agregar un driver, no refactorear
// 6 endpoints distintos.
//
// Driver seleccionable por env var STORAGE_DRIVER ('db' | 'r2'). Default: 'db'.
// En Fase 1 cualquier otro valor explícito tira fatal (no queremos uploads
// silenciosos a /dev/null por misconfiguración antes de que el driver r2 exista).
//
// Diseño:
// - `put({ dataBase64, filename, mime, entity, subpath })`: prepara los valores
//   que el caller va a INSERT/UPDATE. Driver db los devuelve passthrough.
//   Driver r2 (futuro) subirá al bucket y devolverá `{ data: null, key: '...' }`.
// - `get(row, { prefix })`: lee de la fila ya consultada. Driver db lee
//   `${prefix}_data`. Driver r2 (futuro) chequeará primero `${prefix}_key` y
//   hará fallback a `${prefix}_data` para filas legacy.
// - `stream(row, { prefix })`: devuelve Readable. Driver db convierte base64
//   a Buffer y wrappea con Readable.from. Driver r2 (futuro) devolverá el
//   stream del GetObjectResponse directo (sin cargar a memoria).
// - `remove(row, { prefix })`: borra del storage externo. Driver db es no-op
//   (la columna vive y muere con la fila vía soft-delete).
//
// El caller pasa el `prefix` ('archivo' para comprobantes/venta_comprobantes,
// 'foto' para productos) para que la lib sepa qué columnas leer/escribir. Esto
// es más simple que normalizar shapes y mantiene el SQL existente intacto.

const { Readable } = require('stream');

const DRIVER = (process.env.STORAGE_DRIVER || 'db').toLowerCase();

if (DRIVER !== 'db') {
  // Fase 1: solo driver db. Cualquier otro valor es error fatal — no queremos
  // que una misconfiguración haga uploads silenciosos a /dev/null antes de
  // que exista el driver r2 (Fase 2).
  throw new Error(
    `[fileStore] STORAGE_DRIVER='${DRIVER}' no está soportado todavía. ` +
    `Solo 'db' está disponible en esta versión (P-03 Fase 1). ` +
    `Setea STORAGE_DRIVER=db o esperá a Fase 2 (driver R2).`
  );
}

// Calcula el tamaño en bytes del archivo a partir de su base64. Útil para
// tracking de uso de bucket en Fase 2+ y para validar invariantes en backfill.
// No es exacto al byte (la fórmula de padding es aprox) pero suficiente para
// monitoreo. Devuelve null si el input es inválido.
function _sizeFromBase64(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  let size = Math.floor((b64.length * 3) / 4);
  if (b64.endsWith('==')) size -= 2;
  else if (b64.endsWith('=')) size -= 1;
  return size >= 0 ? size : null;
}

// Prepara los valores para INSERT/UPDATE basado en el upload entrante.
//
// Driver db (Fase 1): el blob va a la columna `*_data` (base64 string), `key`
// queda null. Si no hay upload, todos los campos son null.
//
// Driver r2 (Fase 2+): sube el archivo al bucket y devuelve `{ data: null,
// key: 'ipro/<env>/<entity>/<subpath>/<uuid>.<ext>' }`. El caller sigue
// haciendo el mismo INSERT, pero la columna `*_data` queda null y `*_key`
// guarda la referencia.
async function put(input = {}) {
  const { dataBase64, filename, mime } = input;
  if (!dataBase64) {
    return { data: null, key: null, nombre: null, tipo: null, size: null };
  }
  // Driver db: passthrough del base64 a la columna.
  return {
    data: dataBase64,
    key: null,
    nombre: filename ?? null,
    tipo: mime ?? null,
    size: _sizeFromBase64(dataBase64),
  };
}

// Lee un archivo de una fila ya consultada. El caller pasa la fila con las
// columnas relevantes (al menos `${prefix}_data`, `${prefix}_nombre`,
// `${prefix}_tipo`; opcionalmente `${prefix}_key` para futuro fallback R2).
//
// Driver db (Fase 1): lee `${prefix}_data` (base64).
// Driver r2 (Fase 2+): si `${prefix}_key` está seteado, baja de R2 y convierte
// a base64. Si no, fallback a `${prefix}_data` (legacy).
//
// Devuelve { data, nombre, tipo } o null si no hay archivo.
async function get(row, opts = {}) {
  if (!row) return null;
  const prefix = opts.prefix || 'archivo';
  const data = row[`${prefix}_data`];
  if (!data) return null;
  return {
    data,
    nombre: row[`${prefix}_nombre`] ?? null,
    tipo:   row[`${prefix}_tipo`]   ?? null,
  };
}

// Devuelve un Readable stream del archivo. Útil para export-zip y casos donde
// cargar el buffer entero a memoria escala mal.
//
// Driver db (Fase 1): convierte base64 a Buffer y wrappea en Readable.from
// (un solo chunk — el límite real lo pone el cap del endpoint, no este wrapper).
// Driver r2 (Fase 2+): devolverá el stream del GetObjectResponse directo.
//
// Devuelve null si la fila no tiene archivo.
async function stream(row, opts = {}) {
  if (!row) return null;
  const prefix = opts.prefix || 'archivo';
  const data = row[`${prefix}_data`];
  if (!data) return null;
  return Readable.from([Buffer.from(data, 'base64')]);
}

// Borra el archivo del storage externo. Driver db es no-op: las columnas viven
// y mueren con la fila a través de soft-delete (`deleted_at`). El espacio se
// libera cuando se hace hard-delete o cuando el cron de purga vacía rows con
// deleted_at < cutoff (TANDA futura, no implementado todavía).
//
// Driver r2 (Fase 2+): borrará el objeto del bucket cuando `${prefix}_key`
// está seteado. Los callers ya pueden invocarla — en Fase 1 no hace daño.
async function remove(_row, _opts = {}) {
  // No-op para driver db.
  return;
}

module.exports = {
  put,
  get,
  stream,
  remove,
  // Exposed para tests y observabilidad.
  _DRIVER: DRIVER,
};
