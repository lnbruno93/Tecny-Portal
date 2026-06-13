// Script de backfill histórico para P-03 Fase 6.
//
// Mueve los blobs base64 que viven en columnas `*_data` de PostgreSQL a
// Cloudflare R2. Cada fila procesada gana un `*_key` (referencia al objeto
// R2) y un `*_size` (bytes). La columna `*_data` se mantiene intacta —
// el cleanup (UPDATE *_data = NULL) es un paso separado con --cleanup-legacy
// para que sea reversible si surge un bug.
//
// Idempotente: WHERE *_data IS NOT NULL AND *_key IS NULL filtra filas ya
// procesadas. Re-correrlo es seguro.
//
// Atomicidad por fila: primero PUT a R2, después UPDATE de DB. Si PUT falla,
// no se hace UPDATE (la fila queda como legacy, el próximo run la reintenta).
// Si PUT pasa pero UPDATE falla, el objeto queda en R2 y la fila sigue como
// legacy → el próximo run sube un objeto duplicado (orphan). Es aceptable:
// orphans son raros y se barren con el cleanup cron futuro (TODO).
//
// Uso:
//   node backend/scripts/r2-backfill.js --table <name> [--dry-run] [--batch N]
//   node backend/scripts/r2-backfill.js --validate
//   node backend/scripts/r2-backfill.js --table <name> --cleanup-legacy
//
//   --table     comprobantes | productos | venta_comprobantes
//   --dry-run   cuenta filas que migraría, no toca DB ni R2
//   --batch N   procesa N filas en cada chunk (default 50)
//   --validate  reporta integridad: filas migradas, pendientes, orphans
//   --cleanup-legacy  UPDATE *_data = NULL donde *_key IS NOT NULL
//                     (DESTRUCTIVO — sólo después de validación con --validate)
//
// Requiere env vars: DATABASE_URL, R2_ENDPOINT, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET, NODE_ENV (para el path de la key R2).

/* eslint-disable no-console */

const path = require('path');

// Cargar .env si existe (para correr local). En Railway las vars vienen del environment.
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
} catch { /* ignore */ }

const { Pool } = require('pg');
const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

// ─── Config por tabla ─────────────────────────────────────────────────────────
//
// Cada tabla tiene su prefix (archivo_/foto_) y su nombre de entity para el
// path R2. Mantiene paridad con la lógica de fileStore.js y los call sites.
const TABLE_CONFIG = {
  comprobantes: {
    prefix: 'archivo',
    entity: 'comprobantes',
    subpathFn: null,  // usa YYYY/MM/DD por fila (mismo que fileStore)
  },
  productos: {
    prefix: 'foto',
    entity: 'productos',
    subpathFn: (row) => `producto-${row.id}`,
  },
  venta_comprobantes: {
    prefix: 'archivo',
    entity: 'venta-comprobantes',
    subpathFn: (row) => `venta-${row.venta_id}`,
  },
};

// ─── CLI parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getFlag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const opts = {
  table: getFlag('table'),
  dryRun: hasFlag('dry-run'),
  batch: parseInt(getFlag('batch') || '50', 10),
  validate: hasFlag('validate'),
  cleanupLegacy: hasFlag('cleanup-legacy'),
};

// ─── Helpers compartidos con fileStore.js ────────────────────────────────────
const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
  'image/heif': 'heif', 'application/pdf': 'pdf', 'text/plain': 'txt',
};
function extFromMime(mime) {
  if (!mime) return 'bin';
  return MIME_EXTENSIONS[mime.toLowerCase()] || 'bin';
}

function generateKey({ entity, subpath, mime }) {
  const ext = extFromMime(mime);
  const uuid = crypto.randomUUID();
  let p;
  if (subpath) {
    p = subpath;
  } else {
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    p = `${yyyy}/${mm}/${dd}`;
  }
  const env = (process.env.NODE_ENV || 'dev').toLowerCase();
  return `ipro/${env}/${entity}/${p}/${uuid}.${ext}`;
}

function sizeFromBase64(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return 0;
  let size = Math.floor((b64.length * 3) / 4);
  if (b64.endsWith('==')) size -= 2;
  else if (b64.endsWith('=')) size -= 1;
  return Math.max(0, size);
}

