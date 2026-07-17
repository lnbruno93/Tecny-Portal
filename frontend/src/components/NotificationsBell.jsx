// NotificationsBell.jsx — Bell icon + dropdown unificado.
//
// Historia:
//   - 2026-06-29 (#458 F5): componente original solo cubría Red B2B
//     (RedB2BNotificationsBell.jsx). Requería cap cross_tenant.write.
//   - 2026-07-17: Lucas pidió que las Novedades (release notes de Tecny)
//     además de aparecer en el badge del sidebar, aparezcan en la
//     campanita. Solución: renombrar + generalizar el bell. Ahora
//     agrupa 2 fuentes de notificaciones en un solo dropdown con
//     secciones separadas.
//
// Fuentes de notificaciones:
//   1. Novedades — release notes de Tecny (globales, mismas para todos
//      los tenants). Sin gate de capability — todos los users las ven.
//   2. Red B2B — notificaciones cross-tenant (invitaciones, pagos,
//      operaciones, etc). Gate: user con cap cross_tenant.write.
//
// Behavior:
//   - Bell siempre visible (aunque el user no tenga cap b2b, va a ver la
//     sección Novedades). Badge sólo si hay algo unread.
//   - Badge count = novedades unseen + b2b unread. "99+" si > 99.
//   - Polling: Novedades cada 5 min (release notes cambian pocas veces
//     por semana), Red B2B cada 60s (más volátil). Ambos refrescan
//     también al volver el tab (visibilitychange).
//   - Dropdown: sección "Novedades" arriba (con badge "nueva" en las
//     unseen), sección "Red B2B" abajo (si tiene cap). Cada sección
//     tiene su propio "Ver todas →" al footer.
//   - Click en novedad: navega a /novedades. Como el endpoint mark-seen
//     es global (setea last_seen = NOW() → marca TODAS de un tirón),
//     ese mismo mark-seen lo dispara /novedades al abrir la pantalla.
//     También emitimos `release-notes:marked-seen` para que el badge
//     del sidebar se apague en el próximo tick.
//   - Click en notif b2b: mismo comportamiento actual — mark-read
//     individual + navegar al recurso específico.
//   - "Marcar todo como leído" arriba: llama a ambos mark-all en paralelo.
//
// Compat: el import antiguo `RedB2BNotificationsBell` sigue existiendo
// como re-export defensivo (por si algún test lo consumía sin actualizar).

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Icons } from './Icons';
import { redB2b as redB2bApi, releaseNotes as releaseNotesApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

const POLL_INTERVAL_B2B_MS       = 60 * 1000;       // 60s
const POLL_INTERVAL_NOVEDADES_MS = 5  * 60 * 1000;  // 5 min

// Preview de Novedades en el dropdown. La pantalla /novedades muestra todo.
const NOVEDADES_PREVIEW_LIMIT = 5;

// ─── Formateo compartido ──────────────────────────────────────────────────────

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRelative(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'recién';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `hace ${diffD} d`;
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}

// ─── Descriptores por tipo (Red B2B) ──────────────────────────────────────────

// Mapping type → ruta + label legible. Si type no está acá, fallback genérico.
function describeB2bNotif(n) {
  const p = n.payload || {};
  const partner = p.partner?.nombre || p.partnerNombre || p.from_tenant?.nombre || 'Un partner';
  switch (n.type) {
    case 'invitation_received':
      return { label: `${partner} te invitó a Red B2B`, route: '/red-b2b' };
    case 'invitation_accepted':
      return { label: `${partner} aceptó tu invitación`, route: '/red-b2b' };
    case 'invitation_rejected':
      return { label: `${partner} rechazó tu invitación`, route: '/red-b2b' };
    case 'partnership_revoked':
      return { label: `${partner} revocó la partnership`, route: '/red-b2b' };
    case 'operation_received':
      return {
        label: `${partner} te envió una venta de USD ${fmtUsd(p.total_usd)}`,
        route: n.cross_tenant_operation_id
          ? `/red-b2b/operaciones/${n.cross_tenant_operation_id}`
          : '/red-b2b/operaciones',
      };
    case 'operation_modified':
      return {
        label: `${partner} modificó una venta`,
        route: n.cross_tenant_operation_id
          ? `/red-b2b/operaciones/${n.cross_tenant_operation_id}`
          : '/red-b2b/operaciones',
      };
    case 'operation_cancelled':
      return {
        label: `${partner} canceló una venta`,
        route: n.cross_tenant_operation_id
          ? `/red-b2b/operaciones/${n.cross_tenant_operation_id}`
          : '/red-b2b/operaciones',
      };
    case 'payment_received':
    case 'payment_registered':
      return {
        label: `${partner} registró un pago de USD ${fmtUsd(p.monto_usd)}`,
        route: n.cross_tenant_operation_id
          ? `/red-b2b/operaciones/${n.cross_tenant_operation_id}`
          : '/red-b2b/operaciones',
      };
    case 'product_pending_review':
      return { label: 'Tenés productos pendientes de revisión', route: '/red-b2b/pending-review' };
    default:
      return { label: 'Notificación Red B2B', route: '/red-b2b' };
  }
}

// Emoji por tipo de release note (mismo mapping que la pantalla /novedades).
const TIPO_NOVEDAD_EMOJI = {
  feature: '✨',
  fix: '🐛',
  mejora: '💫',
  breaking: '⚠️',
  info: 'ℹ️',
};

// ─── Capability helper ────────────────────────────────────────────────────────

function userHasCapB2b(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.tenant_cap_rol === 'owner' || user.tenant_cap_rol === 'admin') return true;
  if (user.caps === null) return true;
  if (Array.isArray(user.caps) && user.caps.includes('cross_tenant.write')) return true;
  return false;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function NotificationsBell() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const hasB2b = userHasCapB2b(user);

  // Estado — 2 fuentes independientes.
  const [novedadesCount, setNovedadesCount] = useState(0);
  const [novedadesItems, setNovedadesItems] = useState([]);
  const [novedadesLastSeenAt, setNovedadesLastSeenAt] = useState(null);
  const [b2bCount, setB2bCount] = useState(0);
  const [b2bItems, setB2bItems] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [open, setOpen] = useState(false);
  // 2026-07-17 (post-#658): posición del panel calculada en runtime a partir
  // de la bounding rect del botón. Necesario porque el panel se renderea vía
  // React Portal en <body> — ya no puede posicionarse relative al botón.
  // Ver comentario sobre el portal más abajo.
  const [panelPos, setPanelPos] = useState({ top: 0, right: 0 });
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  // Calcular la posición del panel: bajo el botón, alineado a la derecha.
  // Se corre al abrir y en cada resize/scroll para mantener el panel pegado.
  const recomputePanelPos = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 8,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    recomputePanelPos();
  }, [open, recomputePanelPos]);

  // Sync de posición en resize + scroll. Si el user scrollea con el dropdown
  // abierto, el panel se mueve con el botón. (Alternativa: cerrar en scroll,
  // pero eso es peor UX cuando el user está leyendo el dropdown.)
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', recomputePanelPos);
    window.addEventListener('scroll', recomputePanelPos, true);
    return () => {
      window.removeEventListener('resize', recomputePanelPos);
      window.removeEventListener('scroll', recomputePanelPos, true);
    };
  }, [open, recomputePanelPos]);

  // ── Poll: Novedades (5 min + on visibility) ─────────────────────────────────
  //
  // Sin gate de cap: todos los users ven Novedades. Ver `count-unseen` en
  // routes/releaseNotes.js — usa users.last_seen_release_notes_at como
  // pivot; NULL = user nunca las abrió, cuenta todas las publicadas.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function refresh() {
      releaseNotesApi.countUnseen()
        .then((r) => { if (!cancelled) setNovedadesCount(Number(r.count) || 0); })
        .catch(() => {});
    }
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_NOVEDADES_MS);
    function onVis() { if (document.visibilityState === 'visible') refresh(); }
    document.addEventListener('visibilitychange', onVis);
    // Cuando /novedades marca seen, apagamos el count acá también sin
    // esperar 5 min al próximo tick del poll.
    function onMarkedSeen() { if (!cancelled) setNovedadesCount(0); }
    window.addEventListener('release-notes:marked-seen', onMarkedSeen);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('release-notes:marked-seen', onMarkedSeen);
    };
  }, [user]);

  // ── Poll: Red B2B (60s) — solo si el user tiene cap ─────────────────────────
  useEffect(() => {
    if (!hasB2b) return;
    let cancelled = false;
    function refresh() {
      redB2bApi.notifications.countUnread()
        .then((r) => { if (!cancelled) setB2bCount(Number(r.count) || 0); })
        .catch(() => {});
    }
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_B2B_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [hasB2b]);

  // ── Cargar listas cuando se abre el dropdown ────────────────────────────────
  const loadLists = useCallback(async () => {
    if (!user) return;
    setLoadingList(true);
    try {
      // Fetch en paralelo. b2b solo si hasCap (sino 403).
      const promises = [
        releaseNotesApi.list().catch(() => ({ release_notes: [] })),
      ];
      if (hasB2b) {
        promises.push(redB2bApi.notifications.list({ limit: 20 }).catch(() => ({ notifications: [] })));
      }
      const results = await Promise.all(promises);
      const notas = Array.isArray(results[0]?.release_notes) ? results[0].release_notes : [];
      setNovedadesItems(notas.slice(0, NOVEDADES_PREVIEW_LIMIT));
      if (hasB2b) {
        setB2bItems(Array.isArray(results[1]?.notifications) ? results[1].notifications : []);
      }
      // Como el endpoint no expone last_seen_at, aproximamos: si count > 0,
      // las primeras N notas son "unseen"; sino todas son seen.
      // Aproximación buena para el preview del dropdown (la pantalla
      // /novedades hace el mark-seen real cuando la abre).
      setNovedadesLastSeenAt(novedadesCount > 0 ? '_unseen' : '_seen');
    } finally {
      setLoadingList(false);
    }
  }, [user, hasB2b, novedadesCount]);

  useEffect(() => { if (open) loadLists(); }, [open, loadLists]);

  // Cierre por click fuera del panel.
  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (panelRef.current && !panelRef.current.contains(e.target) &&
          btnRef.current && !btnRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Cierre por ESC.
  useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Sin user → no renderizar (edge case: componente montado antes de resolver auth).
  if (!user) return null;

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handleNovedadClick(nota) {
    setOpen(false);
    // La pantalla /novedades ya hace mark-seen al abrir + emite el evento;
    // acá optimísticamente apagamos el count local para responsive UX.
    if (novedadesCount > 0) {
      setNovedadesCount(0);
      window.dispatchEvent(new CustomEvent('release-notes:marked-seen'));
      releaseNotesApi.markSeen().catch(() => {});
    }
    navigate('/novedades');
  }

  function handleB2bClick(notif) {
    const { route } = describeB2bNotif(notif);
    // Marca read in-flight (optimistic). Backend idempotente.
    if (!notif.read_at) {
      redB2bApi.notifications.markRead(notif.id).catch(() => {});
      setB2bCount((c) => Math.max(0, c - 1));
      setB2bItems((arr) => arr.map((x) => x.id === notif.id ? { ...x, read_at: new Date().toISOString() } : x));
    }
    setOpen(false);
    if (route) navigate(route);
  }

  async function handleMarkAll() {
    // Ambos en paralelo. Optimistic UI.
    const promises = [];
    if (novedadesCount > 0) {
      setNovedadesCount(0);
      window.dispatchEvent(new CustomEvent('release-notes:marked-seen'));
      promises.push(releaseNotesApi.markSeen().catch(() => {}));
    }
    if (b2bCount > 0 && hasB2b) {
      setB2bCount(0);
      setB2bItems((arr) => arr.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
      promises.push(redB2bApi.notifications.markAllRead().catch(() => {}));
    }
    await Promise.all(promises);
  }

  const totalUnread = novedadesCount + b2bCount;
  const badge = totalUnread > 99 ? '99+' : (totalUnread > 0 ? String(totalUnread) : null);

  const hayNovedadesUnseen = novedadesCount > 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn"
        title="Notificaciones"
        aria-label="Notificaciones"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ position: 'relative' }}
      >
        <Icons.Bell size={17} />
        {badge != null && (
          <span
            data-testid="notif-bell-badge"
            aria-label={`${totalUnread} ${totalUnread === 1 ? 'notificación' : 'notificaciones'} sin leer`}
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              background: '#ef4444',
              color: '#fff',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              boxShadow: '0 0 0 2px var(--bg, #fff)',
            }}
          >
            {badge}
          </span>
        )}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notificaciones"
          data-testid="notif-bell-panel"
          style={{
            // 2026-07-17 (post-#658): renderizado vía React Portal en <body>
            // para escapar CUALQUIER stacking context del árbol del Shell.
            // El fix previo con `isolation: isolate` + z-index 1000 no
            // alcanzó — el sticky header de las tablas debajo (CuentasCC,
            // etc) seguía atravesando el panel. Renderear en el body directo
            // + position: fixed + z-index 10000 es la solución bulletproof:
            // el panel NO comparte stacking context con ningún elemento de
            // la página, por lo que ningún z-index de la página puede
            // "escaparse" hacia arriba y pintarse encima.
            position: 'fixed',
            top: panelPos.top,
            right: panelPos.right,
            width: 380,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: '70vh',
            background: 'var(--surface, #131a2b)',
            color: 'var(--text, #e8ecf6)',
            border: '1px solid var(--border, #2c3656)',
            borderRadius: 10,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
            zIndex: 10000,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid var(--border, #2c3656)',
            fontSize: 13, fontWeight: 600,
          }}>
            <span>Notificaciones</span>
            {totalUnread > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--accent, #0ea5e9)',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0,
                }}
              >
                Marcar todo como leído
              </button>
            )}
          </div>

          {/* Body scrolleable — background explícito por defensa: aunque el
              contenedor padre ya tiene --surface, cualquier hueco/gap entre
              items o padding transparente podría dejar ver el layout debajo. */}
          <div style={{ flex: 1, overflowY: 'auto', background: 'var(--surface, #131a2b)' }}>
            {loadingList && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted, #7c87a5)', fontSize: 13 }}>
                Cargando…
              </div>
            )}

            {/* ── Sección Novedades ─────────────────────────────────────── */}
            {!loadingList && (
              <div>
                <div style={{
                  padding: '8px 14px',
                  fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--text-muted, #7c87a5)',
                  background: 'var(--surface-2, #1a2238)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span>Novedades</span>
                  {hayNovedadesUnseen && (
                    <span style={{
                      background: 'var(--accent, #0ea5e9)', color: '#fff',
                      padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                      letterSpacing: 0, textTransform: 'none',
                    }}>
                      {novedadesCount} nueva{novedadesCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>

                {novedadesItems.length === 0 ? (
                  <div style={{ padding: '16px 14px', textAlign: 'center', color: 'var(--text-muted, #7c87a5)', fontSize: 12 }}>
                    Sin novedades por ahora.
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {novedadesItems.map((nota, idx) => {
                      const emoji = TIPO_NOVEDAD_EMOJI[nota.tipo] || '📝';
                      const isUnseen = hayNovedadesUnseen && idx < novedadesCount;
                      return (
                        <li key={nota.id}>
                          <button
                            type="button"
                            onClick={() => handleNovedadClick(nota)}
                            data-testid="notif-bell-novedad"
                            style={{
                              width: '100%',
                              padding: '10px 14px',
                              background: isUnseen ? 'rgba(14,165,233,0.06)' : 'transparent',
                              border: 'none',
                              borderBottom: '1px solid var(--hairline, rgba(255,255,255,0.06))',
                              textAlign: 'left', cursor: 'pointer',
                              display: 'flex', gap: 10,
                              font: 'inherit', color: 'inherit',
                            }}
                          >
                            <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1.4 }}>{emoji}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 13, fontWeight: isUnseen ? 600 : 500,
                                marginBottom: 2, overflow: 'hidden',
                                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {nota.titulo}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted, #7c87a5)' }}>
                                {fmtRelative(nota.publicado_en)}
                              </div>
                            </div>
                            {isUnseen && (
                              <span style={{
                                width: 8, height: 8, borderRadius: 999,
                                background: 'var(--accent, #0ea5e9)',
                                flexShrink: 0, alignSelf: 'center',
                              }} />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate('/novedades'); }}
                  style={{
                    width: '100%', padding: '8px 14px',
                    background: 'transparent', border: 'none',
                    borderBottom: '1px solid var(--border, #2c3656)',
                    color: 'var(--accent, #0ea5e9)',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    textAlign: 'center',
                  }}
                >
                  Ver todas las novedades →
                </button>
              </div>
            )}

            {/* ── Sección Red B2B (solo si el user tiene cap) ───────────── */}
            {!loadingList && hasB2b && (
              <div>
                <div style={{
                  padding: '8px 14px',
                  fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--text-muted, #7c87a5)',
                  background: 'var(--surface-2, #1a2238)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span>Red B2B</span>
                  {b2bCount > 0 && (
                    <span style={{
                      background: 'var(--accent, #0ea5e9)', color: '#fff',
                      padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                      letterSpacing: 0, textTransform: 'none',
                    }}>
                      {b2bCount} nueva{b2bCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                {b2bItems.length === 0 ? (
                  <div style={{ padding: '16px 14px', textAlign: 'center', color: 'var(--text-muted, #7c87a5)', fontSize: 12 }}>
                    Sin notificaciones Red B2B.
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {b2bItems.map((n) => {
                      const { label } = describeB2bNotif(n);
                      const unread = !n.read_at;
                      return (
                        <li key={n.id}>
                          <button
                            type="button"
                            onClick={() => handleB2bClick(n)}
                            data-testid="notif-bell-b2b"
                            style={{
                              width: '100%',
                              padding: '10px 14px',
                              background: unread ? 'rgba(14,165,233,0.06)' : 'transparent',
                              border: 'none',
                              borderBottom: '1px solid var(--hairline, rgba(255,255,255,0.06))',
                              textAlign: 'left', cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', gap: 4,
                              font: 'inherit', color: 'inherit',
                            }}
                          >
                            <div style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              fontSize: 13, fontWeight: unread ? 600 : 400,
                            }}>
                              {unread && (
                                <span style={{
                                  width: 8, height: 8, borderRadius: 999,
                                  background: 'var(--accent, #0ea5e9)',
                                  flexShrink: 0,
                                }} />
                              )}
                              <span style={{ flex: 1 }}>{label}</span>
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted, #7c87a5)', paddingLeft: unread ? 16 : 0 }}>
                              {fmtRelative(n.created_at)}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
