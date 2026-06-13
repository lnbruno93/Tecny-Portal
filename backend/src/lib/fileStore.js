'use strict';

// fileStore — abstracción para uploads/downloads de archivos.
//
// 2026-06-12 P-03 Fase 1: solo driver `db`, no-op funcional. Los blobs siguen
// viviendo en columnas TEXT base64 de PostgreSQL.
//
// 2026-06-13 P-03 Fase 2: agrega driver `r2` (Cloudflare R2 via S3-compatible
// API). El driver se elige por env var STORAGE_DRIVER ('db' | 'r2'); default
// 'db'. Cuando el driver es 'r2', el S3Client se instancia lazy en el primer
// put/get/delete — eso permite que el server arranque sin R2_* env vars, y
// solo falla cuando una operación real lo necesita.
//
// Diseño:
// - `put({ dataBase64, filename, mime, entity, subpath })`: prepara los valores
//   que el caller va a INSERT/UPDATE. Driver db los devuelve passthrough.
//   Driver r2 sube al bucket y devuelve `{ data: null, key: 'ipro/<env>/<entity>/...' }`.
// - `get(row, { prefix })`: lee de la fila ya consultada. Driver db lee
//   `${prefix}_data`. Driver r2 chequea primero `${prefix}_key` (R2) y hace
//   fallback a `${prefix}_data` (legacy pre-migration).
// - `stream(row, { prefix })`: devuelve Readable. Driver db wrappea base64 en
//   Readable.from. Driver r2 devuelve el stream del GetObjectResponse directo.
// - `remove(row, { prefix })`: borra del storage externo. Driver db es no-op
//   (soft-delete vía deleted_at). Driver r2 hace DeleteObject si hay key.
//
// El caller pasa el `prefix` ('archivo' para comprobantes/venta_comprobantes,
// 'foto' para productos) para que la lib sepa qué columnas leer/escribir. Esto
// mantiene el SQL existente intacto.
//
// Test bypass: NODE_ENV=test no carga el driver r2 ni intenta conectar a R2.
// El driver `db` es siempre seguro en tests.

const { Readable } = require('stream');
const crypto = require('crypto');

const DRIVER = (process.env.STORAGE_DRIVER || 'db').toLowerCase();
const ENV    = (process.env.NODE_ENV || 'dev').toLowerCase();

if (DRIVER !== 'db' && DRIVER !== 'r2') {
  throw new Error(
    `[fileStore] STORAGE_DRIVER='${DRIVER}' no es soportado. ` +
    `Valores válidos: 'db' (default, base64 en PostgreSQL) o 'r2' (Cloudflare R2).`
  );
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

// Calcula el tamaño en bytes del archivo a partir de su base64. Útil para
// tracking de uso de bucket y para validar invariantes en backfill.
// No es exacto al byte (la fórmula de padding es aprox) pero suficiente.
function _sizeFromBase64(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  let size = Math.floor((b64.length * 3) / 4);
  if (b64.endsWith('==')) size -= 2;
  else if (b64.endsWith('=')) size -= 1;
  return size >= 0 ? size : null;
}

// Mapeo MIME → extensión para naming de objetos R2. No exhaustivo — cubre los
// tipos que el frontend acepta (image/* + application/pdf). Default 'bin' si
// no matcheamos.
const _MIME_EXTENSIONS = {
  'image/jpeg':       'jpg',
  'image/jpg':        'jpg',
  'image/png':        'png',
  'image/gif':        'gif',
  'image/webp':       'webp',
  'image/heic':       'heic',
  'image/heif':       'heif',
  'application/pdf':  'pdf',
  'text/plain':       'txt',
};
function _extFromMime(mime) {
  if (!mime) return 'bin';
  const ext = _MIME_EXTENSIONS[mime.toLowerCase()];
  return ext || 'bin';
}

// Consume un Readable y devuelve un Buffer. Para driver r2 get(), donde S3
// devuelve un stream que tenemos que materializar a base64 para mantener el
// contrato API.
async function _streamToBuffer(stream) {
  if (!stream) return null;
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ─── Driver R2 (lazy singleton) ───────────────────────────────────────────────
//
// El S3Client se construye lazy en el primer uso para que el server pueda
// arrancar sin R2_* env vars (importante para tests + para flag-off). Cuando
// STORAGE_DRIVER=db, este código ni se ejecuta.
//
// Singleton intencional: cada réplica Railway abre 1 cliente y reusa la
// connection pool internamente. ioredis lo hace igual. AWS SDK v3 es safe
// para concurrencia desde un solo cliente.

let _s3Client = null;
let _s3LoadError = null;

function _getS3Client() {
  if (_s3Client) return _s3Client;
  if (_s3LoadError) throw _s3LoadError;

  // require lazy → si el package no está instalado en un entorno (ej. tests
  // que no necesitan R2), no rompe el load del módulo.
  try {
    // eslint-disable-next-line global-require
    const { S3Client } = require('@aws-sdk/client-s3');

    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;

    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        '[fileStore.r2] Faltan env vars: R2_ENDPOINT, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY, R2_BUCKET. STORAGE_DRIVER=r2 requiere los 4.'
      );
    }

    _s3Client = new S3Client({
      region: 'auto',  // R2 ignora region pero AWS SDK v3 lo exige
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // R2 no soporta MD5 check del request body (Cloudflare workaround):
      // forcePathStyle se prefiere para compat máxima con R2.
      forcePathStyle: true,
    });
    return _s3Client;
  } catch (err) {
    _s3LoadError = err;
    throw err;
  }
}

