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

/**
 * Anti-submit-por-scanner (task #268, bug Nook Tech, 2026-07-31).
 *
 * Contexto: los scanners USB HID (pistolas láser de código de barras) emulan
 * teclado y al terminar de "tipear" el código envían un Enter (\r\n). En
 * HTML, un Enter sobre un <input> dentro de un <form> dispara el submit por
 * default. En el modal Inventario > Agregar producto, el operador escanea
 * el IMEI y el form se envía instantáneo con SOLO el IMEI cargado — sin
 * nombre, sin categoría, sin precio. Producto queda a medias en Inventario.
 *
 * Uso (a nivel form — captura todo Enter de inputs hijos):
 *   <form onSubmit={handleSave} onKeyDown={preventScannerSubmit}>...</form>
 *
 * Comportamiento:
 *   - Enter en <input type=text/number/etc.>: preventDefault (no submit) +
 *     mover foco al siguiente elemento focusable (input/select/textarea).
 *     Así el scanner se comporta como Tab: escanea, salta al próximo campo.
 *   - Enter en <textarea>: NO tocar — el operador quiere saltos de línea.
 *   - Enter en <button>: NO tocar — click intencional del user (submit
 *     button, botones ghost, etc.).
 *   - Enter con modifier (Cmd/Ctrl/Shift/Alt): NO tocar — atajos del user.
 *
 * NO usar en spreadsheets (VentaB2BModal, CompraProveedorModal) donde el
 * Enter tiene semántica propia de navegación entre celdas — esos ya
 * manejan Enter/Tab custom en cada celda.
 */
export function preventScannerSubmit(e) {
  if (e.key !== 'Enter') return;
  // Respeta modifiers (Cmd/Ctrl/Shift/Alt+Enter) — pueden ser atajos.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const target = e.target;
  if (!target || typeof target.tagName !== 'string') return;
  const tag = target.tagName.toUpperCase();
  // Textarea: Enter = nueva línea legítima.
  if (tag === 'TEXTAREA') return;
  // Botones: Enter = click. Si es el submit del form, el user lo intención.
  if (tag === 'BUTTON') return;
  // Solo interceptamos inputs (el caso del scanner).
  if (tag !== 'INPUT') return;
  // type=submit dentro de <input> también es un submit intencional.
  if (target.type === 'submit') return;

  e.preventDefault();

  // Bonus UX: mover al siguiente elemento focusable del form. Así el scan
  // funciona como Tab automático — escaneás IMEI, foco salta a "Nombre",
  // seguís tipeando. Sin esto el foco queda "atascado" en el input IMEI.
  const form = target.form;
  if (!form) return;
  const focusables = Array.from(
    form.querySelectorAll('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
  );
  const idx = focusables.indexOf(target);
  const next = focusables[idx + 1];
  if (next && typeof next.focus === 'function') next.focus();
}
