#!/usr/bin/env node
/**
 * setSuperAdmin.js — toggle `users.is_super_admin` con audit trail.
 *
 * Uso:
 *   node backend/scripts/setSuperAdmin.js <user_id> [--revoke]
 *
 * Sin --revoke: setea is_super_admin = true (otorga acceso al admin app).
 * Con --revoke: setea is_super_admin = false.
 *
 * Idempotente:
 *   - Si el bit ya está en el valor target, no hace nada (skip INSERT a
 *     tenant_admin_actions). Útil para correr en deploys sin spam de
 *     "ya estaba como super-admin".
 *
 * Audit trail:
 *   - Cada cambio efectivo se loguea en tenant_admin_actions con
 *     action='bootstrap_super_admin'. NO requiere tenant — usamos
 *     tenant_id del default tenant del user (típicamente 1 = Tecny).
 *
 * Seguridad:
 *   - Solo accesible vía SSH a Railway con DATABASE_URL admin. NO
 *     expuesto vía API. Esto es a propósito — el super-admin solo
 *     se otorga manualmente.
 *   - El script REQUIERE confirmación interactiva en TTY (excepto si
 *     --yes), para evitar typos catastróficos.
 *
 * Cache invalidation:
 *   - Después del UPDATE, invalida userAuthCache del user para que el
 *     cambio aplique en la próxima request (sin esperar 60s del TTL).
 *
 * Exit codes:
 *   0 = OK (cambio aplicado o no-op idempotente)
 *   1 = error (user no existe, DB no responde, etc)
 *   2 = usuario canceló la confirmación interactiva
 */

require('dotenv').config({ override: process.env.NODE_ENV !== 'production' });

const readline = require('readline');
const db = require('../src/config/database');
const userAuthCache = require('../src/lib/userAuthCache');

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const userId = Number(args.find((a) => /^\d+$/.test(a)));
  const revoke = args.includes('--revoke');
  const yes    = args.includes('--yes');

  if (!Number.isInteger(userId) || userId <= 0) {
    console.error('Uso: node setSuperAdmin.js <user_id> [--revoke] [--yes]');
    process.exit(1);
  }

  // 1. Verificar que el user existe + leer estado actual.
  const { rows: userRows } = await db.query(
    `SELECT id, username, email, is_super_admin
       FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  if (!userRows[0]) {
    console.error(`User id=${userId} no existe o está soft-deleted`);
    process.exit(1);
  }
  const user = userRows[0];
  const targetValue = !revoke;

  // 2. Idempotencia: skip si ya está en el valor target.
  if (user.is_super_admin === targetValue) {
    console.log(
      `No-op: user ${userId} (${user.username}) ya tiene is_super_admin=${targetValue}.`
    );
    await db.end();
    process.exit(0);
  }

  // 3. Confirmación interactiva (a menos que --yes).
  if (!yes && process.stdin.isTTY) {
    const verb = targetValue ? 'OTORGAR' : 'REVOCAR';
    const ans = await ask(
      `\n⚠️  ${verb} super-admin a user id=${userId} (${user.username} / ${user.email})?\n` +
      `   Esto le da acceso CROSS-TENANT a /api/super-admin/* y al admin app.\n` +
      `   Confirmar tipeando "${verb.toLowerCase()}": `
    );
    if (ans !== verb.toLowerCase()) {
      console.log('Cancelado por el usuario.');
      await db.end();
      process.exit(2);
    }
  }

  // 4. Resolver tenant_id del user (para el audit trail).
  // Si tiene múltiples tenants, usamos el primero (tipicamente el default).
  const { rows: tuRows } = await db.query(
    `SELECT tenant_id FROM tenant_users WHERE user_id = $1 ORDER BY tenant_id LIMIT 1`,
    [userId]
  );
  const auditTenantId = tuRows[0]?.tenant_id || 1; // fallback a tenant 1

  // 5. UPDATE + audit en una sola tx.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET is_super_admin = $1 WHERE id = $2`,
      [targetValue, userId]
    );
    await client.query(
      `INSERT INTO tenant_admin_actions
         (tenant_id, super_admin_user_id, action, before_state, after_state, reason)
       VALUES ($1, $2, 'bootstrap_super_admin', $3::jsonb, $4::jsonb, $5)`,
      [
        auditTenantId,
        userId,    // self-action: el script lo dispara el operador con acceso DB
        JSON.stringify({ is_super_admin: user.is_super_admin }),
        JSON.stringify({ is_super_admin: targetValue }),
        `setSuperAdmin.js ${revoke ? '--revoke' : ''} via script`,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  // 6. Invalidar cache para que aplique YA (sin esperar TTL).
  try {
    await userAuthCache.invalidateUserAuth(userId);
  } catch (e) {
    console.warn('Cache invalidation falló (no crítico):', e.message);
  }

  console.log(`\n✅ user ${userId} (${user.username}): is_super_admin = ${targetValue}`);
  console.log('   Audit trail en tenant_admin_actions (action=bootstrap_super_admin).');
  await db.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
