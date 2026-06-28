// RedB2BNotificationsBell.jsx — Bell icon + dropdown panel for cross-tenant notifs.
// 2026-06-29 #458 F5.
//
// Renderiza:
//   - Bell icon en topbar (solo si user tiene cap cross_tenant.write)
//   - Badge con count unread (oculto si N=0, "99+" si N>99)
//   - Polling cada 60s al GET /count-unread (lightweight)
//   - Click → drawer/popover con últimas 20 notifs
//   - Cada item: icon por tipo, mensaje legible, fecha relativa, click → navega
//   - "Marcar todas como leídas" arriba
//
// Decisiones:
//   - El dropdown se cierra si clickeás fuera o en una notif.
//   - Render fecha relativa con Intl.RelativeTimeFormat (nativo, sin lib).
//   - Sin route /red-b2b/inbox dedicado en F5 — el dropdown alcanza
//     para 20 items. Si crece, F6 puede agregar una pantalla full.
//   - Click en notif marca read + navega al recurso según type.
//   - Render skipped si user no tiene cap (consistente con sidebar item).

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from './Icons';
import { redB2b as redB2bApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

const POLL_INTERVAL_MS = 60 * 1000; // 60s

// Mapping type → ruta + label legible. Si type no está acá, fallback genérico.
function describeNotif(n) {
  const p = n.payload || {};
  const partner = p.partner?.nombre || p.partnerNombre || p.from_tenant?.nombre || 'Un partner';
  switch (n.type) {
    case 'invitation_received':
      return {
        label: `${partner} te invitó a Red B2B`,
        route: '/red-b2b',
      };
    case 'invitation_accepted':
      return {
        label: `${partner} aceptó tu invitación`,
        route: '/red-b2b',
      };
    case 'invitation_rejected':
      return {
        label: `${partner} rechazó tu invitación`,
        route: '/red-b2b',
      };
    case 'partnership_revoked':
      return {
        label: `${partner} revocó la partnership`,
        route: '/red-b2b',
      };
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
      return {
        label: `${partner} registró un pago de USD ${fmtUsd(p.monto_usd)}`,
        route: n.cross_tenant_operation_id
          ? `/red-b2b/operaciones/${n.cross_tenant_operation_id}`
          : '/red-b2b/operaciones',
      };
    case 'payment_registered':
      return {
        label: `${partner} registró un pago de USD ${fmtUsd(p.monto_usd)}`,
        route: n.cross_tenant_operation_id
          ? `/red-b2b/operaciones/${n.cross_tenant_operation_id}`
          : '/red-b2b/operaciones',
      };
    case 'product_pending_review':
      return {
        label: 'Tenés productos pendientes de revisión',
        route: '/red-b2b/pending-review',
      };
    default:
      return { label: 'Notificación Red B2B', route: '/red-b2b' };
  }
}

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

function userHasCap(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.tenant_cap_rol === 'owner' || user.tenant_cap_rol === 'admin') return true;
  if (user.caps === null) return true;
  if (Array.isArray(user.caps) && user.caps.includes('cross_tenant.write')) return true;
  return false;
}

export default function RedB2BNotificationsBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  const hasCap = userHasCap(user);

  // Polling del count cada 60s. Solo si el user tiene cap (sino el endpoint
  // rebotaría 403 y el badge nunca se actualizaría — silenciamos).
  useEffect(() => {
    if (!hasCap) return;
    let cancelled = false;
    function refresh() {
      redB2bApi.notifications.countUnread()
        .then((r) => {
          if (!cancelled) setCount(Number(r.count) || 0);
        })
        .catch(() => { /* best-effort */ });
    }
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [hasCap]);

  // Cargar lista cuando se abre el dropdown.
  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await redB2bApi.notifications.list({ limit: 20 });
      setItems(Array.isArray(r.notifications) ? r.notifications : []);
    } catch (_e) {
      // Silenciado — la UI vacía es suficiente fallback.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadList();
  }, [open, loadList]);

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
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!hasCap) return null;

  function handleItemClick(notif) {
    const { route } = describeNotif(notif);
    // Marca read in-flight (optimistic). El backend es idempotente.
    if (!notif.read_at) {
      redB2bApi.notifications.markRead(notif.id).catch(() => {});
      setCount((c) => Math.max(0, c - 1));
      setItems((arr) => arr.map((x) => x.id === notif.id ? { ...x, read_at: new Date().toISOString() } : x));
    }
    setOpen(false);
    if (route) navigate(route);
  }

  async function handleMarkAll() {
    try {
      const r = await redB2bApi.notifications.markAllRead();
      setCount(0);
      setItems((arr) => arr.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
      // Si el backend reportó otra cantidad, refresh para sincronizar.
      if (r && typeof r.updated === 'number' && r.updated > 0) {
        loadList();
      }
    } catch (_e) {
      // Silenciado — el botón puede reintentar.
    }
  }

  const badge = count > 99 ? '99+' : (count > 0 ? String(count) : null);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn"
        title="Notificaciones Red B2B"
        aria-label="Notificaciones Red B2B"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ position: 'relative' }}
      >
        <Icons.Bell size={17} />
        {badge != null && (
          <span
            data-testid="red-b2b-bell-badge"
            aria-label={`${count} ${count === 1 ? 'notificación' : 'notificaciones'} sin leer`}
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

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notificaciones Red B2B"
          data-testid="red-b2b-bell-panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 360,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: '70vh',
            background: 'var(--surface, #fff)',
            color: 'var(--ink, #0d1220)',
            border: '1px solid var(--border, #e5e7eb)',
            borderRadius: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,0.12)',
            zIndex: 100,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid var(--border, #e5e7eb)',
            fontSize: 13,
            fontWeight: 600,
          }}>
            <span>Notificaciones Red B2B</span>
            {count > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent, #0ea5e9)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Marcar todas como leídas
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted, #6b7280)', fontSize: 13 }}>
                Cargando…
              </div>
            )}
            {!loading && items.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted, #6b7280)', fontSize: 13 }}>
                Sin notificaciones por ahora.
              </div>
            )}
            {!loading && items.length > 0 && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items.map((n) => {
                  const { label } = describeNotif(n);
                  const unread = !n.read_at;
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleItemClick(n)}
                        data-testid="red-b2b-bell-item"
                        style={{
                          width: '100%',
                          padding: '12px 14px',
                          background: unread ? 'rgba(14,165,233,0.06)' : 'transparent',
                          border: 'none',
                          borderBottom: '1px solid var(--border, #f0f0f0)',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          font: 'inherit',
                          color: 'inherit',
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          fontWeight: unread ? 600 : 400,
                        }}>
                          {unread && (
                            <span style={{
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              background: 'var(--accent, #0ea5e9)',
                              flexShrink: 0,
                            }} />
                          )}
                          <span style={{ flex: 1 }}>{label}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted, #6b7280)', paddingLeft: unread ? 16 : 0 }}>
                          {fmtRelative(n.created_at)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
