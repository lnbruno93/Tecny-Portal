/**
 * Códigos de error estables para responses 4xx de los endpoints de auth.
 *
 * Razón: los clientes (frontend, futuros móviles, integraciones) NO pueden
 * matchear por `error` string — esos son user-facing y pueden cambiar:
 *
 *   - i18n futuro (en, pt-br, ...)
 *   - Refactor minor del wording (ej. "Código 2FA incorrecto." → "Código de
 *     2FA inválido.")
 *   - A/B testing de mensajes
 *
 * El campo `code` es estable, machine-friendly, y permite branching limpio
 * en el frontend. Los clientes deben preferir `code` sobre regex/string match.
 *
 * Auditoría 2026-06-18 #318: el modal cambiar-contraseña dependía de
 * /2FA/i.test(body.error) para distinguir "2FA inválido" de "password
 * inválida" — si el wording del backend cambia, falla silenciosa y el user
 * ve error rojo en el campo equivocado. Fix con códigos estables.
 *
 * Convención del enum:
 *   - SCREAMING_SNAKE_CASE
 *   - Empieza con el sustantivo del recurso afectado o la acción.
 *   - Documentar qué HTTP status acompaña cada code.
 *
 * Si agregás un code nuevo:
 *   1. Agregalo acá con doc del status + cuándo se dispara.
 *   2. Usalo en la ruta correspondiente: `res.status(N).json({ error, code: CODES.XXX })`.
 *   3. Si el frontend tiene branching por error, agregar el caso ahí también.
 *   4. Si exponemos un test que valida el shape, agregar coverage.
 */

const CODES = Object.freeze({
  // ─── Login ─────────────────────────────────────────────────────────────
  // 401 — credenciales inválidas O usuario no existe O lockout activo.
  // Anti-enum policy (H1 auditoría 2026-06): mismo code + mismo mensaje
  // para los 3 casos para que un atacante no pueda enumerar usuarios.
  INVALID_CREDENTIALS:        'INVALID_CREDENTIALS',

  // ─── 2FA gate (login y change-password) ───────────────────────────────
  // 401 con `twofa_required: true` — el user tiene 2FA enabled pero no mandó
  // el code. El frontend muestra el input de 2FA y reintenta.
  TWOFA_REQUIRED:             'TWOFA_REQUIRED',
  // 401 — el user mandó un code de 2FA pero es incorrecto / vencido / ya usado.
  INVALID_TWOFA_CODE:         'INVALID_TWOFA_CODE',

  // ─── Change-password ──────────────────────────────────────────────────
  // 401 — la contraseña actual no matchea (distinto a INVALID_CREDENTIALS
  // porque acá el user YA está autenticado vía JWT, solo está reverificando).
  INVALID_CURRENT_PASSWORD:   'INVALID_CURRENT_PASSWORD',

  // ─── Identidad ────────────────────────────────────────────────────────
  // 404 — el user_id del JWT no resolvió a ningún user vivo (deleted_at IS
  // NULL). Caso edge: token válido pero user borrado entre login y la
  // próxima request. Frontend debería forzar logout.
  USER_NOT_FOUND:             'USER_NOT_FOUND',
});

module.exports = { CODES };
