// Utilidades compartidas para inputs numéricos.
// #M-11: los <input type="number"> de HTML aceptan por default 'e', '+', '-' y
// otros caracteres "válidos para notación científica" que la mayoría de
// nuestros campos de dinero/cantidad NO toleran. Si el usuario tipea 'e' por
// error en un campo de monto, el value queda como '' (string vacío) y se
// pierde silenciosamente la cifra. Este handler bloquea esas teclas antes de
// que lleguen al input.
//
// #F-3: en LATAM la convención decimal es la coma ("1,50") no el punto. El
// browser puede aceptar o rechazar coma en <input type=number> dependiendo
// del locale; aún cuando acepta, JS Number() la trata como NaN. Por eso:
//   - blockInvalidNumberKeys ahora PERMITE coma por default (allowComma: true).
//   - Exportamos normalizeDecimal(str) para que los callers puedan usar
//     Number(normalizeDecimal(x)) en lugar de Number(x) al parsear.
//
// Uso:
//   <input type="number" onKeyDown={blockInvalidNumberKeys} ... />
//   // En el state setter / cálculo:
//   const n = Number(normalizeDecimal(value));

const BLOCKED_KEYS_BASE = new Set(['e', 'E', '+']);

/**
 * Bloquea teclas que harían que un <input type=number> termine vacío.
 * Permite por default: dígitos, punto, COMA (#F-3), signo menos, navegación.
 * Opciones:
 *   - allowComma: deja pasar la coma. Default: true (LATAM).
 *   - allowNegative: false bloquea también el menos. Default: true.
 */
export function blockInvalidNumberKeys(e, { allowComma = true, allowNegative = true } = {}) {
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

/**
 * Normaliza un string numérico LATAM → JS-parseable.
 *
 * Casos cubiertos:
 *   "1,50"    → "1.50"     (decimal con coma)
 *   "1.234,5" → "1234.5"   (miles con punto, decimal con coma)
 *   "1234"    → "1234"
 *   ""        → ""         (preserva vacío para distinguir "no cargado" de 0)
 *   null/undef→ ""
 *
 * Reglas:
 *   - Si hay tanto coma como punto, asume coma=decimal y punto=miles
 *     (formato es-AR canónico). Quita puntos, convierte la última coma en punto.
 *   - Si solo hay coma, la convierte en punto.
 *   - Si solo hay punto, lo deja como está (puede ser decimal o miles, pero
 *     no podemos distinguir sin contexto — asumimos decimal, JS lo parsea bien).
 */
export function normalizeDecimal(value) {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s) return '';
  const hasComma = s.includes(',');
  const hasDot   = s.includes('.');
  if (hasComma && hasDot) {
    // es-AR: "1.234,5" → "1234.5". Quitar puntos, último char de coma → punto.
    return s.replace(/\./g, '').replace(',', '.');
  }
  if (hasComma) {
    // Solo coma → asumimos decimal.
    return s.replace(',', '.');
  }
  return s; // Solo dígitos o solo punto (ya parseable por Number).
}
