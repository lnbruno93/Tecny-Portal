// Utilidades compartidas para inputs numéricos.
// #M-11: los <input type="number"> de HTML aceptan por default 'e', '+', '-' y
// otros caracteres "válidos para notación científica" que la mayoría de
// nuestros campos de dinero/cantidad NO toleran. Si el usuario tipea 'e' por
// error en un campo de monto, el value queda como '' (string vacío) y se
// pierde silenciosamente la cifra. Este handler bloquea esas teclas antes de
// que lleguen al input.
//
// Uso:
//   <input type="number" onKeyDown={blockInvalidNumberKeys} ... />
// O para permitir decimales con punto Y coma:
//   <input type="number" onKeyDown={e => blockInvalidNumberKeys(e, { allowComma: true })} ... />

const BLOCKED_KEYS_BASE = new Set(['e', 'E', '+']);

/**
 * Bloquea teclas que harían que un <input type=number> termine vacío.
 * Permite por default: dígitos, punto, signo menos (al inicio), navegación.
 * Opciones:
 *   - allowComma: deja pasar la coma (algunos usuarios la usan como decimal).
 *   - allowNegative: false bloquea también el menos. Default: true.
 */
export function blockInvalidNumberKeys(e, { allowComma = false, allowNegative = true } = {}) {
  if (e.ctrlKey || e.metaKey) return; // copy/paste/select-all
  const k = e.key;
  if (BLOCKED_KEYS_BASE.has(k)) { e.preventDefault(); return; }
  if (!allowNegative && k === '-') { e.preventDefault(); return; }
  if (!allowComma && k === ',') { e.preventDefault(); return; }
}

/**
 * Spread-ready props para `<input type="number">`. Encapsula type + onKeyDown
 * en un objeto. Útil cuando ya tenés props inline y querés agregar el bloqueo
 * sin reformatear todo:
 *
 *   <input className="input mono" placeholder="0" value={x} onChange={...}
 *          {...numberInputProps()} />
 */
export function numberInputProps(opts) {
  return {
    type: 'number',
    onKeyDown: (e) => blockInvalidNumberKeys(e, opts),
  };
}
