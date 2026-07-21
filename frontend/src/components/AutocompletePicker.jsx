/**
 * AutocompletePicker — picker genérico con búsqueda debounced + dropdown +
 * navegación por teclado. Auditoría #R-03.
 *
 * Reemplaza ProductoPicker (VentaB2BModal) y ClientePicker (CobranzaMasivaModal)
 * que tenían ~180 líneas idénticas: useState(open/highlight), useDebouncedValue,
 * useEffect outside-click, onKey con flechas/Enter/Escape, CSS del dropdown,
 * lock/unlock.
 *
 * El contrato: el caller pasa `fetchOptions(query)` que devuelve un array de
 * opciones. Cada opción se renderiza con `renderOption(opt, { highlighted })`.
 * `onPick(opt)` se llama cuando el user elige.
 *
 * Props:
 *   value         — string del input
 *   onChange      — (string) => void, cambio del input
 *   locked        — bool, si está bloqueado (post-pick) muestra X para desbloquear
 *   onClear       — () => void, cuando se desbloquea
 *   onPick        — (option) => void, cuando se elige una opción
 *   fetchOptions  — async (q: string) => option[] o sync (q) => option[]
 *   renderOption  — (opt, { highlighted, index }) => ReactNode
 *   getOptionKey  — (opt) => string | number (default: opt.id)
 *   placeholder   — string (default: 'Buscar…')
 *   minChars      — int (default: 2)
 *   debounceMs    — int (default: 200)
 *   limit         — int para mostrar "hay más" si llega ≥ limit (default: null = sin indicador)
 *   emptyText     — texto si no hay matches (default: 'Sin coincidencias')
 *   cellInp       — estilo del input (forwardeado)
 *
 * Atajos de teclado: ↑/↓ navegar, Enter elegir, Escape cerrar.
 */
import { useState, useEffect, useRef } from 'react';
import { Icons } from './Icons';
import { useDebouncedValue } from '../lib/useDebouncedValue';

export default function AutocompletePicker({
  value,
  onChange,
  locked = false,
  onClear,
  onPick,
  fetchOptions,
  renderOption,
  getOptionKey = (o) => o.id,
  placeholder = 'Buscar…',
  minChars = 2,
  debounceMs = 200,
  limit = null,
  emptyText = 'Sin coincidencias',
  cellInp,
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const debounced = useDebouncedValue(value, debounceMs);
  const boxRef = useRef(null);
  // Token "última request gana" para no pisar resultados (auditoría #H-10)
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (locked) { setOpen(false); return; }
    const q = (debounced || '').trim();
    if (q.length < minChars) { setItems([]); setHasMore(false); return; }
    setLoading(true);
    const myReq = ++reqIdRef.current;
    Promise.resolve(fetchOptions(q))
      .then(opts => {
        if (myReq !== reqIdRef.current) return;
        const arr = Array.isArray(opts) ? opts : (opts?.data || []);
        setItems(arr);
        setHasMore(limit !== null && arr.length >= limit);
        setOpen(true);
        setHighlight(0);
      })
      .catch(() => { if (myReq === reqIdRef.current) { setItems([]); setHasMore(false); } })
      .finally(() => { if (myReq === reqIdRef.current) setLoading(false); });
  }, [debounced, locked, minChars, limit, fetchOptions]);

  // Cerrar al clickear afuera
  useEffect(() => {
    function onDoc(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function onKey(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[highlight]) { onPick(items[highlight]); setOpen(false); }
    }
    else if (e.key === 'Escape') setOpen(false);
  }

  function reopen() {
    if (!locked && items.length > 0) setOpen(true);
  }

  return (
    <div ref={boxRef} className="u-pos-rel">
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          style={{
            ...cellInp,
            background: locked ? 'rgba(99,102,241,0.10)' : (cellInp?.background || 'var(--surface)'),
            fontWeight: locked ? 600 : (cellInp?.fontWeight || 400),
          }}
          value={value}
          placeholder={placeholder}
          readOnly={locked}
          onChange={e => onChange(e.target.value)}
          onFocus={reopen}
          onKeyDown={onKey}
        />
        {locked && (
          <button className="icon-btn" style={{ padding: 2, color: 'var(--text-muted)' }}
            onClick={onClear} title="Cambiar selección">
            <Icons.X size={12} />
          </button>
        )}
      </div>
      {open && !locked && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 4, zIndex: 50, maxHeight: 260, overflowY: 'auto',
          boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
        }}>
          {loading && <div style={{ padding: 8, fontSize: 12, color: 'var(--text-muted)' }}>Buscando…</div>}
          {!loading && items.length === 0 && (
            <div style={{ padding: 8, fontSize: 12, color: 'var(--text-muted)' }}>{emptyText}</div>
          )}
          {items.map((opt, i) => (
            <div key={getOptionKey(opt)}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); onPick(opt); setOpen(false); }}
              style={{
                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                background: i === highlight ? 'var(--surface-2)' : 'transparent',
                borderBottom: i < items.length - 1 ? '1px solid var(--hairline)' : 'none',
              }}>
              {renderOption(opt, { highlighted: i === highlight, index: i })}
            </div>
          ))}
          {hasMore && limit !== null && (
            <div style={{
              padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)',
              background: 'var(--surface-2)', borderTop: '1px solid var(--hairline)',
              textAlign: 'center',
            }}>
              Mostrando los primeros {limit} — refiná la búsqueda para ver más
            </div>
          )}
        </div>
      )}
    </div>
  );
}
