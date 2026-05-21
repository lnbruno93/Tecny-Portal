/**
 * Migración completa: Google Sheets → PostgreSQL
 *
 * Sheets migradas:
 *   Users!A:F          → users + user_permissions
 *   Contactos!A:D      → contactos
 *   Movimientos_Deudas!A:G       → movimientos_deudas
 *   Movimientos_Inversiones!A:F  → movimientos_inversiones
 *   Envios!A:M         → envios
 *   Envios_Items!A:F   → envio_items
 *
 * Uso:
 *   node scripts/migrate-from-sheets.js
 *   node scripts/migrate-from-sheets.js --dry-run   (solo muestra qué importaría)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Configuración ────────────────────────────────────────────
// ⚠️  IMPORTANTE: rotar la API key de Google Cloud Console (la anterior
//    estuvo hardcodeada en el repo — debe revocarse inmediatamente).
//    Nueva clave: configurar en .env como SHEETS_API_KEY
const API_KEY = process.env.SHEETS_API_KEY;
if (!API_KEY) {
  console.error('ERROR: SHEETS_API_KEY no configurada en .env');
  process.exit(1);
}

const CAJAS_ID  = '176tDFnaKyKSJYJlEWGpW02ekdhhy6R_rIEXbUnSCSKU';
const USERS_ID  = '1KdBAlJ17uOu1DDg5ewT1E2HkH26EBNcpPZ1kNhyKinc';
const ENVIOS_ID = '1cDAByiatmp0LmDWUN7mau4oUAyfV2UwEWu6_iJf-cCo';
const TOOLS     = ['cotizador','financiera','cajas','envios','usuarios'];

// ── Helpers ──────────────────────────────────────────────────
async function fetchSheet(sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API error (${range}): ${err}`);
  }
  const data = await res.json();
  return data.values || [];
}

function parsePerms(str) {
  const perms = {};
  TOOLS.forEach(t => perms[t] = false);
  if (!str) return perms;
  str.split(',').map(s => s.trim()).forEach(t => { if (perms[t] !== undefined) perms[t] = true; });
  return perms;
}

function toDate(str) {
  if (!str) return null;
  // Acepta DD/MM/YYYY, YYYY-MM-DD, y variantes
  const parts = str.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  return str.substring(0, 10);
}

function toNum(str) {
  const n = parseFloat((str || '0').toString().replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function log(msg) { console.log(msg); }
function warn(msg) { console.warn('  ⚠️  ' + msg); }

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log(DRY_RUN ? '\n🔍 MODO DRY-RUN — no se escribirá nada en la DB\n' : '\n🚀 Iniciando migración...\n');

  log('Leyendo datos de Google Sheets...');
  const [rowsUsers, rowsContactos, rowsDeudas, rowsInversiones, rowsEnvios, rowsItems] =
    await Promise.all([
      fetchSheet(USERS_ID,  'Users!A:F'),
      fetchSheet(CAJAS_ID,  'Contactos!A:D'),
      fetchSheet(CAJAS_ID,  'Movimientos_Deudas!A:G'),
      fetchSheet(CAJAS_ID,  'Movimientos_Inversiones!A:F'),
      fetchSheet(ENVIOS_ID, 'Envios!A:M'),
      fetchSheet(ENVIOS_ID, 'Envios_Items!A:F'),
    ]);

  // Parsear
  const users = rowsUsers
    .filter(r => r[0] && r[0] !== 'ID')
    .map(r => ({
      sheetId:  String(r[0]),
      nombre:   r[1] || '',
      username: (r[2] || '').toLowerCase().trim(),
      pass:     r[3] || '',
      role:     (r[4] || 'op').toLowerCase() === 'admin' ? 'admin' : 'op',
      perms:    parsePerms(r[5] || ''),
    }));

  const contactos = rowsContactos
    .filter(r => r[0] && r[0] !== 'ID')
    .map(r => ({
      sheetId:  String(r[0]),
      nombre:   r[1] || '',
      apellido: r[2] || null,
      tipo:     (r[3] || 'cliente').toLowerCase(),
    }));

  const deudas = rowsDeudas
    .filter(r => r[0] && r[0] !== 'ID')
    .map(r => ({
      sheetId:     String(r[0]),
      fecha:       toDate(r[1]),
      contactoSId: String(r[2] || ''),
      tipo:        (r[3] || '').toLowerCase(),
      monto_ars:   toNum(r[4]),
      monto_usd:   toNum(r[5]),
      concepto:    r[6] || null,
    }));

  const inversiones = rowsInversiones
    .filter(r => r[0] && r[0] !== 'ID')
    .map(r => ({
      sheetId:     String(r[0]),
      fecha:       toDate(r[1]),
      contactoSId: String(r[2] || ''),
      monto:       toNum(r[4]),
      tasa:        r[5] || null,
    }));

  const envios = rowsEnvios
    .filter(r => r[0] && r[0] !== 'ID')
    .map(r => ({
      sheetId:       String(r[0]),
      fecha:         toDate(r[1]),
      cliente:       r[2] || '',
      telefono:      r[3] || null,
      direccion:     r[4] || '',
      barrio:        r[5] || null,
      costo_envio:   toNum(r[6]),
      total_cobrado: toNum(r[7]),
      horario:       r[8] || null,
      operador:      r[9] || null,
      notas:         r[10] || null,
      estado:        ['Pendiente','En camino','Entregado','Cancelado'].includes(r[11]) ? r[11] : 'Pendiente',
      prioridad:     ['Alta','Media','Baja'].includes(r[12]) ? r[12] : null,
    }));

  const items = rowsItems
    .filter(r => r[0] && r[0] !== 'ID')
    .map(r => ({
      sheetId:    String(r[0]),
      envioSId:   String(r[1] || ''),
      tipo:       ['producto','pago'].includes((r[2]||'').toLowerCase()) ? r[2].toLowerCase() : 'producto',
      descripcion: r[3] || null,
      monto:      toNum(r[4]),
      metodo_pago: r[5] || null,
    }));

  log(`Datos encontrados en Sheets:`);
  log(`  Usuarios:     ${users.length}`);
  log(`  Contactos:    ${contactos.length}`);
  log(`  Deudas:       ${deudas.length}`);
  log(`  Inversiones:  ${inversiones.length}`);
  log(`  Envíos:       ${envios.length}`);
  log(`  Items envíos: ${items.length}`);

  if (DRY_RUN) {
    log('\n--- Usuarios ---');
    users.forEach(u => log(`  ${u.username} (${u.role}) perms: ${Object.entries(u.perms).filter(([,v])=>v).map(([k])=>k).join(',')}`));
    log('\n--- Contactos ---');
    contactos.forEach(c => log(`  ${c.nombre} ${c.apellido||''} (${c.tipo})`));
    log('\n--- Envíos ---');
    envios.forEach(e => log(`  ${e.fecha} ${e.cliente} → ${e.estado}`));
    log('\nDry-run completo. Corré sin --dry-run para migrar.');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    log('\nMigrando a PostgreSQL...');

    // ── Usuarios ──────────────────────────────────────────────
    const userIdMap = {}; // sheetId → db id
    let usersCreated = 0, usersSkipped = 0;

    for (const u of users) {
      if (!u.username) { warn(`Usuario sin username (id sheet: ${u.sheetId}) — omitido`); continue; }

      const { rows: existing } = await client.query(
        'SELECT id FROM users WHERE username = $1', [u.username]
      );

      if (existing.length > 0) {
        userIdMap[u.sheetId] = existing[0].id;
        usersSkipped++;
        continue;
      }

      const hash = u.pass ? await bcrypt.hash(u.pass, 10) : await bcrypt.hash('cambiar123', 10);
      const { rows } = await client.query(
        'INSERT INTO users (nombre, username, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [u.nombre, u.username, hash, u.role]
      );
      const dbId = rows[0].id;
      userIdMap[u.sheetId] = dbId;

      for (const tool of TOOLS) {
        await client.query(
          'INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [dbId, tool, u.perms[tool] === true]
        );
      }
      usersCreated++;
    }
    log(`  Usuarios: ${usersCreated} creados, ${usersSkipped} ya existían`);

    // ── Contactos ─────────────────────────────────────────────
    const contactoIdMap = {}; // sheetId → db id
    let contactosCreated = 0;
    const TIPOS_VALIDOS = ['amigo','familiar','cliente','inversor','ipro team'];

    for (const c of contactos) {
      if (!c.nombre) { warn(`Contacto sin nombre (id: ${c.sheetId}) — omitido`); continue; }
      const tipo = TIPOS_VALIDOS.includes(c.tipo) ? c.tipo : 'cliente';

      const { rows } = await client.query(
        'INSERT INTO contactos (nombre, apellido, tipo) VALUES ($1,$2,$3) RETURNING id',
        [c.nombre, c.apellido || null, tipo]
      );
      contactoIdMap[c.sheetId] = rows[0].id;
      contactosCreated++;
    }
    log(`  Contactos: ${contactosCreated} migrados`);

    // ── Movimientos de deudas ─────────────────────────────────
    let deudasOk = 0, deudasSkip = 0;

    for (const d of deudas) {
      const contactoId = contactoIdMap[d.contactoSId];
      if (!contactoId) { warn(`Deuda ${d.sheetId}: contacto ${d.contactoSId} no encontrado — omitida`); deudasSkip++; continue; }
      if (!d.fecha)    { warn(`Deuda ${d.sheetId}: fecha inválida — omitida`); deudasSkip++; continue; }
      if (!['debe','pago'].includes(d.tipo)) { warn(`Deuda ${d.sheetId}: tipo "${d.tipo}" inválido — omitida`); deudasSkip++; continue; }

      await client.query(
        'INSERT INTO movimientos_deudas (fecha, contacto_id, tipo, monto_ars, monto_usd, concepto) VALUES ($1,$2,$3,$4,$5,$6)',
        [d.fecha, contactoId, d.tipo, d.monto_ars, d.monto_usd, d.concepto]
      );
      deudasOk++;
    }
    log(`  Deudas: ${deudasOk} migradas, ${deudasSkip} omitidas`);

    // ── Movimientos de inversiones ────────────────────────────
    let invOk = 0, invSkip = 0;

    for (const inv of inversiones) {
      const contactoId = contactoIdMap[inv.contactoSId];
      if (!contactoId) { warn(`Inversión ${inv.sheetId}: contacto ${inv.contactoSId} no encontrado — omitida`); invSkip++; continue; }
      if (!inv.fecha)  { warn(`Inversión ${inv.sheetId}: fecha inválida — omitida`); invSkip++; continue; }

      await client.query(
        'INSERT INTO movimientos_inversiones (fecha, contacto_id, monto, tasa) VALUES ($1,$2,$3,$4)',
        [inv.fecha, contactoId, inv.monto, inv.tasa]
      );
      invOk++;
    }
    log(`  Inversiones: ${invOk} migradas, ${invSkip} omitidas`);

    // ── Envíos + Items ────────────────────────────────────────
    const envioIdMap = {}; // sheetId → db id
    let enviosOk = 0, enviosSkip = 0, itemsOk = 0;

    for (const e of envios) {
      if (!e.cliente || !e.fecha) { warn(`Envío ${e.sheetId}: datos incompletos — omitido`); enviosSkip++; continue; }
      if (!e.direccion) e.direccion = 'Sin dirección';

      const { rows } = await client.query(
        `INSERT INTO envios (fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado, horario, operador, notas, estado, prioridad)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [e.fecha, e.cliente, e.telefono, e.direccion, e.barrio, e.costo_envio, e.total_cobrado,
         e.horario, e.operador, e.notas, e.estado, e.prioridad]
      );
      envioIdMap[e.sheetId] = rows[0].id;
      enviosOk++;
    }

    for (const item of items) {
      const envioId = envioIdMap[item.envioSId];
      if (!envioId) continue;

      await client.query(
        'INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago) VALUES ($1,$2,$3,$4,$5)',
        [envioId, item.tipo, item.descripcion, item.monto, item.metodo_pago]
      );
      itemsOk++;
    }
    log(`  Envíos: ${enviosOk} migrados, ${enviosSkip} omitidos`);
    log(`  Items de envíos: ${itemsOk} migrados`);

    await client.query('COMMIT');
    log('\n✅ Migración completada exitosamente.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Error — ROLLBACK completo. No se escribió nada.');
    console.error(err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
