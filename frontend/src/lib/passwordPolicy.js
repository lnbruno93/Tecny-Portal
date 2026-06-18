/**
 * Política de contraseñas — mirror del backend (`backend/src/lib/password.js`).
 *
 * FUENTE ÚNICA en frontend para signup + change-password + reset-password.
 * Antes vivía duplicado inline en ChangePasswordModal.jsx (con la misma
 * lógica). Si las reglas cambian en el backend, hay que cambiar acá y
 * mantener paridad — tests deberían cubrir la equivalencia.
 *
 * Reglas actuales (TANDA 1):
 *   - Mínimo 8 caracteres.
 *   - Al menos una letra (A-Z / a-z).
 *   - Al menos un número (0-9).
 *
 * Si agregás una regla, agregala también en backend/src/lib/password.js y
 * en este archivo. Mantené el orden de chequeos consistente para que el
 * primer error que el user ve coincida en ambos lados.
 *
 * 2026-06-18 #322 (TANDA 1 H2 audit E2E): centralización en lib para fixar
 * el gap del Signup, que solo mostraba "Mínimo 8 caracteres" pero el
 * backend exigía letra + número. User escribía "12345678" → pasaba el
 * client-side → backend rechazaba con genérico → mala UX.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_HAS_LETTER = /[A-Za-z]/;
export const PASSWORD_HAS_NUMBER = /[0-9]/;

/** Texto descriptivo para mostrar bajo el input de password (field-note). */
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
