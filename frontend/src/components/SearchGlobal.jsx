// SearchGlobal.jsx — Búsqueda global cross-módulo estilo command palette
// (U-23 TANDA 6).
//
// Disparado por ⌘K / Ctrl+K (listener global en Shell.jsx) o por el botón
// "Buscar" del topbar. Hace UNA query a /api/search y muestra top-N matches
// en 4 categorías: clientes, productos, ventas, envíos.
//
// Comportamiento:
//   · Input autofocus al abrir, debounced 300ms (useDebouncedValue).
//   · q.length < 2 → empty state ("escribí al menos 2 letras").
//   · Loading state mientras hay request in-flight.
//   · "Sin resultados" cuando query ok pero todas las categorías vacías.
//   · Cada item clickeable navega a su módulo y cierra el modal.
//   · Esc cierra (vía useModal). Click fuera cierra. ↑/↓ navegan, Enter
//     activa el item seleccionado.
//   · Una categoría con 0 resultados se OCULTA del render para no mostrar
//     headers vacíos.
//
// Deep-link strategy por entidad (ver task brief):
//   · cliente → /contactos             (no hay query param ?id=, la grilla
//                                       no scrollea a un id — vamos al index).
//   · producto → /inventario           (idem; el id no se respeta).
//   · venta → /ventas                  (idem).
//   · envío → /envios                  (idem).
// Cuando los módulos implementen deep-links (TODO follow-up), basta cambiar
// `targetFor()` abajo para que respeten ?id=N.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from './Icons';
import useModal from '../lib/useModal';
import useDebouncedValue from '../lib/useDebouncedValue';
import { search as searchApi } from '../lib/api';
import { fmtMoney } from '../lib/format';

// Mínimo de caracteres para disparar fetch. Mismo número que el schema Zod
// backend — coherencia client/server.
const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

// Devuelve el path a navegar al elegir un resultado. Centralizado acá para
// que cuando los módulos soporten ?id=, el cambio sea de una línea por
// entidad. Devolver null = no navegar (defensivo).
function targetFor(category, item) {
  if (!item || item.id == null) return null;
  switch (category) {
    case 'clientes':  return '/contactos';   // TODO: /contactos?id=${id} cuando soporte deep-link
    case 'productos': return '/inventario';  // TODO: /inventario?productoId=${id}
    case 'ventas':    return '/ventas';      // TODO: /ventas?id=${id}
    case 'envios':    return '/envios';      // TODO: /envios?id=${id}
    default: return null;
  }
}

// Etiqueta visible del header de cada categoría. El orden del array define
// el orden de render en el modal (categorías arriba = más frecuentemente
// buscadas en operación según Lucas).
const CATEGORIES = [
  { key: 'clientes',  label: 'Clientes',  icon: 'Users' },
  { key: 'productos', label: 'Productos', icon: 'Box' },
  { key: 'ventas',    label: 'Ventas',    icon: 'Receipt' },
  { key: 'envios',    label: 'Envíos',    icon: 'Truck' },
];

// Render de un row según categoría. Mantengo cada función chiquita —
// metemos info útil sin saturar. fmtMoney maneja USD/ARS con símbolo.
function renderItemLabel(category, item) {
  switch (category) {
    case 'clientes': {
      const fullName = [item.nombre, item.apellido].filter(Boolean).join(' ');
      return (
        <>
          <span style={{ fontWeight: 600 }}>{fullName || `Contacto #${item.id}`}</span>
          {item.tipo && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
              · {item.tipo}
            </span>
          )}
        </>
      );
    }
    case 'productos': {
      const precio = Number(item.precio_venta) > 0
        ? fmtMoney(item.precio_venta, item.precio_moneda || 'USD')
        : null;
      return (
        <>
          <span style={{ fontWeight: 600 }}>{item.nombre}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
            {item.imei ? `IMEI ${item.imei}` : `Cant ${item.cantidad}`}
            {precio && ` · ${precio}`}
            {item.estado && item.estado !== 'disponible' && ` · ${item.estado}`}
          </span>
        </>
      );
    }
    case 'ventas': {
      const total = Number(item.total_usd) > 0 ? fmtMoney(item.total_usd, 'USD') : '—';
      return (
        <>
          <span style={{ fontWeight: 600 }}>
            #{item.id} {item.cliente_nombre ? `· ${item.cliente_nombre}` : ''}
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
            {total} · {item.estado || '—'} · {item.fecha}
          </span>
        </>
      );
    }
    case 'envios': {
      return (
        <>
          <span style={{ fontWeight: 600 }}>#{item.id} · {item.cliente}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
            {item.direccion} · {item.estado}
          </span>
        </>
      );
    }
    default: return null;
  }
}

