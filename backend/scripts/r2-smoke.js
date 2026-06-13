// Smoke test para Cloudflare R2 — verificar conectividad + credenciales antes
// de meter el driver en el path crítico.
//
// Uso (local):
//   node backend/scripts/r2-smoke.js
//
// Requiere env vars seteadas (puede ser via .env.local o export):
//   R2_ENDPOINT
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET
//
// Hace 4 operaciones idempotentes:
//   1. PUT un objeto "smoke-test.txt" con contenido conocido
//   2. GET el mismo objeto y verifica que el contenido matche
//   3. LIST el bucket y reporta el count de objetos
//   4. DELETE el objeto creado
//
// Si todo pasa: imprime "OK" y exit 0. Si falla: imprime el error y exit 1.
// Apunta al bucket que esté configurado — corré con R2_BUCKET=ipro-staging
// primero, después con ipro-prod.

/* eslint-disable no-console */

const path = require('path');

// Cargar .env si existe (no obligatorio, las vars pueden venir via export)
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
} catch { /* ignore */ }

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const REQUIRED = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Faltan env vars:', missing.join(', '));
  console.error('   Setealas y volvé a correr el script.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.R2_BUCKET;
const KEY = `smoke/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
const CONTENT = `R2 smoke test ${new Date().toISOString()}\n` + 'x'.repeat(1000);

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function main() {
  console.log(`📦 Bucket: ${BUCKET}`);
  console.log(`🔑 Endpoint: ${process.env.R2_ENDPOINT}`);
  console.log('');

  // 1. PUT
  console.log(`1️⃣  PUT ${KEY} (${CONTENT.length} bytes)...`);
  const t0 = Date.now();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: KEY,
    Body: CONTENT,
    ContentType: 'text/plain',
  }));
  console.log(`   ✓ ${Date.now() - t0}ms`);

  // 2. GET + verificar contenido
  console.log(`2️⃣  GET ${KEY}...`);
  const t1 = Date.now();
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
  const got = await streamToString(resp.Body);
  if (got !== CONTENT) {
    throw new Error(`Content mismatch — esperaba ${CONTENT.length} bytes, recibí ${got.length}`);
  }
  console.log(`   ✓ ${Date.now() - t1}ms (contenido matchea)`);

  // 3. LIST (chequeamos que el objeto aparezca)
  console.log(`3️⃣  LIST bucket (prefix=smoke/)...`);
  const t2 = Date.now();
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: 'smoke/',
    MaxKeys: 100,
  }));
  const count = list.Contents?.length || 0;
  console.log(`   ✓ ${Date.now() - t2}ms (${count} objeto${count === 1 ? '' : 's'} con prefix smoke/)`);

  // 4. DELETE
  console.log(`4️⃣  DELETE ${KEY}...`);
  const t3 = Date.now();
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }));
  console.log(`   ✓ ${Date.now() - t3}ms`);

  console.log('');
  console.log('✅ Smoke test OK — R2 está accesible y las credenciales funcionan.');
}

main().catch(err => {
  console.error('');
  console.error('❌ Smoke test FALLÓ');
  console.error('');
  console.error('Error:', err.message);
  if (err.name === 'CredentialsProviderError' || err.name === 'InvalidAccessKeyId') {
    console.error('');
    console.error('💡 Las credenciales no son válidas. Verificá R2_ACCESS_KEY_ID y');
    console.error('   R2_SECRET_ACCESS_KEY contra lo que generó Cloudflare.');
  } else if (err.name === 'NoSuchBucket') {
    console.error('');
    console.error(`💡 El bucket "${BUCKET}" no existe. Creá el bucket en Cloudflare R2 →`);
    console.error('   Overview → Create bucket.');
  } else if (err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    console.error('');
    console.error('💡 No se pudo conectar al endpoint. Verificá R2_ENDPOINT:');
    console.error(`   ${process.env.R2_ENDPOINT}`);
  }
  process.exit(1);
});