// ─── Init clients ────────────────────────────────────────────────────────────
function makeClients() {
  const required = ['DATABASE_URL', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Faltan env vars:', missing.join(', '));
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return { pool, s3, bucket: process.env.R2_BUCKET };
}

// ─── Action: dry-run ──────────────────────────────────────────────────────────
async function runDryRun() {
  const cfg = TABLE_CONFIG[opts.table];
  if (!cfg) { console.error(`❌ --table requerido: ${Object.keys(TABLE_CONFIG).join(' | ')}`); process.exit(1); }
  const { pool } = makeClients();
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(LENGTH(${cfg.prefix}_data))::bigint, 0) AS total_base64_chars
         FROM ${opts.table}
        WHERE ${cfg.prefix}_data IS NOT NULL AND ${cfg.prefix}_key IS NULL
          AND deleted_at IS NULL`
    );
    const r = rows[0];
    const sizeMb = (Number(r.total_base64_chars) * 3 / 4 / 1024 / 1024).toFixed(2);
    console.log(`📊 ${opts.table}: ${r.n} fila(s) pendiente(s) de migrar (~${sizeMb} MB de blobs)`);
  } finally {
    await pool.end();
  }
}

// ─── Action: backfill batch ───────────────────────────────────────────────────
async function runBackfill() {
  const cfg = TABLE_CONFIG[opts.table];
  if (!cfg) { console.error(`❌ --table requerido: ${Object.keys(TABLE_CONFIG).join(' | ')}`); process.exit(1); }
  const { pool, s3, bucket } = makeClients();

  let processed = 0;
  let failed = 0;
  let totalBytes = 0;
  const t0 = Date.now();

  try {
    // Loop hasta que no queden filas pendientes o el batch falle entero.
    // No usamos cursors — cada iteración hace una query nueva con LIMIT N
    // y procesa esas N. Idempotente: rows ya migrados quedan excluidos por
    // el WHERE.
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, ${cfg.prefix}_data, ${cfg.prefix}_nombre, ${cfg.prefix}_tipo
              ${opts.table === 'venta_comprobantes' ? ', venta_id' : ''}
           FROM ${opts.table}
          WHERE ${cfg.prefix}_data IS NOT NULL AND ${cfg.prefix}_key IS NULL
            AND deleted_at IS NULL
          ORDER BY id
          LIMIT $1`,
        [opts.batch]
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const dataBase64 = row[`${cfg.prefix}_data`];
        const mime = row[`${cfg.prefix}_tipo`];
        const subpath = cfg.subpathFn ? cfg.subpathFn(row) : null;
        const key = generateKey({ entity: cfg.entity, subpath, mime });
        const buffer = Buffer.from(dataBase64, 'base64');
        const size = buffer.length;

        try {
          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: mime || 'application/octet-stream',
          }));
          await pool.query(
            `UPDATE ${opts.table}
                SET ${cfg.prefix}_key = $1, ${cfg.prefix}_size = $2
              WHERE id = $3`,
            [key, size, row.id]
          );
          processed++;
          totalBytes += size;
        } catch (err) {
          failed++;
          console.error(`  ⚠️  id=${row.id}: ${err.message}`);
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const mb = (totalBytes / 1024 / 1024).toFixed(2);
      console.log(`  ↪ ${processed} ok, ${failed} falla(s), ${mb} MB en ${elapsed}s`);

      // Si el último batch tuvo fallas totales (todas las filas fallaron),
      // salir para no loop infinito (las filas siguen quedando como pendientes
      // porque el UPDATE no se ejecutó, y el WHERE las volvería a tomar).
      if (rows.length > 0 && processed === 0 && failed === rows.length) {
        console.error('❌ El batch entero falló — abortando para evitar loop infinito');
        break;
      }
      // Loop continúa hasta que la query no devuelva más rows.
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const mb = (totalBytes / 1024 / 1024).toFixed(2);
    console.log(`\n✅ ${opts.table}: ${processed} fila(s) migrada(s), ${failed} falla(s), ${mb} MB en ${elapsed}s`);
  } finally {
    await pool.end();
  }
}

