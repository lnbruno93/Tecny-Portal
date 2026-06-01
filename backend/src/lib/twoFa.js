// 2FA TOTP — helpers para Time-based One-Time Password (RFC 6238).
// Compatible con Google Authenticator, Authy, 1Password, Microsoft
// Authenticator, etc.
//
// Decisiones durables:
//   · TOTP en lugar de SMS — gratis, seguro, sin SIM swap risk.
//   · `otplib` como dep (más moderno que speakeasy, mantenido activamente).
//   · Secret cifrado at-rest con AES-256-GCM. Si la DB se filtra sin la
//     `TWOFA_ENCRYPTION_KEY`, los secrets siguen ilegibles.
//   · Recovery codes hasheados con bcrypt (mismo costo que passwords).
//     8 codes de 10 chars alfanumérico. Un uso cada uno; al verificarse,
//     el hash se reemplaza por null en el array (preserva posición para
//     que el frontend sepa cuáles quedan).
//   · Window: ±1 step (30s) para tolerar clock drift entre cel y server.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');

// Configuración del generador TOTP — step=30s, digits=6, window=1 (±30s para
// drift de reloj). speakeasy expone esto por-llamada en lugar de config global.
const TOTP_OPTS = { encoding: 'base32', step: 30, digits: 6, window: 1 };

// ─────────── Encryption del secret ───────────
// AES-256-GCM con la key del env. Si la key cambia, los secrets cifrados
// quedan ilegibles (rotación requiere migración).
//
// Formato del bytea persistido: [12 bytes IV][16 bytes auth tag][ciphertext]
// Esto deja todo en un solo blob — al desencriptar splittear los tres.
const KEY_HEX = process.env.TWOFA_ENCRYPTION_KEY;
function getKey() {
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    throw new Error('TWOFA_ENCRYPTION_KEY debe ser un hex string de 64 chars (32 bytes). Generá con: openssl rand -hex 32');
  }
  return Buffer.from(KEY_HEX, 'hex');
}

function encryptSecret(secret) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]); // 12 + 16 + len(secret)
}

function decryptSecret(blob) {
  const key = getKey();
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─────────── Generación de secret + URI para QR ───────────
// El secret se persiste cifrado. La URI otpauth:// se le devuelve al user
// UNA SOLA VEZ durante el setup — desde ahí el frontend genera el QR para
// scanear con la app.
function generateSecret() {
  // speakeasy devuelve { ascii, hex, base32, otpauth_url }. Usamos base32.
  return speakeasy.generateSecret({ length: 20, name: 'iPro Portal' }).base32;
}

function buildOtpAuthUri(secret, username, issuer = 'iPro Portal') {
  return speakeasy.otpauthURL({
    secret,
    label: `${issuer}:${username}`,
    issuer,
    encoding: 'base32',
  });
}

// ─────────── Verificación del token ───────────
// Tolera ±1 step para clock drift. Devuelve true si el código es válido
// para el secret + el momento actual (o ±30s).
function verifyToken(secret, token) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;
  try {
    return speakeasy.totp.verify({ secret, token: String(token), ...TOTP_OPTS });
  } catch {
    return false;
  }
}

// ─────────── Helper para tests: generar token TOTP actual ───────────
// Útil para tests del backend (en producción este código vive en el cel del user).
function generateTokenForTest(secret) {
  return speakeasy.totp({ secret, encoding: 'base32', step: 30, digits: 6 });
}

// ─────────── Recovery codes ───────────
// 8 codes alfanuméricos de 10 chars (44 bits de entropía c/u — más que
// suficiente vs brute force con bcrypt+rate limit). Formato: XXXX-XXXX-XX
// para legibilidad al copiar/escribir a mano.
function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // 10 chars hex (5 bytes). Formateamos como XXXX-XXXX-XX.
    const hex = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 10)}`);
  }
  return codes;
}

async function hashRecoveryCodes(codes) {
  return Promise.all(codes.map(c => bcrypt.hash(c, 10)));
}

// Verifica un recovery code contra el array de hashes. Devuelve el INDEX
// del code matcheado (para que el caller lo "queme" reemplazando por null),
// o -1 si no matchea ninguno.
async function findRecoveryCodeIndex(plainCode, hashes) {
  if (!plainCode) return -1;
  const normalized = String(plainCode).trim().toUpperCase();
  for (let i = 0; i < hashes.length; i++) {
    if (!hashes[i]) continue; // ya usado (null)
    if (await bcrypt.compare(normalized, hashes[i])) return i;
  }
  return -1;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  generateSecret,
  buildOtpAuthUri,
  verifyToken,
  generateTokenForTest,
  generateRecoveryCodes,
  hashRecoveryCodes,
  findRecoveryCodeIndex,
};
