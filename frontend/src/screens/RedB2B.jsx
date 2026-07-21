// Red B2B — hub principal de la feature cross-tenant.
//
// PR-X1 #465: refactor a hub con tabs. Antes esta pantalla era SOLO el listado
// de partnerships (F1 #454). Ahora es el contenedor del feature con 2 tabs:
//
//   · Partners       — invitar / aceptar / revocar partners (contenido F1)
//   · Configuración  — caja default + email prefs (delega a RedB2BConfigContent)
//
// Las otras sub-pantallas (Operaciones, Conciliación, Pendientes) siguen en
// rutas standalone por ahora — PR-X2 / PR-X3 las van a reubicar dentro de B2B
// e Inventario. La pantalla está gateada por la capability `cross_tenant.write`
// (sidebar item se esconde, ruta vía RequirePermission).
//
// Query param ?tab=config → abre el tab Configuración por default. Se usa
// también desde el redirect de la ruta legacy /red-b2b/config (ver App.jsx)
// para preservar bookmarks existentes sin romper la UX consistente.
//
// Tabs internos del listado de partnerships (Activos / Recibidas / Enviadas /
// Revocados) ahora son tabs SECUNDARIOS dentro del tab Partners — se renderean
// como una segunda fila debajo del tab principal cuando Partners está activo.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { redB2b } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { Icons } from '../components/Icons';
import useModal from '../lib/useModal';
import { RedB2BConfigContent } from './RedB2BConfig';

const HUB_TABS = [
  { id: 'partners', label: 'Partners' },
  { id: 'config',   label: 'Configuración' },
];

const PARTNER_TABS = [
  { id: 'active',             label: 'Activos',                  status: 'active',  filterMine: null },
  { id: 'pending_received',   label: 'Invitaciones recibidas',   status: 'pending', filterMine: 'received' },
  { id: 'pending_sent',       label: 'Invitaciones enviadas',    status: 'pending', filterMine: 'sent' },
  { id: 'revoked',            label: 'Revocados',                status: 'revoked', filterMine: null },
];

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return iso;
  }
}

function planLabel(plan) {
  const map = { trial: 'Trial', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };
  return map[plan] || plan || '—';
}

