// Equipo — gestión de co-super-admins (#499).
//
// Lista los super-admins activos y las invitaciones pendientes. Botón
// "Invitar admin" arriba a la derecha abre modal.
//
// Cada super-admin muestra: avatar, username, email, badge 2FA, botón Trash
// (deshabilitado con tooltip si is_you=true).
//
// Cada invite pendiente muestra: email + nombre, "invitado por X hace Yd",
// "expira en Zh", botones Reenviar + Revocar.
//
// Flow de acciones:
//   · Invitar admin      → modal → POST /invite → success/error banner
//   · Revocar admin      → confirm inline → POST /revoke/:userId
//   · Reenviar invite    → POST /invite/:id/resend
//   · Revocar invite     → DELETE /invite/:id
// Todos refrescan la lista al terminar.

import { useEffect, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, Badge, PageHead } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import { fmtDateTime, ago } from '../lib/format.js';
import InviteAdminModal from '../components/modals/InviteAdminModal.jsx';

// Iniciales para el avatar. Réplica del helper de Layout — el estilo se
// aplica inline porque el CSS `.avatar` del sidebar tiene un tamaño distinto
// al que queremos acá (más grande).
function initials(u) {
  const src = u?.username || u?.email || '';
  if (!src) return '?';
  const base = src.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return base.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

// "Expira en Nh" o "Nd" — humano-friendly del delta hacia el futuro.
function expiresIn(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const secs = Math.round((d - new Date()) / 1000);
  if (secs <= 0) return 'expirada';
  const hours = Math.floor(secs / 3600);
  if (hours < 1) return `${Math.floor(secs / 60)} min`;
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export default function Equipo() {
  const [data, setData] = useState({ super_admins: [], pending_invites: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  // Set de user_ids/invite_ids sobre los que hay una acción en curso — evita
  // doble-click en botones destructivos y muestra spinner por-fila.
  const [busyAdmins, setBusyAdmins] = useState(new Set());
  const [busyInvites, setBusyInvites] = useState(new Set());

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.team.list();
      setData({
        super_admins:    Array.isArray(res?.super_admins)    ? res.super_admins    : [],
        pending_invites: Array.isArray(res?.pending_invites) ? res.pending_invites : [],
      });
    } catch (err) {
      setError(err?.message || 'No pudimos cargar el equipo.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onInvited = (res) => {
    setInviteOpen(false);
    setSuccess(`Invitación enviada a ${res?.invite?.email || ''}.`);
    load();
  };

  // Wrapper genérico para acciones con try/finally + refresh + spinner.
  async function withBusy(setBusy, id, fn, successMsg) {
    setBusy((prev) => new Set(prev).add(id));
    setSuccess('');
    setError('');
    try {
      await fn();
      if (successMsg) setSuccess(successMsg);
      await load();
    } catch (err) {
      setError(err?.message || 'La operación falló.');
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const revokeAdmin = (admin) => {
    if (admin.is_you) return; // defensa UI (el botón está disabled igual)
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Revocar el acceso super-admin a ${admin.username}?`)) return;
    withBusy(setBusyAdmins, admin.id,
      () => adminApi.team.revokeAdmin(admin.id),
      `${admin.username} ya no es super-admin.`);
  };

  const resendInvite = (inv) => {
    withBusy(setBusyInvites, inv.id,
      () => adminApi.team.resendInvite(inv.id),
      `Invitación reenviada a ${inv.email}.`);
  };

  const revokeInvite = (inv) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Revocar la invitación de ${inv.email}?`)) return;
    withBusy(setBusyInvites, inv.id,
      () => adminApi.team.revokeInvite(inv.id),
      `Invitación de ${inv.email} revocada.`);
  };

  const onlyOne = data.super_admins.length === 1;

  return (
    <>
      <PageHead
        label="Equipo"
        title="Administradores de la plataforma"
        subtitle="Super-admins activos e invitaciones pendientes."
        actions={
          <Btn kind="primary" icon="Plus" onClick={() => setInviteOpen(true)}>
            Invitar admin
          </Btn>
        }
      />

      {error && (
        <div className="banner banner-neg u-mb-var-gap" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="banner banner-pos u-mb-var-gap" role="status">
          {success}
        </div>
      )}

      {loading ? (
        <div className="stack u-gap-var-gap">
          <div className="card" style={{ minHeight: 120 }}>
            <span className="skeleton" style={{ display: 'inline-block', width: 180, height: 16, marginBottom: 10 }} />
            <span className="skeleton" style={{ display: 'block', width: '100%', height: 48 }} />
          </div>
        </div>
      ) : (
        <div className="stack u-gap-var-gap">
          {/* ── Super admins activos ─────────────────────────────────── */}
          <Card
            flush
            title="Super admins activos"
            subtitle={onlyOne
              ? 'Sos el único super-admin — invitá a alguien más para tener redundancia.'
              : `${data.super_admins.length} super-admins con acceso al back office.`
            }
          >
            <div className="card-body u-p-0">
              {data.super_admins.length === 0 ? (
                <div className="muted u-p-16">
                  No hay super-admins activos.
                </div>
              ) : (
                <ul className="u-list-reset">
                  {data.super_admins.map((a) => (
                    <li
                      key={a.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        borderTop: '1px solid var(--border-soft)',
                      }}
                    >
                      <div
                        aria-hidden="true"
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: 'var(--bg-soft)',
                          display: 'grid',
                          placeItems: 'center',
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--text-dim)',
                          flexShrink: 0,
                        }}
                      >
                        {initials(a)}
                      </div>
                      <div className="u-flex-1-minw-0">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong>{a.username}</strong>
                          {a.is_you && <Badge tone="info">Vos</Badge>}
                          <Badge tone={a.twofa_enabled ? 'pos' : 'warn'}>
                            2FA {a.twofa_enabled ? 'Activo' : 'Pendiente'}
                          </Badge>
                        </div>
                        <div className="muted tiny u-mt-2">
                          {a.email}
                          {a.created_at && ` · agregado ${fmtDateTime(a.created_at)}`}
                        </div>
                      </div>
                      <Btn
                        kind="danger"
                        sm
                        iconOnly
                        icon="Trash"
                        onClick={() => revokeAdmin(a)}
                        disabled={a.is_you || busyAdmins.has(a.id)}
                        title={a.is_you
                          ? 'No podés revocarte a vos mismo'
                          : 'Revocar super-admin'
                        }
                        aria-label={`Revocar super-admin de ${a.username}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {/* ── Invitaciones pendientes ──────────────────────────────── */}
          <Card
            flush
            title="Invitaciones pendientes"
            subtitle={data.pending_invites.length === 0
              ? 'No hay invitaciones pendientes.'
              : `${data.pending_invites.length} en curso.`
            }
          >
            <div className="card-body u-p-0">
              {data.pending_invites.length === 0 ? (
                <div className="muted u-p-16">
                  Podés invitar a más admins con el botón "Invitar admin".
                </div>
              ) : (
                <ul className="u-list-reset">
                  {data.pending_invites.map((inv) => (
                    <li
                      key={inv.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        borderTop: '1px solid var(--border-soft)',
                      }}
                    >
                      <div className="u-flex-1-minw-0">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong>{inv.email}</strong>
                          <span className="muted tiny">· {inv.nombre}</span>
                        </div>
                        <div className="muted tiny u-mt-2">
                          Invitado por @{inv.invited_by_username || '—'} · {ago(inv.invited_at)}
                          {' · '}
                          Expira en {expiresIn(inv.expires_at)}
                        </div>
                      </div>
                      <Btn
                        kind="ghost"
                        sm
                        onClick={() => resendInvite(inv)}
                        disabled={busyInvites.has(inv.id)}
                      >
                        <Icons.Refresh size={14} />
                        <span className="u-ml-4">Reenviar</span>
                      </Btn>
                      <Btn
                        kind="danger"
                        sm
                        iconOnly
                        icon="Trash"
                        onClick={() => revokeInvite(inv)}
                        disabled={busyInvites.has(inv.id)}
                        title="Revocar invitación"
                        aria-label={`Revocar invitación de ${inv.email}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}

      <InviteAdminModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={onInvited}
      />
    </>
  );
}