function _getBucket() {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error('[fileStore.r2] R2_BUCKET no está seteado');
  return b;
}

// Genera el object key para un upload nuevo. Layout (del doc de diseño):
//   ipro/<env>/<entity>/<subpath o YYYY/MM/DD>/<uuid>.<ext>
function _generateKey({ entity, subpath, mime }) {
  const ext = _extFromMime(mime);
  const uuid = crypto.randomUUID();
  let path;
  if (subpath) {
    // subpath explícito del caller (ej. 'producto-123', 'venta-456')
    path = subpath;
  } else {
    // default: YYYY/MM/DD para facilitar listing por período
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    path = `${yyyy}/${mm}/${dd}`;
  }
  return `ipro/${ENV}/${entity}/${path}/${uuid}.${ext}`;
}

// ─── API pública ──────────────────────────────────────────────────────────────

// Prepara los valores para INSERT/UPDATE basado en el upload entrante.
//
// Driver db: passthrough del base64 a la columna `*_data`.
// Driver r2: sube al bucket y devuelve `{ data: null, key: '...' }`. El caller
//   hace el mismo INSERT pero la columna `*_data` queda NULL y `*_key` guarda
//   la referencia.
async function put(input = {}) {
  const { dataBase64, filename, mime, entity, subpath } = input;

  if (!dataBase64) {
    return { data: null, key: null, nombre: null, tipo: null, size: null };
  }

  const size = _sizeFromBase64(dataBase64);

  if (DRIVER === 'db') {
    return {
      data: dataBase64,
      key: null,
      nombre: filename ?? null,
      tipo: mime ?? null,
      size,
    };
  }

  // DRIVER === 'r2'
  // eslint-disable-next-line global-require
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = _getS3Client();
  const key = _generateKey({ entity: entity || 'misc', subpath, mime });
  const Body = Buffer.from(dataBase64, 'base64');

  await client.send(new PutObjectCommand({
    Bucket: _getBucket(),
    Key: key,
    Body,
    ContentType: mime || 'application/octet-stream',
    // Metadata custom — el original filename se guarda para audit/diagnóstico.
    // Filtramos caracteres no-ASCII para evitar problemas de header HTTP.
    Metadata: filename ? { 'original-name': filename.replace(/[^\x20-\x7E]/g, '_').slice(0, 200) } : undefined,
  }));

  return {
    data: null,
    key,
    nombre: filename ?? null,
    tipo: mime ?? null,
    size,
  };
}

