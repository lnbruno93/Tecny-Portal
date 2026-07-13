// CommandPalette.jsx — Global ⌘K command palette for navigation + content search.
// Controlled by parent via `open` / `onClose` props.
//
// 2026-07-13 (feature): además de navegar entre pantallas (comportamiento
// original), busca contenido en la DB via /api/search — productos por
// nombre/IMEI/color, ventas por order_id/cliente, contactos, envíos, cajas,
// egresos. Todo en 1 request con `Promise.all` server-side (~50-150ms).
// Debounce 180ms sobre el input para no martillar la API en cada tecla.

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from './Icons';
// Auditoría 2026-06-30 F-02→05: descripción del Cotizador hardcoded "USD →
// ARS" — para tenants UY toca "USD → UYU". Moneda local dinámica.
import { useMonedasTenant } from '../lib/useMonedasTenant';
import { search as searchApi } from '../lib/api';

// Listado completo de rutas — la auditoría detectó que faltaban 10 (Ventas,
// Inventario, Desglose 360, Contactos, Proyectos, Egresos, Capital, Cambios,
// Tarjetas). El ⌘K es la fuente única para navegar rápido; si una pantalla
// crítica no aparece, el usuario tiene que ir por la sidebar.
//
// 2026-06-30 F-02→05: se transformó de constante top-level a factory porque
// la descripción del Cotizador depende del país del tenant (USD → ARS|UYU).
function buildCommands(monedaLocal) {
return [
  { id: 'inicio',        path: '/inicio',              label: 'Inicio',                       desc: 'Dashboard principal',                            icon: 'Grid'       },
  { id: 'cotizador',     path: '/cotizador',           label: 'Cotizador',                    desc: `Precios con cuotas y USD → ${monedaLocal}`,      icon: 'Calculator' },
  { id: 'usados',        path: '/usados',              label: 'Usados | Cotizador',           desc: 'Catálogo de precios USD',                        icon: 'Phone'      },
  { id: 'ventas',        path: '/ventas',              label: 'Ventas',                       desc: 'Alta de ventas + dashboard',                     icon: 'Receipt'    },
  { id: 'cuentas',       path: '/cuentas',             label: 'Venta & Gestión B2B',          desc: 'Clientes B2B y cuenta corriente',                icon: 'Receipt'    },
  { id: 'inventario',    path: '/inventario',          label: 'Inventario',                   desc: 'Stock de equipos y accesorios',                  icon: 'Box'        },
  { id: 'desglose',      path: '/inventario/desglose', label: 'Desglose 360',                 desc: 'Pivot del stock por categoría/proveedor/modelo', icon: 'PieChart'   },
  { id: 'envios',        path: '/envios',              label: 'Envíos',                       desc: 'Despachos a domicilio',                          icon: 'Truck'      },
  { id: 'financiera',    path: '/financiera',          label: 'Financiera',                   desc: 'Comprobantes, pagos y OCR',                      icon: 'Trend'      },
  { id: 'proveedores',   path: '/proveedores',         label: 'Proveedores | Compras',        desc: 'Compras y cuenta corriente con proveedores',     icon: 'Building'   },
  { id: 'egresos',       path: '/egresos',             label: 'Egresos',                      desc: 'Gastos puntuales y recurrentes',                 icon: 'ArrowDownRight' },
  { id: 'cambios',       path: '/cambios',             label: 'Cambios de Divisa',            desc: 'Compra/venta de moneda',                         icon: 'Dollar'     },
  { id: 'tarjetas',      path: '/tarjetas',            label: 'Tarjetas de Crédito',          desc: 'Cobros y liquidaciones',                         icon: 'CreditCard' },
  { id: 'cajas',         path: '/cajas',               label: 'Cajas',                        desc: 'Ledger global multi-moneda',                     icon: 'Wallet'     },
  { id: 'capital',       path: '/capital',             label: '360 & Capital',                desc: 'Vista consolidada de cajas',                     icon: 'TrendUp'    },
  { id: 'proyectos',     path: '/proyectos',           label: 'Proyectos',                    desc: 'Inversiones agrupadas',                          icon: 'Box'        },
  { id: 'contactos',     path: '/contactos',           label: 'Contactos',                    desc: 'Agenda unificada',                               icon: 'Users'      },
  { id: 'historial',     path: '/historial',           label: 'Historial',                    desc: 'Auditoría de cambios',                           icon: 'Refresh'    },
  { id: 'usuarios',      path: '/usuarios',            label: 'Usuarios',                     desc: 'Gestión de acceso',                              icon: 'Users'      },
  { id: 'config',        path: '/config',              label: 'Config',                       desc: 'Ajustes del portal',                             icon: 'Settings'   },
];
}

