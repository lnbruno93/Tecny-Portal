/**
 * Política de contraseñas — mirror del backend (`backend/src/lib/password.js`).
 *
 * Portado desde frontend/src/lib/passwordPolicy.js (task #498).
 * Las reglas se DUPLICAN entre frontend/, admin-frontend/ y backend a
 * propósito: cada app frontend es independiente (bundle separado). Si las
 * reglas cambian en el backend, hay que cambiarlas en los 3 lados.
 *
 * Reglas actuales:
 *   - Mínimo 8 caracteres.
 *   - Al menos una letra (A-Z / a-z).
 *   - Al menos un número (0-9).
 */

export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_HAS_LETTER = /[A-Za-z]/;
export const PASSWORD_HAS_NUMBER = /[0-9]/;

export const PASSWORD_POLICY_HINT =
  `Mínimo ${MIN_PASSWORD_LENGTH} caracteres, con letra y número.`;

/**
 * Valida una password contra la política. Devuelve `null` si OK, o un string
 * con el primer error si falla. El orden de chequeos matchea el backend
 * (lib/password.js) para que el mensaje sea coherente cliente↔server.
 *
 * @param {string} pw
 * @returns {string|null}
 */
export function validatePasswordPolicy(pw) {
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
    return `Mínimo ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (!PASSWORD_HAS_LETTER.test(pw)) return 'Debe incluir al menos una letra';
  if (!PASSWORD_HAS_NUMBER.test(pw)) return 'Debe incluir al menos un número';
  return null;
}