// Lee un archivo de una fila ya consultada. El caller pasa la fila con las
// columnas relevantes — al menos `${prefix}_data` y `${prefix}_nombre`,
// `${prefix}_tipo`. Opcionalmente `${prefix}_key` para el path R2.
//
// Driver db: lee `${prefix}_data` (base64).
// Driver r2: chequea primero `${prefix}_key`. Si existe, baja de R2 y
//   convierte a base64 (mantiene el contrato API del frontend). Si no hay
//   key, fallback a `${prefix}_data` (filas legacy pre-migration).
//
// Devuelve { data, nombre, tipo } o null si no hay archivo.
async function get(row, opts = {}) {
  if (!row) return null;
  const prefix = opts.prefix || 'archivo';

  // Path 1 (driver r2 + fila migrada): leer de R2
  if (DRIVER === 'r2' && row[`${prefix}_key`]) {
    // eslint-disable-next-line global-require
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const client = _getS3Client();
    try {
      const resp = await client.send(new GetObjectCommand({
        Bucket: _getBucket(),
        Key: row[`${prefix}_key`],
      }));
      const buffer = await _streamToBuffer(resp.Body);
      if (!buffer) return null;
      return {
        data: buffer.toString('base64'),
        nombre: row[`${prefix}_nombre`] ?? null,
        tipo:   row[`${prefix}_tipo`]   ?? null,
      };
    } catch (err) {
      // NoSuchKey → la fila apunta a un objeto que no existe (puede haber
      // sido borrado a mano). No es excepción de runtime, devolvemos null
      // para que el caller responda 404.
      if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
        return null;
      }
      throw err;
    }
  }

  // Path 2 (driver db O fila legacy en driver r2): leer de la columna *_data
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
// Driver db: convierte base64 a Buffer y wrappea en Readable.from (un solo
// chunk — el límite real lo pone el cap del endpoint).
// Driver r2: devuelve el stream del GetObjectResponse directo (sin cargar
// a memoria — esto es el beneficio principal del migration vs base64).
//
// Devuelve null si la fila no tiene archivo.
async function stream(row, opts = {}) {
  if (!row) return null;
  const prefix = opts.prefix || 'archivo';

  if (DRIVER === 'r2' && row[`${prefix}_key`]) {
    // eslint-disable-next-line global-require
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const client = _getS3Client();
    try {
      const resp = await client.send(new GetObjectCommand({
        Bucket: _getBucket(),
        Key: row[`${prefix}_key`],
      }));
      return resp.Body;  // Readable directo desde S3, sin materializar
    } catch (err) {
      if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
        return null;
      }
      throw err;
    }
  }

  // Driver db O legacy: convertir base64 a Buffer
  const data = row[`${prefix}_data`];
  if (!data) return null;
  return Readable.from([Buffer.from(data, 'base64')]);
}

// Borra el archivo del storage externo.
//
// Driver db: no-op. Las columnas viven y mueren con la fila a través de
// soft-delete (`deleted_at`).
// Driver r2: hace DeleteObject si la fila tiene `${prefix}_key` seteado.
//   Idempotente: NoSuchKey se trata como éxito (R2 ya borró el objeto).
async function remove(row, opts = {}) {
  if (DRIVER === 'db') return;
  if (!row) return;
  const prefix = opts.prefix || 'archivo';
  const key = row[`${prefix}_key`];
  if (!key) return;

  // eslint-disable-next-line global-require
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = _getS3Client();
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: _getBucket(),
      Key: key,
    }));
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
      return;  // ya estaba borrado
    }
    throw err;
  }
}

module.exports = {
  put,
  get,
  stream,
  remove,
  // Exposed para tests y observabilidad.
  _DRIVER: DRIVER,
  // Reset del singleton para tests (jest.resetModules es alternativa).
  _resetS3ClientForTest: () => { _s3Client = null; _s3LoadError = null; },
  _setS3ClientForTest: (mock) => { _s3Client = mock; _s3LoadError = null; },
};
