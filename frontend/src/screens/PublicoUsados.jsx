// PublicoUsados.jsx — Pantalla pública del share link de Equipos Usados (2026-07-11).
//
// Ruta: /publico/usados/:token — SIN Shell (fuera de la sesión del portal).
// Consume GET /publico/usados/:token que es sin auth + rate-limited + cached.
//
// Diseño (validado con Lucas 2026-07-11 en mockup HTML):
//   - Light theme (se diferencia del portal admin dark).
//   - Header con nombre del tenant + país + "Actualizado hace X min".
//   - Hero con "Usados disponibles" + subtítulo + count.
//   - Controls bar: buscar live + filtro precio (inputs + chips presets)
//     + toggle Cards ↔ Lista.
//   - Grupos automáticos por línea (regex sobre nombre: "iPhone 17", "iPh 12 Pro", etc.).
//   - Fallback grupo "Otros modelos" para lo que no matchea (Samsung, etc.).
//   - Cards en grid + vista lista compacta alternativa.
//   - Footer con CTA WhatsApp opcional.
//   - Errores manejados: 404, 410 (link inactivo), 429 (rate limit), 5xx.

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { publico } from '../lib/api';
// Sprint 104 CSP hardening: los estilos vivían en un template string
// PUB_STYLES renderizado como un elemento style con contenido dinámico
// en 3 lugares. Cada uno de esos bloques es un CSP `style-src 'unsafe-inline'`
// violation (además del pattern JSX inline que ya migramos en sprints
// anteriores). Extraído a PublicoUsados.css (importado como side-effect por
// Vite, se aplica una sola vez al montar la route). Cierra 3 vectores de
// inline-style de golpe.
import './PublicoUsados.css';

// Regex para extraer la línea del nombre del producto. Matchea:
//   "iPhone 17", "iPh 12 Pro Max", "iphone 11 pro", "iPh 16e", etc.
// El primer grupo captura el número (1-2 dígitos).
const LINEA_REGEX = /i(?:phone|ph)\s*(\d{1,2})/i;

// Emoji por línea. Fallback 📱 para números que no están mapeados.
function emojiPorLinea(n) {
  const map = {
    17: '💎',
    16: '🚀',
    15: '💥',
    14: '🔥',
    13: '🔥',
  };
  return map[n] || '📱';
}

