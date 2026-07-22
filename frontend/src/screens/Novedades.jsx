// Pantalla Novedades — lista de release notes que publica Tecny (task #142,
// 2026-07-16).
//
// Contexto: cuando Lucas mergea fixes/features, el cliente no se entera →
// dudas por WhatsApp. Este screen es el "changelog público del portal" +
// el CMS lo maneja el super-admin desde admin-frontend.
//
// UX:
//   · Header con contador de "nuevas desde tu última visita".
//   · Tabs de filtro por tipo (Todas / Feature / Mejora / Fix).
//   · Cards agrupadas por día (HOY / AYER / <fecha>).
//   · Notas "no vistas" tienen borde accent + dot celeste al lado del título.
//   · Al montar la pantalla: POST /mark-seen → limpia el badge del sidebar.
//     Emitimos también `release-notes:marked-seen` para que el Shell apague
//     el badge en la UI ya, sin esperar al próximo tick del poll (que tarda
//     hasta 5 min). Best-effort: si mark-seen falla, el badge se queda —
//     el próximo poll lo corregirá o se limpia solo la próxima vez que
//     el user entre.
//
// Backend:
//   · GET  /api/release-notes           → list (ordenada DESC por publicado_en)
//   · POST /api/release-notes/mark-seen → limpia el badge del user

import { useEffect, useMemo, useState } from 'react';
import { releaseNotes as releaseNotesApi } from '../lib/api';
import { Icons } from '../components/Icons';

// Meta por tipo — mantenido sincronizado con admin-frontend/Novedades.jsx.
// El emoji va como visual claro en la card, sin depender de un asset.
const TIPO_META = {
  feature: { emoji: '🚀', label: 'Nueva feature', tone: 'info' },
  mejora:  { emoji: '✨', label: 'Mejora',        tone: 'pos'  },
  fix:     { emoji: '🐛', label: 'Fix',           tone: 'warn' },
};

const TIPOS_ORDEN = ['feature', 'mejora', 'fix'];

// Agrupa notas por "día humano" — HOY, AYER, o "16 jul 2026".
// Devuelve [{ label, notas: [...] }] preservando el orden original (DESC).
function agruparPorDia(notas, ahora = new Date()) {
  const grupos = [];
  const map = new Map();
  const hoy = new Date(ahora); hoy.setHours(0, 0, 0, 0);
  const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);

  for (const n of notas) {
    const d = new Date(n.publicado_en);
    const key = new Date(d); key.setHours(0, 0, 0, 0);
    let label;
    if (key.getTime() === hoy.getTime()) label = 'Hoy';
    else if (key.getTime() === ayer.getTime()) label = 'Ayer';
    else label = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
    if (!map.has(label)) {
      const g = { label, notas: [] };
      map.set(label, g);
      grupos.push(g);
    }
    map.get(label).notas.push(n);
  }
  return grupos;
}