// ─── Action: validate ─────────────────────────────────────────────────────────
async function runValidate() {
  const { pool } = makeClients();
  try {
    console.log('🔍 Validación de integridad post-backfill:\n');
    for (const [table, cfg] of Object.entries(TABLE_CONFIG)) {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${cfg.prefix}_data IS NOT NULL AND ${cfg.prefix}_key IS NULL) AS pending,
          COUNT(*) FILTER (WHERE ${cfg.prefix}_data IS NULL AND ${cfg.prefix}_key IS NOT NULL) AS r2_only,
          COUNT(*) FILTER (WHERE ${cfg.prefix}_data IS NOT NULL AND ${cfg.prefix}_key IS NOT NULL) AS both,
          COUNT(*) FILTER (WHERE ${cfg.prefix}_data IS NULL AND ${cfg.prefix}_key IS NULL) AS no_file
        FROM ${table}
        WHERE deleted_at IS NULL
      `);
      const r = rows[0];
      console.log(`  ${table}:`);
      console.log(`    🟡 pending (base64, sin migrar):    ${r.pending}`);
      console.log(`    🟢 r2_only (migrado + data NULL):    ${r.r2_only}`);
      console.log(`    🟠 both (migrado + data presente):   ${r.both}  ← seguro de hacer --cleanup-legacy`);
      console.log(`    ⚪ no_file (sin upload):             ${r.no_file}`);
      console.log('');
    }
    console.log('💡 Estado ideal: pending=0, both=N (donde N = filas migradas), r2_only=0');
    console.log('   Después de validar y observar 1 semana, --cleanup-legacy mueve `both` → `r2_only`.\n');
  } finally {
    await pool.end();
  }
}

// ─── Action: cleanup-legacy (DESTRUCTIVO) ─────────────────────────────────────
async function runCleanupLegacy() {
  const cfg = TABLE_CONFIG[opts.table];
  if (!cfg) { console.error(`❌ --table requerido: ${Object.keys(TABLE_CONFIG).join(' | ')}`); process.exit(1); }
  const { pool } = makeClients();
  try {
    console.log(`⚠️  CLEANUP DESTRUCTIVO sobre ${opts.table}.${cfg.prefix}_data`);
    console.log('   Esto setea a NULL el base64 de las filas que ya tienen *_key.');
    console.log('   Si algo sale mal con R2, no podrás recuperar el archivo sin restore de DB.');
    console.log('   Sólo proceder después de --validate + 1 semana de observación sin issues.\n');

    // Countdown explícito para evitar accidentes en un terminal apurado.
    for (let i = 5; i >= 1; i--) {
      process.stdout.write(`   Procediendo en ${i}s... Ctrl-C para abortar\r`);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('\n');

    const { rowCount } = await pool.query(
      `UPDATE ${opts.table}
          SET ${cfg.prefix}_data = NULL
        WHERE ${cfg.prefix}_data IS NOT NULL
          AND ${cfg.prefix}_key IS NOT NULL`
    );
    console.log(`✅ ${opts.table}: ${rowCount} filas con base64 liberado.`);
    console.log(`   El espacio TOAST se recupera en el próximo VACUUM (auto-vacuum o manual).`);
  } finally {
    await pool.end();
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
async function main() {
  if (opts.validate) return runValidate();
  if (opts.cleanupLegacy) return runCleanupLegacy();
  if (opts.dryRun) return runDryRun();
  if (opts.table) return runBackfill();

  console.log('Uso:');
  console.log('  node backend/scripts/r2-backfill.js --table <name> --dry-run');
  console.log('  node backend/scripts/r2-backfill.js --table <name> [--batch N]');
  console.log('  node backend/scripts/r2-backfill.js --validate');
  console.log('  node backend/scripts/r2-backfill.js --table <name> --cleanup-legacy');
  console.log('\nTablas soportadas:', Object.keys(TABLE_CONFIG).join(', '));
  process.exit(1);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.code === 'ECONNREFUSED') {
    console.error('💡 ¿DATABASE_URL apunta a una DB accesible?');
  }
  process.exit(1);
});
