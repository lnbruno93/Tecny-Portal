// Rutas de 2FA — montadas en /api/auth/2fa (requireAuth).
//
// Flow del setup:
//   1. POST /setup → genera secret + URI otpauth + recovery codes (plain),
//      los persiste cifrados (recovery hashed). enabled_at queda NULL.
//      Frontend muestra QR + recovery codes para que el user los guarde.
//   2. POST /enable { code } → user escanea QR con la app, ingresa el
//      primer código TOTP de 6 dígitos. Si verifica, enabled_at = NOW().
//      Desde acá el login va a exigir 2FA.
//   3. POST /disable { code } → desactiva 2FA. Requiere código actual TOTP
//      o recovery code (defense vs alguien que tomó la sesión sin saber el cel).
//   4. POST /regenerate-recovery { code } → nuevos 8 codes, invalida los viejos.
//
// El consumidor del flow de login (POST /api/auth/login) consulta esta tabla
// para saber si el user tiene 2FA enabled — ver auth.js.

const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { z } = require('zod');
const {
  encryptSecret,
  decryptSecret,
  generateSecret,
  buildOtpAuthUri,
  verifyToken,
  generateRecoveryCodes,
  hashRecoveryCodes,
  findRecoveryCodeIndex,
} = require('../lib/twoFa');

// ─── Schemas ───
const enableSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Código debe ser 6 dígitos'),
}).strict();

// Disable y regenerate aceptan código TOTP o recovery code. Validamos formato
// genérico (string no vacío) y dejamos que la lib distinga.
const codeSchema = z.object({
  code: z.string().min(6).max(20),
}).strict();

// ─── Helpers ───

