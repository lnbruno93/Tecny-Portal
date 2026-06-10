// BarrioCombobox — input con autocomplete agrupado por zona, para el campo
// "Barrio" de Envíos. Estilo combobox libre: el operador puede tipear
// cualquier cosa (no restringe a la lista), pero al hacer focus o tipear ve
// sugerencias filtradas y agrupadas por CABA / Norte / Oeste / Sur / Este.
//
// 2026-06-10 — Lucas pidió un "deslizable con TODOS los barrios de Capital y
// GBA". Implementación combobox para que sea útil sin bloquear los barrios
// que falten de la lista curada.
//
// Props:
//   value         — string (lo que está en el form)
//   onChange      — (string) => void
//   placeholder   — string (default: 'Buscar barrio…')
//   inputProps    — props extra pasadas al <input> (className, id, etc.)
//
// Comportamiento:
//   · onFocus o tipeo abre el dropdown.
//   · Tipea para filtrar por includes() case-insensitive sobre todos los
//     barrios de todas las zonas.
//   · ↑/↓ navega, Enter selecciona el resaltado, Escape cierra.
//   · Click en una sugerencia setea solo el nombre del barrio (sin la zona).
//   · Click fuera del componente cierra el dropdown sin tocar el valor.
import { useState, useEffect, useRef, useMemo } from 'react';
import { ZONAS_BARRIOS, BARRIO_TO_ZONA } from '../lib/barriosBsAs';

// Normalizamos para búsqueda: lowercase y sin diacríticos así "nunez"
// matchea "Núñez", "saenz" → "Sáenz Peña", etc. Argentina + acentos =
// requerimiento básico de UX para que "tigre" encuentre "Tigre".
const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD')
  // U+0300–U+036F: bloque de combining diacritical marks que NFD genera.
  .replace(/[̀-ͯ]/g, '');

export default function BarrioCombobox({
  value,
  onChange,
  placeholder = 'Buscar barrio…',
  inputProps = {},
}) {
  const [open, setOpen] = useState(false);
  // Lista plana de todas las opciones filtradas: [{ barrio, zona }, ...]
  // — el dropdown la recorre y dibuja headers de zona cuando cambia el grupo.
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef(null);

  // Filtrado: si está vacío, mostrar TODO (agrupado). Si hay query, filtrar
  // barrios cuyos nombres incluyan la query (normalizada).
  const filtered = useMemo(() => {
    const q = norm(value).trim();
    const out = [];
    for (const z of ZONAS_BARRIOS) {
      for (const b of z.barrios) {
        if (!q || norm(b).includes(q)) out.push({ barrio: b, zona: z.zona });
      }
    }
    return out;
  }, [value]);

  // Reset highlight cuando cambia la lista filtrada para evitar punteros stale
  useEffect(() => { setHighlight(0); }, [filtered]);

  // Cerrar al click fuera del contenedor
  useEffect(() => {
    function onDoc(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function onKey(e) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      // Si hay match resaltado, seleccionarlo; si no, dejar lo tipeado y cerrar.
      if (filtered[highlight]) { e.preventDefault(); pick(filtered[highlight].barrio); }
      else setOpen(false);
    }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  function pick(barrio) {
    onChange(barrio);
    setOpen(false);
  }

  // Cuando el operador ya tiene un barrio cargado, si está en la lista
  // mostramos la zona como hint debajo del input (ej. "📍 Zona Norte").
  // Es solo informativo: ayuda a verificar visualmente que se eligió el
  // correcto cuando hay barrios con nombres parecidos entre zonas.
  const zonaHint = value && BARRIO_TO_ZONA.get(value.toLowerCase());

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        type="text"
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        autoComplete="off"
        {...inputProps}
      />
      {zonaHint && !open && (
        <div className="muted tiny" style={{ marginTop: 2 }}>📍 {zonaHint}</div>
      )}
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 6, zIndex: 60, maxHeight: 280, overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)', marginTop: 2,
          }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
              Sin coincidencias — podés escribir el barrio libremente
            </div>
          )}
          {filtered.map((opt, i) => {
            // Renderizamos un header de zona cada vez que cambia el grupo
            // respecto al elemento anterior. Da una visual agrupada sin
            // armar listas anidadas.
            const prev = filtered[i - 1];
            const showZonaHeader = !prev || prev.zona !== opt.zona;
            return (
              <div key={`${opt.zona}-${opt.barrio}`}>
                {showZonaHeader && (
                  <div style={{
                    padding: '4px 10px', fontSize: 10, fontWeight: 700,
                    color: 'var(--text-muted)', textTransform: 'uppercase',
                    letterSpacing: 0.5, background: 'var(--surface-2)',
                    borderTop: i > 0 ? '1px solid var(--hairline)' : 'none',
                  }}>
                    {opt.zona}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  // onMouseDown en vez de onClick para que se dispare antes
                  // del blur que cerraría el dropdown.
                  onMouseDown={(e) => { e.preventDefault(); pick(opt.barrio); }}
                  style={{
                    padding: '6px 10px', fontSize: 13, cursor: 'pointer',
                    background: i === highlight ? 'var(--surface-2)' : 'transparent',
                  }}
                >
                  {opt.barrio}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
