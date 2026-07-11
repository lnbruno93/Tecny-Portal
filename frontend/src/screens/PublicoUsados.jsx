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
        <style>{PUB_STYLES}</style>
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
        <style>{PUB_STYLES}</style>
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
      <style>{PUB_STYLES}</style>
    </div>
  );
}

// Estilos inline (self-contained — la pantalla vive fuera del Shell). Se
// escribe en un template string para reusar variables CSS + media queries.
const PUB_STYLES = `
  :root {
    --pub-bg: #f8f7f3;
    --pub-surface: #ffffff;
    --pub-border: #e6e0d0;
    --pub-text: #1c1a14;
    --pub-text-muted: #76705c;
    --pub-accent: #0d1220;
    --pub-pos: #059669;
    --pub-warn: #d97706;
    --pub-neg: #dc2626;
  }
  .pub-shell {
    background: var(--pub-bg);
    color: var(--pub-text);
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 20px 16px 40px;
  }
  .pub {
    max-width: 1080px;
    margin: 0 auto;
    font-size: 14px;
  }
  .pub-loading, .pub-error {
    max-width: 500px;
    margin: 80px auto;
    text-align: center;
    padding: 40px 20px;
    background: var(--pub-surface);
    border-radius: 14px;
    border: 1px solid var(--pub-border);
  }
  .pub-loading p { color: var(--pub-text-muted); }
  .pub-spinner {
    width: 40px; height: 40px;
    border: 3px solid var(--pub-border);
    border-top-color: var(--pub-accent);
    border-radius: 50%;
    margin: 0 auto 16px;
    animation: pub-spin 0.8s linear infinite;
  }
  @keyframes pub-spin { to { transform: rotate(360deg); } }
  .pub-error-icon { font-size: 44px; margin-bottom: 12px; }
  .pub-error h1 { margin: 0 0 8px; font-size: 20px; }
  .pub-error p { color: var(--pub-text-muted); margin: 0; }

  .pub-header {
    display: flex; align-items: center; gap: 12px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--pub-border);
    margin-bottom: 20px;
  }
  .pub-logo {
    width: 44px; height: 44px;
    background: var(--pub-accent);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 18px;
    flex-shrink: 0;
  }
  .pub-brand h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .pub-brand p {
    margin: 2px 0 0; font-size: 12.5px;
    color: var(--pub-text-muted);
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .pub-badge {
    display: inline-flex; padding: 2px 8px;
    border-radius: 12px;
    background: var(--pub-border);
    color: var(--pub-text-muted);
    font-size: 11px; font-weight: 500;
  }

  .pub-hero {
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    border-radius: 14px;
    padding: 16px 18px;
    margin-bottom: 12px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; flex-wrap: wrap;
  }
  .pub-hero-title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
  .pub-hero-sub { font-size: 13px; color: var(--pub-text-muted); margin-top: 4px; }
  .pub-hero-count {
    background: var(--pub-accent); color: #fff;
    padding: 8px 14px; border-radius: 10px;
    font-size: 13px; font-weight: 600;
    white-space: nowrap;
  }

  .controls-bar {
    display: flex; gap: 10px;
    margin-bottom: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .search-wrap {
    flex: 1; min-width: 220px;
    position: relative;
    display: flex; align-items: center;
  }
  .search-icon {
    position: absolute; left: 14px;
    color: var(--pub-text-muted);
    pointer-events: none;
  }
  .search-input {
    width: 100%;
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    color: var(--pub-text);
    padding: 10px 40px 10px 40px;
    border-radius: 10px;
    font-size: 14px;
    outline: none;
    font-family: inherit;
    transition: border-color 0.15s;
  }
  .search-input:focus { border-color: var(--pub-accent); }
  .search-clear {
    position: absolute; right: 8px;
    background: transparent; border: none;
    color: var(--pub-text-muted);
    cursor: pointer;
    font-size: 20px;
    padding: 4px 10px;
    line-height: 1;
  }
  .price-range {
    display: inline-flex; align-items: center;
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    border-radius: 10px;
    padding: 3px 10px;
    gap: 4px;
    height: 42px;
  }
  .price-range-label {
    font-size: 11.5px;
    color: var(--pub-text-muted);
    font-weight: 500;
    letter-spacing: 0.5px;
    padding-right: 2px;
  }
  .price-input {
    width: 68px;
    background: transparent;
    border: none;
    color: var(--pub-text);
    padding: 6px 4px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    outline: none;
    text-align: center;
    font-family: inherit;
  }
  .price-input::-webkit-outer-spin-button, .price-input::-webkit-inner-spin-button {
    -webkit-appearance: none; margin: 0;
  }
  .price-input[type=number] { -moz-appearance: textfield; }
  .price-range-dash { color: var(--pub-text-muted); }
  .price-chips {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-bottom: 20px;
  }
  .price-chip {
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    color: var(--pub-text-muted);
    padding: 6px 12px;
    border-radius: 18px;
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
    font-weight: 500;
  }
  .price-chip:hover { color: var(--pub-text); border-color: var(--pub-text-muted); }
  .price-chip.active {
    background: var(--pub-accent);
    color: #fff;
    border-color: var(--pub-accent);
  }
  .view-toggle {
    display: flex;
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
  }
  .view-toggle button {
    background: transparent; border: none;
    padding: 7px 12px;
    cursor: pointer;
    color: var(--pub-text-muted);
    font-size: 13px;
    border-radius: 7px;
    font-family: inherit;
    font-weight: 500;
    transition: all 0.15s;
  }
  .view-toggle button.active {
    background: var(--pub-accent);
    color: #fff;
  }
  .search-info {
    background: rgba(61, 157, 243, 0.06);
    border: 1px solid rgba(61, 157, 243, 0.15);
    border-radius: 8px;
    padding: 8px 14px;
    margin-bottom: 16px;
    font-size: 12.5px;
    color: var(--pub-text-muted);
  }
  .search-info strong { color: var(--pub-text); }

  .group-block { margin-top: 8px; }
  .group-header {
    display: flex; align-items: center; gap: 10px;
    margin: 24px 0 12px;
    font-size: 15px; font-weight: 600;
  }
  .group-header .group-emoji { font-size: 20px; }
  .group-header .group-count {
    font-size: 12px; font-weight: 500;
    color: var(--pub-text-muted);
    background: var(--pub-border);
    padding: 2px 8px; border-radius: 10px;
  }
  .group-block:first-of-type .group-header { margin-top: 8px; }

  .items {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .item {
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    border-radius: 14px;
    padding: 16px;
    display: flex; flex-direction: column; gap: 10px;
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .item:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
  }
  .item-head { display: flex; align-items: flex-start; gap: 10px; }
  .item-emoji { font-size: 20px; line-height: 1; flex-shrink: 0; }
  .item-title { font-size: 15px; font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; margin: 0; flex: 1; }
  .item-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    background: var(--pub-border);
    color: var(--pub-text-muted);
    padding: 3px 10px; border-radius: 20px;
    font-size: 12px; font-weight: 500;
  }
  .chip.bat-high { background: rgba(5, 150, 105, 0.1); color: var(--pub-pos); }
  .chip.bat-mid { background: rgba(217, 119, 6, 0.1); color: var(--pub-warn); }
  .chip.bat-low { background: rgba(220, 38, 38, 0.1); color: var(--pub-neg); }
  .item-foot {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-top: 4px; padding-top: 10px;
    border-top: 1px dashed var(--pub-border);
  }
  .price {
    font-size: 22px; font-weight: 700; color: var(--pub-text);
    letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
  }
  .price-ccy {
    font-size: 12px; color: var(--pub-text-muted);
    font-weight: 500; margin-right: 4px;
  }
  .price-consultar {
    font-size: 13px;
    color: var(--pub-text-muted);
    font-style: italic;
  }
  .item-since { font-size: 11.5px; color: var(--pub-text-muted); }

  /* Vista Lista compacta */
  .pub.view-list .items {
    display: flex; flex-direction: column; gap: 6px;
  }
  .pub.view-list .item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    gap: 14px;
    padding: 12px 16px;
    border-radius: 10px;
    align-items: center;
  }
  .pub.view-list .item:hover { transform: none; box-shadow: none; background: rgba(0,0,0,0.02); }
  .pub.view-list .item-head { display: contents; }
  .pub.view-list .item-emoji { font-size: 18px; }
  .pub.view-list .item-title {
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pub.view-list .item-chips { gap: 4px; flex-shrink: 0; }
  .pub.view-list .chip { padding: 2px 8px; font-size: 11.5px; }
  .pub.view-list .item-foot { display: contents; }
  .pub.view-list .item-foot > div:first-child {
    justify-self: end;
    display: flex; align-items: baseline; gap: 3px;
  }
  .pub.view-list .price { font-size: 16px; }
  .pub.view-list .item-since {
    justify-self: end;
    font-size: 11px;
    min-width: 78px;
    text-align: right;
  }

  @media (max-width: 700px) {
    .pub.view-list .item {
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
      row-gap: 6px;
    }
    .pub.view-list .item-chips { grid-column: 1 / -1; grid-row: 2; }
    .pub.view-list .item-since { display: none; }
    .pub-hero-title { font-size: 19px; }
  }

  .empty-search {
    padding: 40px 20px;
    text-align: center;
    color: var(--pub-text-muted);
    background: var(--pub-surface);
    border: 1px dashed var(--pub-border);
    border-radius: 14px;
  }
  .empty-search-icon { font-size: 32px; margin-bottom: 8px; }
  .empty-search h3 { margin: 0 0 4px; font-size: 15px; color: var(--pub-text); font-weight: 600; }
  .empty-search p { margin: 0; font-size: 13px; }

  .pub-footer {
    margin-top: 32px;
    padding: 24px;
    background: var(--pub-surface);
    border: 1px solid var(--pub-border);
    border-radius: 14px;
    text-align: center;
  }
  .pub-footer h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  .pub-footer p { margin: 0 0 14px; color: var(--pub-text-muted); font-size: 13px; }
  .pub-nowa { color: var(--pub-text-muted); font-size: 13px; margin: 0; }
  .pub-wa-btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: #25d366; color: white;
    padding: 10px 20px; border-radius: 22px;
    font-weight: 600; font-size: 14px;
    text-decoration: none;
  }
  .pub-legal {
    margin-top: 12px; font-size: 11px;
    color: var(--pub-text-muted);
  }
`;
