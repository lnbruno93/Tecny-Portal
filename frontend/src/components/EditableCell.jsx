/**
 * EditableCell — celda de tabla editable in-place.
 *
 * Click (o tap en mobile) en cualquier celda → entra en modo edición.
 * Enter (o blur) guarda. Esc cancela. Spinner mientras guarda.
 * Si onSave falla, se restaura el valor anterior y se muestra un toast
 * (el caller maneja el toast; acá sólo se hace rollback visual).
 *
 * Tipos soportados:
 *   - 'text'    : input text libre
 *   - 'number'  : input numérico (min/max/step)
 *   - 'select'  : dropdown nativo con opciones fijas
 *   - 'combo'   : input con búsqueda + lista filtrada (FK / autocomplete)
 *
 * Optimistic UI: el `display` se calcula a partir de `value` desde props;
 * cuando guarda, el caller actualiza el state padre → la celda muestra
 * el valor nuevo. Si onSave rechaza, el state padre no cambia → rollback
 * implícito.
 */
import { useState, useRef, useEffect, useMemo } from 'react';

// Compara dos valores tratando null/undefined/'' como equivalentes
// (porque del DOM siempre llega string '' y del estado puede ser null).
function isSameValue(a, b) {
  const na = a == null || a === '' ? null : a;
  const nb = b == null || b === '' ? null : b;
  if (na === null && nb === null) return true;
  // Normalizamos a string para no fallar por tipo (12 vs "12")
  return String(na) === String(nb);
}