export default function SearchGlobal({ open, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);       // { results, counts } o null
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const overlayRef = useRef(null);
  const inputRef = useRef(null);
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);

  // useModal: focus trap + body lock + Esc handler. El selector autoFocus
  // apunta al input del search específicamente (no al primer focusable
  // arbitrario, que sería el botón ✕).
  useModal({
    open,
    onClose,
    overlayRef,
    autoFocusSelector: 'input[type="search"]',
  });

  // Reset al abrir — limpiar query previa, así cada apertura es un canvas
  // limpio (mismo behaviour que GitHub/Linear).
  useEffect(() => {
    if (open) {
      setQuery('');
      setData(null);
      setError(null);
      setActiveIdx(0);
    }
  }, [open]);

  // Fetch al cambiar debouncedQuery. AbortController evita race conditions
  // si el user tipea rápido — siempre ganamos la última request.
  useEffect(() => {
    if (!open) return;
    const q = debouncedQuery.trim();
    if (q.length < MIN_CHARS) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    searchApi.global(q)
      .then(r => {
        if (cancelled) return;
        setData(r);
        setActiveIdx(0);
      })
      .catch(e => {
        if (cancelled) return;
        // 401 (token expirado) lo maneja el wrapper api(); cualquier otro
        // error: mostramos copy genérico, no crasheamos el modal.
        setError(e.message || 'Error al buscar');
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [debouncedQuery, open]);

  // Lista lineal de items visibles, en el orden de CATEGORIES, para
  // navegación ↑/↓/Enter sin saltear categorías ocultas.
  const flatItems = useMemo(() => {
    if (!data?.results) return [];
    const out = [];
    for (const cat of CATEGORIES) {
      const items = data.results[cat.key] || [];
      for (const item of items) {
        out.push({ category: cat.key, item });
      }
    }
    return out;
  }, [data]);

  // Ref de flatItems para leer dentro del keydown sin re-suscribir el listener.
  // Mismo patrón que CommandPalette para evitar stale closures.
  const flatItemsRef = useRef(flatItems);
  useEffect(() => { flatItemsRef.current = flatItems; }, [flatItems]);

  const handleSelect = useCallback((entry) => {
    if (!entry) return;
    const target = targetFor(entry.category, entry.item);
    if (target) navigate(target);
    onClose();
  }, [navigate, onClose]);

  // ↑/↓/Enter listener — solo cuando hay items. Esc/Tab los gestiona useModal.
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      const items = flatItemsRef.current;
      if (e.key === 'ArrowDown') {
        if (items.length === 0) return;
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        if (items.length === 0) return;
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (items.length === 0) return;
        e.preventDefault();
        handleSelect(items[activeIdx]);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeIdx, handleSelect]);

  if (!open) return null;

  const trimmed = query.trim();
  const hasResults = flatItems.length > 0;
  const showEmpty = trimmed.length < MIN_CHARS;
  const showNoResults = !showEmpty && !loading && !error && data && !hasResults;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="search-global-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: 640,
          width: 'calc(100% - 32px)',
          maxHeight: '75vh',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Search input row */}
        <h2 id="search-global-title" className="sr-only" style={{ position: 'absolute', left: -9999 }}>
          Búsqueda global
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', flexShrink: 0 }}>
          <Icons.Search size={16} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar clientes, productos, ventas, envíos…"
            aria-label="Buscar"
            autoComplete="off"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: 16,
              padding: '16px 0',
              background: 'transparent',
              color: 'var(--text)',
            }}
          />
          {loading && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-live="polite">
              Buscando…
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Cerrar búsqueda"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Icons.X size={14} />
          </button>
        </div>

        <div style={{ height: 1, background: 'var(--hairline)', flexShrink: 0 }} />

        {/* Results */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {showEmpty && (
            <div style={{
              padding: '32px 16px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 14,
            }}>
              Escribí al menos {MIN_CHARS} letras para buscar.
            </div>
          )}

          {error && !showEmpty && (
            <div style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--neg)',
              fontSize: 14,
            }}>
              {error}
            </div>
          )}

          {showNoResults && (
            <div style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 14,
            }}>
              No hay resultados para “{trimmed}”.
            </div>
          )}

          {hasResults && !error && (() => {
            let runningIdx = 0;
            return CATEGORIES.map(cat => {
              const items = data.results[cat.key] || [];
              if (items.length === 0) return null;   // categoría sin matches: ocultar header
              const count = data.counts?.[cat.key] ?? items.length;
              const Icon = Icons[cat.icon];
              const startIdx = runningIdx;
              runningIdx += items.length;
              return (
                <div key={cat.key}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                    padding: '10px 16px 4px',
                  }}>
                    {Icon && <Icon size={12} />}
                    <span>{cat.label}</span>
                    <span style={{ opacity: 0.6 }}>
                      ({count > items.length ? `${items.length} de ${count}` : count})
                    </span>
                  </div>
                  {items.map((item, i) => {
                    const idx = startIdx + i;
                    const isActive = idx === activeIdx;
                    return (
                      <div
                        key={`${cat.key}-${item.id}`}
                        role="option"
                        aria-selected={isActive}
                        onClick={() => handleSelect({ category: cat.key, item })}
                        onMouseEnter={() => setActiveIdx(idx)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 16px',
                          cursor: 'pointer',
                          borderRadius: 8,
                          margin: '2px 6px',
                          background: isActive ? 'var(--accent-soft)' : 'transparent',
                          color: isActive ? 'var(--accent)' : 'var(--text)',
                          transition: 'background 0.1s, color 0.1s',
                          fontSize: 14,
                          minHeight: 36,
                        }}
                      >
                        {renderItemLabel(cat.key, item)}
                      </div>
                    );
                  })}
                </div>
              );
            });
          })()}
        </div>

        {/* Footer hint — solo si NO estamos en empty/error states */}
        {!showEmpty && (
          <div style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            padding: '10px 16px',
            borderTop: '1px solid var(--hairline)',
            display: 'flex',
            gap: 16,
            flexShrink: 0,
          }}>
            <span><kbd style={kbdStyle}>↑↓</kbd> Navegar</span>
            <span><kbd style={kbdStyle}>Enter</kbd> Abrir</span>
            <span><kbd style={kbdStyle}>Esc</kbd> Cerrar</span>
          </div>
        )}
      </div>
    </div>
  );
}

const kbdStyle = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '1px 5px',
  fontSize: 10,
  fontFamily: 'monospace',
};