function fmtN(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

// "hace N días" desde ISO string.
function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const now = Date.now();
  const diffMs = now - then;
  const dias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hrs  = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor(diffMs / (1000 * 60));
  if (dias >= 1) return `hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
  if (hrs >= 1)  return `hace ${hrs} ${hrs === 1 ? 'hora' : 'horas'}`;
  if (mins >= 5) return `hace ${mins} min`;
  return 'recién actualizado';
}

// Bandera del país. Solo AR/UY por ahora (misma dupla que multi-país F2/F3).
function bandera(pais) {
  if (pais === 'UY') return '🇺🇾';
  return '🇦🇷';
}

// ── Batería con color según nivel ──
function BateriaChip({ bat }) {
  if (bat == null || bat === '') return null;
  const v = Number(bat);
  if (!Number.isFinite(v)) return null;
  const tono = v >= 85 ? 'high' : v >= 75 ? 'mid' : 'low';
  return <span className={`chip bat-${tono}`}>{v}%</span>;
}

// ── Card item ──
function ItemCard({ p, config, showSince }) {
  const chips = [];
  if (p.gb) chips.push(<span key="gb" className="chip">{p.gb} GB</span>);
  if (p.color) chips.push(<span key="c" className="chip">{p.color}</span>);
  if (config.mostrar_bateria && p.bateria != null) {
    chips.push(<BateriaChip key="b" bat={p.bateria} />);
  }
  return (
    <div className="item">
      <div className="item-head">
        <span className="item-emoji" aria-hidden="true">{p.clase_emoji || '♻️'}</span>
        <h3 className="item-title">{p.nombre}</h3>
      </div>
      <div className="item-chips">{chips}</div>
      <div className="item-foot">
        <div>
          {config.mostrar_precio && p.precio_venta ? (
            <>
              <span className="price-ccy">{p.precio_moneda || 'USD'}</span>
              <span className="price">{fmtN(p.precio_venta)}</span>
            </>
          ) : (
            <span className="price-consultar">Consultar por WhatsApp</span>
          )}
        </div>
        {showSince && <span className="item-since">{timeAgo(p.created_at)}</span>}
      </div>
    </div>
  );
}

// ── Detección de línea + agrupación ──
function agruparPorLinea(equipos) {
  const grupos = new Map(); // key: número (o 'otros'), value: { linea, emoji, items }
  for (const e of equipos) {
    const m = String(e.nombre || '').match(LINEA_REGEX);
    const linea = m ? Number(m[1]) : 'otros';
    if (!grupos.has(linea)) {
      grupos.set(linea, {
        linea,
        emoji: linea === 'otros' ? '🔷' : emojiPorLinea(linea),
        label: linea === 'otros' ? 'Otros modelos' : `Línea ${linea} & Variables`,
        items: [],
      });
    }
    grupos.get(linea).items.push(e);
  }
  // Ordenar: números DESC primero, 'otros' al final.
  const orden = Array.from(grupos.values()).sort((a, b) => {
    if (a.linea === 'otros') return 1;
    if (b.linea === 'otros') return -1;
    return b.linea - a.linea;
  });
  // Dentro de cada grupo, ordenar por precio DESC.
  orden.forEach(g => g.items.sort((a, b) => (Number(b.precio_venta) || 0) - (Number(a.precio_venta) || 0)));
  return orden;
}

// ── Chips de precio predefinidos ──
const PRICE_CHIPS = [
  { label: 'Hasta USD 500',    min: 0,    max: 500 },
  { label: 'USD 500 – 800',    min: 500,  max: 800 },
  { label: 'USD 800 – 1.200',  min: 800,  max: 1200 },
  { label: 'USD 1.200+',       min: 1200, max: null },
];

// ═════════════════════════════════════════════════════════════════
export default function PublicoUsados() {
  const { token } = useParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { code, mensaje }

  // Filtros
  const [buscar, setBuscar] = useState('');
  const [minPrecio, setMinPrecio] = useState('');
  const [maxPrecio, setMaxPrecio] = useState('');
  // Vista: cards | lista. Persiste en localStorage.
  const [vista, setVista] = useState(() => {
    try { return localStorage.getItem('pubUsadosView') === 'list' ? 'list' : 'cards'; }
    catch { return 'cards'; }
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    publico.usados(token)
      .then(r => { if (!cancelled) { setData(r); setLoading(false); } })
      .catch(err => {
        if (cancelled) return;
        setError({
          code:    err.code || 'error',
          status:  err.status,
          mensaje: err.message,
        });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  const setVistaConPersist = useCallback((v) => {
    setVista(v);
    try { localStorage.setItem('pubUsadosView', v); } catch { /* ignore */ }
  }, []);

  // Filtrado combinado (buscar + rango precio) sobre TODOS los equipos.
  const equiposFiltrados = useMemo(() => {
    if (!data?.equipos) return [];
    const q = buscar.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const min = Number(minPrecio) || 0;
    const max = Number(maxPrecio) || Infinity;
    return data.equipos.filter(e => {
      const hay = [e.nombre, e.gb, e.color, e.bateria, e.clase_nombre]
        .filter(Boolean).join(' ').toLowerCase();
      const matchSearch = terms.length === 0 || terms.every(t => hay.includes(t));
      const price = Number(e.precio_venta) || 0;
      const matchPrice = price >= min && price <= max;
      return matchSearch && matchPrice;
    });
  }, [data, buscar, minPrecio, maxPrecio]);

  const grupos = useMemo(() => agruparPorLinea(equiposFiltrados), [equiposFiltrados]);

  const totalEquipos = data?.equipos?.length ?? 0;
  const visibles = equiposFiltrados.length;
  const hasFilter = buscar.trim() || minPrecio !== '' || maxPrecio !== '';

  // ── Estados de error / loading ──
  if (loading) {
    return (
      <div className="pub-shell">
        <div className="pub-loading">
          <div className="pub-spinner" />
          <p>Cargando listado…</p>
        </div>
      </div>
    );
  }

  if (error) {
    let title = 'Ocurrió un error';
    let sub = 'Intentá de nuevo en unos minutos.';
    if (error.code === 'not_found' || error.status === 404) {
      title = 'Listado no encontrado';
      sub = 'El link puede haber cambiado. Pedí al negocio el link actualizado.';
    } else if (error.code === 'link_inactivo' || error.status === 410) {
      title = 'Este listado ya no está disponible';
      sub = 'El negocio dejó de compartirlo. Escribile directamente para consultar por stock.';
    } else if (error.status === 429) {
      title = 'Demasiados intentos';
      sub = 'Esperá un momento y volvé a intentar.';
    }
    return (
      <div className="pub-shell">
        <div className="pub-error">
          <div className="pub-error-icon">🔒</div>
          <h1>{title}</h1>
          <p>{sub}</p>
        </div>
      </div>
    );
  }

  const iniciales = String(data.tenant.nombre || 'TC').slice(0, 2).toUpperCase();

  return (
    <div className="pub-shell">
      <div className={`pub ${vista === 'list' ? 'view-list' : ''}`}>
        {/* Header */}
        <div className="pub-header">
          <div className="pub-logo" aria-hidden="true">{iniciales}</div>
          <div className="pub-brand">
            <h1>{data.tenant.nombre}</h1>
            <p>
              <span>{bandera(data.tenant.pais)} {data.tenant.pais === 'UY' ? 'Uruguay' : 'Argentina'}</span>
              <span className="pub-badge">Actualizado {timeAgo(data.actualizado_en)}</span>
            </p>
          </div>
        </div>

        {/* Hero */}
        <div className="pub-hero">
          <div>
            <h2 className="pub-hero-title">Usados disponibles</h2>
            <div className="pub-hero-sub">
              {data.config.mensaje_extra
                ? data.config.mensaje_extra
                : (data.config.mostrar_precio ? 'Precios en USD · Consultá por más info' : 'Consultá por precios y stock')}
            </div>
          </div>
          <span className="pub-hero-count">{hasFilter ? visibles : totalEquipos} equipos</span>
        </div>

        {/* Controls: búsqueda + precio + toggle vista */}
        <div className="controls-bar">
          <div className="search-wrap">
            <span className="search-icon" aria-hidden="true">🔍</span>
            <input
              className="search-input"
              placeholder="Buscar por modelo, GB, color…"
              value={buscar}
              onChange={e => setBuscar(e.target.value)}
              autoComplete="off"
            />
            {buscar && (
              <button className="search-clear" onClick={() => setBuscar('')} aria-label="Limpiar búsqueda">×</button>
            )}
          </div>
          {data.config.mostrar_precio && (
            <div className="price-range">
              <span className="price-range-label">USD</span>
              <input
                type="number"
                className="price-input"
                placeholder="desde"
                min="0" step="10"
                value={minPrecio}
                onChange={e => setMinPrecio(e.target.value)}
                aria-label="Precio mínimo USD"
              />
              <span className="price-range-dash">–</span>
              <input
                type="number"
                className="price-input"
                placeholder="hasta"
                min="0" step="10"
                value={maxPrecio}
                onChange={e => setMaxPrecio(e.target.value)}
                aria-label="Precio máximo USD"
              />
            </div>
          )}
          <div className="view-toggle" role="tablist" aria-label="Vista">
            <button
              className={vista === 'cards' ? 'active' : ''}
              onClick={() => setVistaConPersist('cards')}
              aria-pressed={vista === 'cards'}
            >
              ▦ Cards
            </button>
            <button
              className={vista === 'list' ? 'active' : ''}
              onClick={() => setVistaConPersist('list')}
              aria-pressed={vista === 'list'}
            >
              ☰ Lista
            </button>
          </div>
        </div>

        {/* Price chips presets */}
        {data.config.mostrar_precio && (
          <div className="price-chips">
            {PRICE_CHIPS.map(chip => {
              const isActive = Number(minPrecio) === chip.min
                && (chip.max === null ? maxPrecio === '' : Number(maxPrecio) === chip.max);
              return (
                <button
                  key={chip.label}
                  className={`price-chip ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    if (isActive) {
                      setMinPrecio(''); setMaxPrecio('');
                    } else {
                      setMinPrecio(String(chip.min));
                      setMaxPrecio(chip.max == null ? '' : String(chip.max));
                    }
                  }}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Info strip cuando hay filtros activos */}
        {hasFilter && (
          <div className="search-info">
            Mostrando <strong>{visibles}</strong> de {totalEquipos} equipos
            {buscar && <> · buscando "<strong>{buscar}</strong>"</>}
            {minPrecio && maxPrecio && <> · entre USD {minPrecio} y USD {maxPrecio}</>}
            {minPrecio && !maxPrecio && <> · desde USD {minPrecio}</>}
            {!minPrecio && maxPrecio && <> · hasta USD {maxPrecio}</>}
          </div>
        )}

        {/* Grupos */}
        {visibles === 0 ? (
          <div className="empty-search">
            <div className="empty-search-icon">🔍</div>
            <h3>{hasFilter ? 'Sin resultados' : 'Sin equipos disponibles ahora'}</h3>
            <p>{hasFilter ? 'Probá con otro modelo, color o rango de precio.' : 'Volvé más tarde o consultá por WhatsApp por stock actualizado.'}</p>
          </div>
        ) : grupos.map(g => (
          <div key={g.linea} className="group-block">
            <div className="group-header">
              <span className="group-emoji" aria-hidden="true">{g.emoji}</span>
              <span>{g.label}</span>
              <span className="group-count">{g.items.length} {g.items.length === 1 ? 'equipo' : 'equipos'}</span>
            </div>
            <div className="items">
              {g.items.map(item => (
                <ItemCard key={item.id} p={item} config={data.config} showSince={true} />
              ))}
            </div>
          </div>
        ))}

        {/* Footer CTA */}
        <div className="pub-footer">
          <h3>¿Te interesa alguno?</h3>
          <p>Escribinos para reservar o consultar por más detalles</p>
          {data.config.whatsapp ? (
            <a
              className="pub-wa-btn"
              href={`https://wa.me/${String(data.config.whatsapp).replace(/[^\d]/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              💬 {data.config.whatsapp}
            </a>
          ) : (
            <p className="pub-nowa">Contactá al negocio por el canal habitual.</p>
          )}
          <div className="pub-legal">
            Precios sujetos a disponibilidad · Se actualiza en tiempo real desde el inventario
          </div>
        </div>
      </div>
    </div>
  );
}