export default function EditableCell({
  value,                // valor crudo a editar (string, number, null)
  display,              // (opcional) cómo mostrar el valor en modo lectura. Si no se pasa, se muestra `value || '—'`
  type = 'text',        // 'text' | 'number' | 'select' | 'combo'
  options = [],         // [{ value, label }] — para select / combo
  onSave,               // async (newValue) => void. Si rechaza, hace rollback.
  placeholder = '—',
  disabled = false,
  align = 'left',
  className = '',
  inputProps = {},      // props extra al input (min, max, step, maxLength, etc.)
  parse,                // (rawString) => valor final (ej: parseFloat). Default: identidad.
  emptyToNull = true,   // si el valor es '' al guardar → guarda null
  title,                // tooltip
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  // Para 'combo': controlar lista filtrada
  const [comboQuery, setComboQuery] = useState('');
  const [comboOpen, setComboOpen] = useState(false);
  const [comboFocus, setComboFocus] = useState(0);

  // Foco automático al entrar en modo edición
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (typeof inputRef.current.select === 'function') {
        inputRef.current.select();
      }
    }
  }, [editing]);

  // Cierre del combo al hacer click fuera (sólo combo)
  useEffect(() => {
    if (!editing || type !== 'combo') return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        // Click fuera → guardamos lo que esté tipeado (busca match exacto en options)
        commitCombo();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, comboQuery, options]);

  function startEdit() {
    if (disabled || saving) return;
    const initial = value == null ? '' : String(value);
    setDraft(initial);
    setComboQuery('');
    setComboOpen(type === 'combo');
    setComboFocus(0);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setDraft('');
    setComboQuery('');
    setComboOpen(false);
  }

  async function commit(rawValue) {
    let parsed;
    if (emptyToNull && (rawValue === '' || rawValue == null)) {
      parsed = null;
    } else {
      parsed = parse ? parse(rawValue) : rawValue;
    }
    // No-op si no cambió: no llamamos onSave, evitamos request y audit ruidoso.
    if (isSameValue(parsed, value)) {
      cancel();
      return;
    }
    try {
      setSaving(true);
      await onSave(parsed);
      // El padre debería haber actualizado `value`; salimos del modo edición.
      setEditing(false);
      setDraft('');
      setComboQuery('');
      setComboOpen(false);
    } catch {
      // El caller muestra el toast; acá sólo dejamos la celda en modo lectura.
      setEditing(false);
      setDraft('');
      setComboQuery('');
      setComboOpen(false);
    } finally {
      setSaving(false);
    }
  }

  // ── Combo: opciones filtradas por query ──
  const filteredOptions = useMemo(() => {
    if (type !== 'combo') return options;
    const q = comboQuery.trim().toLowerCase();
    if (!q) return options.slice(0, 50);
    return options.filter(o => String(o.label).toLowerCase().includes(q)).slice(0, 50);
  }, [type, comboQuery, options]);

  function commitCombo() {
    // Si la query coincide exactamente con una opción → guarda esa option.value.
    // Si la query está vacía → guarda null.
    // Si no coincide con ninguna → buscamos el primer match parcial.
    const q = comboQuery.trim();
    if (!q && !draft) {
      commit('');
      return;
    }
    const exact = options.find(o => String(o.label).toLowerCase() === q.toLowerCase());
    if (exact) {
      commit(exact.value);
      return;
    }
    // Si no hay query (sólo se abrió el combo) y hay un draft prefijado, mantenelo
    if (!q && draft) {
      commit(draft);
      return;
    }
    // Sin match: rechazamos (vuelta al valor previo).
    cancel();
  }

  // Clase de alineación derivada del prop `align` — evita el inline
  // textAlign (CSP hardening). Solo 3 valores válidos: left/right/center.
  const alignClass = align === 'right' ? 'u-ta-right' : align === 'center' ? 'u-ta-center' : 'u-ta-left';

  // ── Render: modo LECTURA ──
  if (!editing) {
    const shown = display != null ? display : (value == null || value === '' ? placeholder : String(value));
    return (
      <td
        className={`editable-cell u-pos-relative ${alignClass} ${disabled ? 'u-cur-default' : 'u-cur-text'} ${className}`}
        onClick={startEdit}
        title={title || (disabled ? '' : 'Click para editar')}
        data-testid="editable-cell"
      >
        {shown}
      </td>
    );
  }

  // ── Render: modo EDICIÓN ──
  const inputClass = `editable-cell-input ${alignClass}`;

  // ── select (enums fijos) ──
  if (type === 'select') {
    return (
      <td className={`editable-cell editing editable-cell-td ${alignClass} ${className}`}>
        <select
          ref={inputRef}
          className={inputClass}
          value={draft}
          disabled={saving}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          {...inputProps}
        >
          <option value="">— Sin valor —</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
    );
  }

  // ── combo (FK con búsqueda) ──
  if (type === 'combo') {
    return (
      <td className={`editable-cell editing editable-cell-td u-pos-relative ${alignClass} ${className}`} ref={wrapRef}>
        <input
          ref={inputRef}
          type="text"
          className={inputClass}
          value={comboQuery}
          disabled={saving}
          placeholder="Buscar…"
          onChange={e => { setComboQuery(e.target.value); setComboOpen(true); setComboFocus(0); }}
          onFocus={() => setComboOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
            if (!comboOpen) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault(); setComboFocus(i => Math.min(i + 1, filteredOptions.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault(); setComboFocus(i => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (!comboQuery.trim()) { commit(''); return; }
              const sel = filteredOptions[comboFocus];
              if (sel) commit(sel.value);
            } else if (e.key === 'Backspace' && !comboQuery) {
              // Backspace en input vacío → limpiar (guarda null)
              commit('');
            }
          }}
          {...inputProps}
        />
        {comboOpen && filteredOptions.length > 0 && (
          <div className="combo-dropdown u-combo-dropdown">
            {filteredOptions.map((o, i) => (
              <div
                key={o.value}
                onMouseDown={e => { e.preventDefault(); commit(o.value); }}
                onMouseEnter={() => setComboFocus(i)}
                className={`u-combo-item ${i === comboFocus ? 'u-combo-item-active' : ''}`}
              >
                {o.label}
              </div>
            ))}
          </div>
        )}
        {comboOpen && filteredOptions.length === 0 && comboQuery.trim() && (
          <div className="u-combo-empty">
            Sin coincidencias
          </div>
        )}
      </td>
    );
  }

  // ── text / number ──
  return (
    <td className={`editable-cell editing editable-cell-td ${alignClass} ${className}`}>
      <input
        ref={inputRef}
        type={type === 'number' ? 'number' : 'text'}
        className={inputClass}
        value={draft}
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        {...inputProps}
      />
    </td>
  );
}