// Cargar el row de 2FA del user actual. Devuelve null si no existe.
async function load2fa(userId) {
  const { rows } = await db.query(
    'SELECT user_id, secret_encrypted, recovery_codes, enabled_at, last_used_at FROM user_2fa WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

// Verifica un código (TOTP o recovery). Si recovery match, "quema" el code
// (reemplaza por null en el array). Devuelve { ok, kind: 'totp' | 'recovery' | null }.
async function verifyAny(row, code) {
  if (!row) return { ok: false, kind: null };
  // 1) Probar como TOTP (6 dígitos).
  if (/^\d{6}$/.test(code)) {
    const secret = decryptSecret(row.secret_encrypted);
    if (verifyToken(secret, code)) {
      return { ok: true, kind: 'totp' };
    }
  }
  // 2) Probar como recovery code (formato XXXX-XXXX-XX, pero aceptamos
  //    variaciones de mayúsculas / con-sin guiones).
  const idx = await findRecoveryCodeIndex(code, row.recovery_codes);
  if (idx >= 0) {
    // Marcar el code como usado (reemplazar hash por string vacío en su posición).
    // Usamos '' en lugar de NULL porque text[] no acepta NULL elements por default.
    const newCodes = row.recovery_codes.slice();
    newCodes[idx] = '';
    await db.query(
      'UPDATE user_2fa SET recovery_codes = $1, last_used_at = NOW() WHERE user_id = $2',
      [newCodes, row.user_id]
    );
    return { ok: true, kind: 'recovery' };
  }
  return { ok: false, kind: null };
}

// Marca last_used_at sin tocar recovery codes (TOTP success).
async function touchLastUsed(userId) {
  await db.query('UPDATE user_2fa SET last_used_at = NOW() WHERE user_id = $1', [userId]);
}

// ─── GET /status — estado del 2FA del user actual ───
// Devuelve: { configured: bool, enabled: bool, enabled_at, last_used_at,
//             recovery_codes_remaining: int }
router.get('/status', async (req, res, next) => {
  try {
    const row = await load2fa(req.user.id);
    if (!row) {
      return res.json({
        configured: false,
        enabled: false,
        enabled_at: null,
        last_used_at: null,
        recovery_codes_remaining: 0,
      });
    }
    res.json({
      configured: true,
      enabled: !!row.enabled_at,
      enabled_at: row.enabled_at,
      last_used_at: row.last_used_at,
      recovery_codes_remaining: row.recovery_codes.filter(c => c && c.length > 0).length,
    });
  } catch (err) { next(err); }
});

// ─── POST /setup — genera secret + recovery codes ───
// Idempotente: si ya hay row pero NO está enabled, lo reemplaza (re-setup).
// Si ya está enabled, devuelve 409 — primero hay que disable.
router.post('/setup', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT enabled_at FROM user_2fa WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (existing.rows[0]?.enabled_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '2FA ya está activado. Desactivá primero si querés re-setupear.' });
    }

    const secret = generateSecret();
    const secretEnc = encryptSecret(secret);
    const recovery = generateRecoveryCodes();
    const recoveryHashed = await hashRecoveryCodes(recovery);
    const otpUri = buildOtpAuthUri(secret, req.user.username);

    await client.query(
      `INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_encrypted = EXCLUDED.secret_encrypted,
             recovery_codes   = EXCLUDED.recovery_codes,
             enabled_at       = NULL,
             last_used_at     = NULL`,
      [req.user.id, secretEnc, recoveryHashed]
    );
    // Audit log SIN secret ni recovery — solo el evento.
    await audit(client, 'user_2fa', 'INSERT', req.user.id,
                { despues: { action: 'setup_initiated' }, user_id: req.user.id });
    await client.query('COMMIT');

    // Devolver secret + URI + recovery codes EN PLAIN una sola vez.
    // El frontend NO los persiste — los muestra al user para que los copie.
    res.json({
      secret,           // base32, mostrar como fallback si el QR falla
      otpauth_uri: otpUri, // para generar QR
      recovery_codes: recovery, // 8 codes plain para que el user los guarde
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ─── POST /enable — confirmar setup con primer código ───
router.post('/enable', validate(enableSchema), async (req, res, next) => {
  try {
    const row = await load2fa(req.user.id);
    if (!row) return res.status(400).json({ error: 'Hacé setup primero.' });
    if (row.enabled_at) return res.status(409).json({ error: '2FA ya está activado.' });

    const secret = decryptSecret(row.secret_encrypted);
    if (!verifyToken(secret, req.body.code)) {
      return res.status(400).json({ error: 'Código incorrecto. Verificá que el reloj del cel esté sincronizado.' });
    }

    await db.query('UPDATE user_2fa SET enabled_at = NOW(), last_used_at = NOW() WHERE user_id = $1', [req.user.id]);
    await audit('user_2fa', 'UPDATE', req.user.id,
                { despues: { action: 'enabled' }, user_id: req.user.id });
    res.json({ ok: true, enabled_at: new Date().toISOString() });
  } catch (err) { next(err); }
});

// ─── POST /disable — desactivar 2FA ───
router.post('/disable', validate(codeSchema), async (req, res, next) => {
  try {
    const row = await load2fa(req.user.id);
    if (!row || !row.enabled_at) {
      return res.status(400).json({ error: '2FA no está activado.' });
    }
    const { ok } = await verifyAny(row, req.body.code);
    if (!ok) return res.status(400).json({ error: 'Código incorrecto.' });

    await db.query('DELETE FROM user_2fa WHERE user_id = $1', [req.user.id]);
    await audit('user_2fa', 'DELETE', req.user.id,
                { antes: { enabled_at: row.enabled_at }, despues: { action: 'disabled' }, user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /regenerate-recovery — nuevos 8 codes, invalida los viejos ───
router.post('/regenerate-recovery', validate(codeSchema), async (req, res, next) => {
  try {
    const row = await load2fa(req.user.id);
    if (!row || !row.enabled_at) {
      return res.status(400).json({ error: '2FA no está activado.' });
    }
    const { ok } = await verifyAny(row, req.body.code);
    if (!ok) return res.status(400).json({ error: 'Código incorrecto.' });

    const recovery = generateRecoveryCodes();
    const hashed = await hashRecoveryCodes(recovery);
    await db.query('UPDATE user_2fa SET recovery_codes = $1 WHERE user_id = $2', [hashed, req.user.id]);
    await audit('user_2fa', 'UPDATE', req.user.id,
                { despues: { action: 'recovery_regenerated' }, user_id: req.user.id });
    res.json({ recovery_codes: recovery });
  } catch (err) { next(err); }
});

// Re-export helper para que auth.js pueda chequear 2FA durante login.
module.exports = router;
module.exports.load2fa = load2fa;
module.exports.verifyAny = verifyAny;
module.exports.touchLastUsed = touchLastUsed;