// Etiquetas por categoría (visibles como header en la lista de resultados).
const CATEGORY_LABELS = {
  productos: 'Productos',
  ventas:    'Ventas',
  contactos: 'Contactos',
  envios:    'Envíos',
  cajas:     'Cajas',
  egresos:   'Egresos',
};

// Icono por categoría.
const CATEGORY_ICONS = {
  productos: 'Box',
  ventas:    'Receipt',
  contactos: 'Users',
  envios:    'Truck',
  cajas:     'Wallet',
  egresos:   'ArrowDownRight',
};

export default function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // 2026-07-13: resultados de la búsqueda server-side.
  // { productos: [], ventas: [], contactos: [], envios: [], cajas: [], egresos: [] }
  const [apiResults, setApiResults] = useState(null);
  const [apiLoading, setApiLoading] = useState(false);
  // Token para "última query gana" — evita que una respuesta lenta pise a
  // una nueva búsqueda hecha después. Pattern usado en Ventas.jsx (prodReq).
  const requestToken = useRef(0);
  const inputRef = useRef(null);
  const filteredRef = useRef([]); // always-current ref used inside keydown handler
  const navigate = useNavigate();
  // Auditoría 2026-06-30 F-02→05: moneda local del tenant (ARS para AR,
  // UYU para UY). Inyectada en la desc del Cotizador.
  const { monedaLocal } = useMonedasTenant();
  // Memoizado por moneda — el array se reconstruye solo al cambiar de tenant.
  const COMMANDS = useMemo(() => buildCommands(monedaLocal), [monedaLocal]);

  // Reset state when palette opens/closes
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setApiResults(null);
      // Autofocus input on next tick so the DOM is ready
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // 2026-07-13: debounce sobre query → llama /api/search cuando >= 2 chars.
  // 180ms es sweet-spot: rápido para sentirse "instantáneo", suficiente para
  // no martillar la API en cada tecla del operador.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setApiResults(null);
      setApiLoading(false);
      return;
    }
    const myToken = ++requestToken.current;
    setApiLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchApi.query(q);
        // Última query gana: si mientras esperaba la respuesta el operador
        // siguió tipeando, esta respuesta es obsoleta y la descartamos.
        if (myToken !== requestToken.current) return;
        setApiResults(res.results || {});
      } catch {
        // Fallo silencioso (network hiccup, 401 tras logout, etc.). El
        // palette sigue funcional con navegación local.
        if (myToken === requestToken.current) setApiResults(null);
      } finally {
        if (myToken === requestToken.current) setApiLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Keyboard navigation inside the palette
  useEffect(() => {
    if (!open) return;

    function handleKey(e) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, filteredRef.current.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const current = filteredRef.current[activeIndex];
        if (current) handleSelect(current);
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  // Filter commands based on query (navegación local)
  const filteredCommands = COMMANDS.filter(cmd => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      cmd.label.toLowerCase().includes(q) ||
      cmd.desc.toLowerCase().includes(q)
    );
  });

  // 2026-07-13: `filtered` combina navegación local + resultados API en un
  // solo array plano para simplificar keydown handler (flechas + Enter).
  // Cada item tiene `_type` para saber cómo renderizarlo y a dónde navegar.
  const filtered = useMemo(() => {
    const list = filteredCommands.map(cmd => ({ ...cmd, _type: 'nav' }));
    if (apiResults) {
      for (const [category, items] of Object.entries(apiResults)) {
        for (const it of items) {
          list.push({ ...it, _type: 'api', _category: category });
        }
      }
    }
    return list;
  }, [filteredCommands, apiResults]);

  // Keep ref in sync so keydown handler always reads the current filtered list
  filteredRef.current = filtered;

  // Reset active index when query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function handleSelect(item) {
    if (item._type === 'nav') {
      navigate(item.path);
    } else {
      // Item de la API — navigate al url (con buscar/filtro pre-aplicado).
      navigate(item.url);
    }
    onClose();
  }

  // Agrupamos por sección para render — mantenemos el orden: navegación primero,
  // después las 6 categorías de contenido.
  const grouped = useMemo(() => {
    const groups = [];
    const nav = filtered.filter(x => x._type === 'nav');
    if (nav.length) groups.push({ key: 'nav', label: 'Navegación', items: nav });
    for (const category of ['productos', 'ventas', 'contactos', 'envios', 'cajas', 'egresos']) {
      const items = filtered.filter(x => x._type === 'api' && x._category === category);
      if (items.length) {
        groups.push({ key: category, label: CATEGORY_LABELS[category], items });
      }
    }
    return groups;
  }, [filtered]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 520,
          width: 'calc(100% - 32px)',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' }}>
          <Icons.Search size={16} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar pantallas, productos, ventas, clientes…"
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
          {query && (
            <button
              onClick={() => setQuery('')}
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
          )}
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--hairline)' }} />

        {/* Results — grouped by section (Navegación + 6 categorías API) */}
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {filtered.length > 0 ? (
            grouped.map(group => (
              <div key={group.key}>
                <div style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  padding: '10px 16px 4px',
                }}>
                  {group.label}
                </div>
                {group.items.map(item => {
                  // idx global (para activeIndex/keyboard) porque `filtered` es plano.
                  const globalIdx = filtered.indexOf(item);
                  const isActive = globalIdx === activeIndex;
                  // Icon: nav usa item.icon; api usa por categoría.
                  const iconKey = item._type === 'nav' ? item.icon : CATEGORY_ICONS[item._category];
                  const Icon = Icons[iconKey];
                  return (
                    <div
                      key={`${item._type}-${item.id ?? item.path}`}
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setActiveIndex(globalIdx)}
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
                      }}
                    >
                      <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.6 }}>
                        {Icon && <Icon size={16} />}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 14, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item._type === 'nav' ? item.label : item.label}
                      </span>
                      <span style={{
                        fontSize: 13,
                        color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}>
                        {item._type === 'nav' ? item.desc : item.sublabel}
                      </span>
                      {/* Badge + amount opcionales para items API (estado + total) */}
                      {item._type === 'api' && item.badge && (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'var(--surface-2)',
                          color: 'var(--text-muted)',
                          flexShrink: 0,
                        }}>{item.badge}</span>
                      )}
                      {item._type === 'api' && item.amount && (
                        <span style={{
                          fontSize: 12,
                          fontWeight: 600,
                          fontFamily: 'monospace',
                          color: isActive ? 'var(--accent)' : 'var(--text)',
                          flexShrink: 0,
                        }}>{item.amount}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          ) : (
            <div style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 14,
            }}>
              {apiLoading ? 'Buscando…' : `Sin resultados para "${query}"`}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div style={{
          fontSize: 11,
          color: 'var(--text-dim)',
          padding: '10px 16px',
          borderTop: '1px solid var(--hairline)',
          display: 'flex',
          gap: 16,
        }}>
          <span><kbd style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 5px',
            fontSize: 10,
            fontFamily: 'monospace',
          }}>Esc</kbd> para cerrar</span>
          <span><kbd style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 5px',
            fontSize: 10,
            fontFamily: 'monospace',
          }}>↑↓</kbd> para navegar</span>
          <span><kbd style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 5px',
            fontSize: 10,
            fontFamily: 'monospace',
          }}>Enter</kbd> para ir</span>
        </div>
      </div>
    </div>
  );
}