// Formatea solo la hora (HH:MM) para las notas de "Hoy"/"Ayer".
function fmtHora(iso) {
  try {
    return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function Novedades() {
  const [notas, setNotas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tipoFilter, setTipoFilter] = useState('todas'); // 'todas'|'feature'|'mejora'|'fix'
  // Snapshot de las que estaban unseen AL MOMENTO DE ABRIR la pantalla.
  // Necesario porque markSeen() cambia el count-unseen en el server ya y
  // no podemos consultar "cuáles eran unseen" después. Guardamos los IDs
  // para renderizar el borde accent + dot en las cards correctas.
  const [unseenIds, setUnseenIds] = useState(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        // Pedimos primero count-unseen para saber cuántas estaban nuevas,
        // ANTES de hacer mark-seen (que lo pone en 0). Luego pedimos la
        // lista y marcamos como unseen las N más recientes.
        const [cRes, lRes] = await Promise.all([
          releaseNotesApi.countUnseen().catch(() => ({ count: 0 })),
          releaseNotesApi.list(),
        ]);
        if (cancelled) return;
        const list = lRes.release_notes || [];
        setNotas(list);
        const unseenCount = Number(cRes?.count) || 0;
        // Las N más recientes son las unseen (backend garantiza orden DESC).
        setUnseenIds(new Set(list.slice(0, unseenCount).map((n) => n.id)));

        // Best-effort: no bloqueamos el render por esto. Si falla (offline,
        // 500 puntual), el badge queda hasta el próximo poll. El evento
        // apaga el badge en el Shell ANTES de esperar la respuesta del
        // POST — feedback visual inmediato (el POST es idempotente, si
        // falla el user simplemente lo vuelve a marcar la próxima vez).
        if (unseenCount > 0) {
          window.dispatchEvent(new CustomEvent('release-notes:marked-seen'));
          releaseNotesApi.markSeen().catch(() => {});
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'No se pudo cargar las novedades.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Counts por tipo — precomputados para las tabs. Sobre el array completo,
  // no el filtrado (así siempre ves los totales reales).
  const counts = useMemo(() => {
    const acc = { todas: notas.length, feature: 0, mejora: 0, fix: 0 };
    for (const n of notas) if (acc[n.tipo] != null) acc[n.tipo]++;
    return acc;
  }, [notas]);

  const notasFiltradas = useMemo(() => {
    if (tipoFilter === 'todas') return notas;
    return notas.filter((n) => n.tipo === tipoFilter);
  }, [notas, tipoFilter]);

  const grupos = useMemo(() => agruparPorDia(notasFiltradas), [notasFiltradas]);
  const totalUnseen = unseenIds.size;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title u-flex-center-gap-10">
            Novedades
            {totalUnseen > 0 && (
              <span className="u-novedades-count-badge">
                {totalUnseen} nueva{totalUnseen === 1 ? '' : 's'}
              </span>
            )}
          </h1>
          <div className="page-sub">
            Cambios y mejoras del portal — te vas enterando de todo lo que va apareciendo.
          </div>
        </div>
      </div>

      {/* Tabs de filtro por tipo. Todas / 🚀 Feature / ✨ Mejora / 🐛 Fix con counts. */}
      <div
        role="tablist"
        aria-label="Filtrar por tipo"
        className="u-novedades-tablist"
      >
        {[
          { value: 'todas',   label: 'Todas',          emoji: null },
          { value: 'feature', label: 'Features',       emoji: '🚀' },
          { value: 'mejora',  label: 'Mejoras',        emoji: '✨' },
          { value: 'fix',     label: 'Fixes',          emoji: '🐛' },
        ].map((t) => {
          const active = tipoFilter === t.value;
          const n = counts[t.value] || 0;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTipoFilter(t.value)}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: 'none',
                color: active ? 'var(--text)' : 'var(--text-muted)',
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
                borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'inherit',
              }}
            >
              {t.emoji && <span aria-hidden="true">{t.emoji}</span>}
              {t.label}
              <span className="u-color-dim-fs-11">{n}</span>
            </button>
          );
        })}
      </div>

      {/* Estados: loading / error / empty / contenido */}
      {loading ? (
        <div className="muted u-p-40-text-center-fs-13">
          Cargando…
        </div>
      ) : error ? (
        <div className="u-p-24-color-neg-fs-13">
          {error}
        </div>
      ) : notasFiltradas.length === 0 ? (
        <div
          className="muted u-p-40-text-center-fs-13"
        >
          {tipoFilter === 'todas'
            ? 'Todavía no hay novedades publicadas.'
            : `No hay ${tipoFilter}s publicados.`}
        </div>
      ) : (
        <div className="u-mw-760">
          {grupos.map((g, gi) => (
            <div key={g.label + gi}>
              <div className={`u-novedades-group-label ${gi === 0 ? 'u-mb-10' : 'u-mt-20-mb-10'}`}>
                <span className="u-flex-1-h-1-bg-border" />
                <span>{g.label}</span>
                <span className="u-flex-1-h-1-bg-border" />
              </div>
              <div className="u-flex-col-gap-12">
                {g.notas.map((n) => (
                  <Nota key={n.id} nota={n} unseen={unseenIds.has(n.id)} groupLabel={g.label} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card individual ────────────────────────────────────────────────────

function Nota({ nota, unseen, groupLabel }) {
  const meta = TIPO_META[nota.tipo] || TIPO_META.feature;
  const tone = meta.tone; // 'info' | 'pos' | 'warn'
  const bg = `var(--${tone}-soft)`;
  const fg = `var(--${tone})`;
  const showHora = groupLabel === 'Hoy' || groupLabel === 'Ayer';

  return (
    <article
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr auto',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 10,
        border: unseen ? '1px solid var(--accent)' : '1px solid var(--border)',
        background: unseen
          ? 'linear-gradient(180deg, var(--accent-soft), transparent 40%), var(--surface)'
          : 'var(--surface)',
        alignItems: 'flex-start',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: bg,
          color: fg,
          display: 'grid',
          placeItems: 'center',
          fontSize: 18,
        }}
      >
        {meta.emoji}
      </div>
      <div className="u-mw-min-0">
        <span
          style={{
            display: 'inline-block',
            padding: '2px 7px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
            background: bg,
            color: fg,
            marginBottom: 4,
          }}
        >
          {meta.label}
        </span>
        <h3 className="u-novedades-title">
          {nota.titulo}
          {unseen && (
            <span
              aria-label="Nueva"
              title="Nueva desde tu última visita"
              className="u-novedades-unseen-dot"
            />
          )}
        </h3>
        <p className="u-novedades-desc">
          {nota.descripcion}
        </p>
      </div>
      <div className="u-novedades-date">
        {showHora ? groupLabel : ''}
        {showHora && <br />}
        {showHora ? fmtHora(nota.publicado_en) : new Date(nota.publicado_en).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
      </div>
    </article>
  );
}