export default function RedB2B() {
  // PR-X1: tab del hub controlado por ?tab=. Default = partners (que es el
  // contenido histórico — preservamos la UX existente para usuarios que entran
  // por el sidebar). El redirect desde /red-b2b/config nos manda con
  // ?tab=config y el efecto lo lee al montar.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab = tabParam === 'config' ? 'config' : 'partners';
  const [hubTab, setHubTab] = useState(initialTab);

  function selectHubTab(id) {
    setHubTab(id);
    // Sincronizamos el query param para que el back/forward del browser y los
    // refreshes preserven el tab. `partners` es el default — no contamina la
    // URL. `replace: true` para no llenar el history con cambios de tab.
    if (id === 'partners') {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: id }, { replace: true });
    }
  }

  return (
    <div>
      <div className="page-head u-mb-16">
        <h1>Red B2B</h1>
      </div>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
        Conectá tu cuenta con otros tenants Tecny para operar B2B con sincronización
        automática de inventario, cuentas corrientes y pagos.
      </p>

      <div className="tabs u-mb-16" role="tablist" aria-label="Secciones de Red B2B">
        {HUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={hubTab === t.id}
            className={`tab ${hubTab === t.id ? 'active' : ''}`}
            onClick={() => selectHubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {hubTab === 'partners' && <PartnersTab />}
      {hubTab === 'config'   && <RedB2BConfigContent />}
    </div>
  );
}

// ── Tab Partners ─────────────────────────────────────────────────────────────
// Encapsula el listado de partnerships con sus sub-tabs (status filter). Es lo
// que históricamente vivía en el componente principal RedB2B.jsx antes de
// PR-X1. Se separó para que el hub renderee este tab condicionalmente y para
// que el componente Configuración no monte el fetch del listado innecesariamente.
function PartnersTab() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [inviteOpen, setInviteOpen] = useState(false);

  const [activeTab, setActiveTab] = useState('active');
  const [counts, setCounts] = useState({
    active_count: 0,
    pending_received_count: 0,
    pending_sent_count: 0,
    revoked_count: 0,
  });
  const [partnerships, setPartnerships] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null); // partnership id currently being acted on

  const tab = PARTNER_TABS.find((t) => t.id === activeTab) || PARTNER_TABS[0];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await redB2b.partnerships.list(tab.status);
      setCounts(r.counts || {});
      // Filtramos el lado en el front porque el endpoint devuelve TODAS las
      // partnerships con el status filter (no separa sent/received). El
      // filtro es trivial sobre 4-100 filas — no vale la pena un endpoint
      // dedicado.
      const filtered = (r.partnerships || []).filter((p) => {
        if (!tab.filterMine) return true;
        return p.my_side === tab.filterMine;
      });
      setPartnerships(filtered);
    } catch (err) {
      toast.error(err.message || 'No pudimos cargar las partnerships');
      setPartnerships([]);
    } finally {
      setLoading(false);
    }
  }, [tab.status, tab.filterMine, toast]);

  useEffect(() => { load(); }, [load]);

  async function handleAccept(p) {
    const ok = await confirm({
      title: 'Aceptar invitación',
      message: `¿Aceptás la partnership con ${p.partner?.nombre || 'el partner'}?`,
      confirmLabel: 'Aceptar',
    });
    if (!ok) return;
    setActing(p.id);
    try {
      await redB2b.partnerships.accept(p.id);
      toast.success('Partnership aceptada');
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos aceptar la invitación');
    } finally {
      setActing(null);
    }
  }

  async function handleReject(p) {
    const ok = await confirm({
      title: 'Rechazar invitación',
      message: `¿Rechazás la invitación de ${p.partner?.nombre || 'el partner'}? Esto la marca como revocada con motivo "rechazado".`,
      confirmLabel: 'Rechazar',
      danger: true,
    });
    if (!ok) return;
    setActing(p.id);
    try {
      await redB2b.partnerships.reject(p.id);
      toast.success('Invitación rechazada');
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos rechazar la invitación');
    } finally {
      setActing(null);
    }
  }

  async function handleRevoke(p, opts = {}) {
    const { isPending = false } = opts;
    const ok = await confirm({
      title: isPending ? 'Cancelar invitación' : 'Revocar partnership',
      message: isPending
        ? `¿Cancelás la invitación enviada a ${p.partner?.nombre || 'el partner'}? Podrás reinvitar pasadas 24h.`
        : `¿Revocás la partnership con ${p.partner?.nombre || 'el partner'}? Las operaciones existentes quedan como histórico; no se pueden crear nuevas hasta firmar de nuevo.`,
      confirmLabel: isPending ? 'Cancelar invitación' : 'Revocar',
      danger: true,
    });
    if (!ok) return;
    setActing(p.id);
    try {
      await redB2b.partnerships.revoke(p.id);
      toast.success(isPending ? 'Invitación cancelada' : 'Partnership revocada');
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos revocar la partnership');
    } finally {
      setActing(null);
    }
  }

  return (
    <div>
      {/* Botón "Invitar partner": contextual al tab Partners. En Configuración
          no tiene sentido. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setInviteOpen(true)}
        >
          <Icons.Plus /> Invitar partner
        </button>
      </div>

      <div className="tabs u-mb-16" role="tablist" aria-label="Filtros de partnerships">
        {PARTNER_TABS.map((t) => {
          const count = (
            t.id === 'active'           ? counts.active_count :
            t.id === 'pending_received' ? counts.pending_received_count :
            t.id === 'pending_sent'     ? counts.pending_sent_count :
            t.id === 'revoked'          ? counts.revoked_count : 0
          );
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
              {count > 0 && (
                <span className="badge u-ml-8">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          Cargando partnerships...
        </div>
      ) : partnerships.length === 0 ? (
        <EmptyState tab={tab} onInvite={() => setInviteOpen(true)} />
      ) : (
        <div className="list">
          {partnerships.map((p) => (
            <PartnershipRow
              key={p.id}
              p={p}
              acting={acting === p.id}
              onAccept={() => handleAccept(p)}
              onReject={() => handleReject(p)}
              onRevoke={(opts) => handleRevoke(p, opts)}
            />
          ))}
        </div>
      )}

      {inviteOpen && (
        <InvitePartnerModal
          onClose={() => setInviteOpen(false)}
          onSuccess={() => {
            setInviteOpen(false);
            // Saltamos al tab "Invitaciones enviadas" porque ahí va a aparecer
            // la nueva invitación.
            setActiveTab('pending_sent');
            load();
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ tab, onInvite }) {
  const messages = {
    active:           { title: 'Sin partnerships activas todavía', body: 'Invitá a otro tenant Tecny para empezar a operar B2B sin tipear.' },
    pending_received: { title: 'No tenés invitaciones pendientes', body: 'Cuando un partner te invite, aparecerá acá para que aceptes o rechaces.' },
    pending_sent:     { title: 'No enviaste invitaciones', body: 'Invitá a un partner por su slug — recibirá una notificación in-app.' },
    revoked:          { title: 'No hay partnerships revocadas', body: 'Las partnerships canceladas o rechazadas aparecen acá para histórico.' },
  };
  const msg = messages[tab.id] || messages.active;
  return (
    <div className="empty-state" style={{ padding: 32, textAlign: 'center' }}>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{msg.title}</p>
      <p className="muted u-mb-16">{msg.body}</p>
      {(tab.id === 'active' || tab.id === 'pending_sent') && (
        <button type="button" className="btn btn-primary" onClick={onInvite}>
          Invitar partner
        </button>
      )}
    </div>
  );
}

function PartnershipRow({ p, acting, onAccept, onReject, onRevoke }) {
  const partner = p.partner || {};
  const isReceived = p.my_side === 'received';

  let dateLabel = '';
  let dateValue = '';
  if (p.status === 'active') {
    dateLabel = 'Aceptada';
    dateValue = formatDate(p.accepted_at);
  } else if (p.status === 'pending') {
    dateLabel = isReceived ? 'Te invitaron' : 'Invitaste';
    dateValue = formatDate(p.invited_at);
  } else {
    dateLabel = 'Revocada';
    dateValue = formatDate(p.revoked_at);
  }

  return (
    <div className="card" style={{ marginBottom: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div className="u-flex-1-minw-0">
          <div style={{ fontWeight: 600, fontSize: '1.05em' }}>
            {partner.nombre || '— sin nombre —'}
            {' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: '0.85em' }}>
              ({partner.slug || '?'})
            </span>
          </div>
          <div className="muted tiny u-mt-4">
            Plan {planLabel(partner.plan)} · {dateLabel}: {dateValue}
          </div>
          {p.invitation_message && (
            <div className="tiny" style={{ marginTop: 6, fontStyle: 'italic' }}>
              “{p.invitation_message}”
            </div>
          )}
          {p.revoked_reason && (
            <div className="tiny muted u-mt-6">
              Motivo: {p.revoked_reason}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {p.status === 'pending' && isReceived && (
            <>
              <button type="button" className="btn btn-primary" disabled={acting} onClick={onAccept}>
                Aceptar
              </button>
              <button type="button" className="btn btn-danger" disabled={acting} onClick={onReject}>
                Rechazar
              </button>
            </>
          )}
          {p.status === 'pending' && !isReceived && (
            <button type="button" className="btn btn-danger" disabled={acting} onClick={() => onRevoke({ isPending: true })}>
              Cancelar
            </button>
          )}
          {p.status === 'active' && (
            <button type="button" className="btn btn-danger" disabled={acting} onClick={() => onRevoke({ isPending: false })}>
              Revocar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Modal: input slug + textarea mensaje opcional.
// Validación cliente espejada del schema Zod backend (regex slug). El backend
// igual valida — esto solo dispara errores antes del round-trip.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export function InvitePartnerModal({ onClose, onSuccess }) {
  const { toast } = useToast();
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const overlayRef = useRef(null);

  // useModal: Esc cierra + body scroll lock + focus trap. Mismo patrón que
  // los modales del design system del portal (PR follow-up post Red B2B UX
  // — el modal original estilaba con inline styles + no usaba modal-hd/body/ft).
  useModal({ open: true, onClose, overlayRef });

  function validate() {
    const trimmed = slug.trim();
    if (!trimmed) return 'Ingresá el slug del tenant a invitar.';
    if (!SLUG_REGEX.test(trimmed)) {
      return 'Slug inválido. Usá minúsculas, números y guiones (ej. tekhaus o tek-haus).';
    }
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const v = validate();
    if (v) { setError(v); return; }
    setError('');
    setSubmitting(true);
    try {
      await redB2b.partnerships.invite(slug.trim(), message.trim() || undefined);
      toast.success('Invitación enviada');
      onSuccess?.();
    } catch (err) {
      toast.error(err.message || 'No pudimos enviar la invitación');
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal u-mw-480" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="invite-modal-title">Invitar partner</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar modal">
            <Icons.X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p className="muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 14 }}>
              Ingresá el slug del tenant Tecny al que querés invitar.
            </p>

            <div className="field u-mb-12">
              <label className="field-label" htmlFor="invite-slug">
                Slug del partner
              </label>
              <input
                id="invite-slug"
                className="input"
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="ej. tekhaus"
                autoFocus
                disabled={submitting}
              />
            </div>

            <div className="field u-mb-8">
              <label className="field-label" htmlFor="invite-message">
                Mensaje (opcional)
              </label>
              <textarea
                id="invite-message"
                className="input"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Hola, somos X y nos gustaría operar con ustedes vía Red B2B..."
                rows={3}
                maxLength={500}
                disabled={submitting}
                style={{ fontFamily: 'inherit', resize: 'vertical' }}
              />
              <div className="muted tiny u-mt-4">
                {message.length}/500 caracteres
              </div>
            </div>

            {error && (
              <div className="neg tiny u-mt-8">{error}</div>
            )}
          </div>

          <div className="modal-ft">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Enviando…' : 'Enviar invitación'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
