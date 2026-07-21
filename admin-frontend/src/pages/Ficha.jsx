// Ficha de cliente — detalle full de un tenant (#353).
//
// Compone:
//   · header (back + page-head con logo + nombre + plan + status + acciones)
//   · banners contextuales (suspendido / trial)
//   · 4 stat cards (MRR, usuarios, salud proxy, última venta)
//   · 2 tabs: Resumen (salud + audit per-tenant) y Actividad (5 sub-tabs)
//   · 4 modals de mutations (edit / suspend / reactivate / extend-trial)
//
// Decisión explícita vs el design original (admin-screens-2.jsx):
//   Hacemos 2 tabs con data 100% real, en vez de 4 con mocks. Facturación
//   + Equipo se agregan cuando existan los endpoints reales.
//
// Defensive coding everywhere — optional chaining, Array.isArray, defaults.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import {
  Btn, Badge, Status, Card, Seg, Tabs, PageHead,
} from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import { fmt, fmtMoney, fmtDate, fmtDateTime, ago } from '../lib/format.js';
import {
  planTone,
  planLabel,
  tenantInitials,
  getTenantStatus,
  TENANT_STATUS,
  healthProxy,
  healthColor,
  healthCategoryLabel,
} from '../lib/uiHelpers.js';
import { describeAction, actionShortText } from '../lib/actionDescriptors.js';
import EditTenantModal from '../components/modals/EditTenantModal.jsx';
import SuspendTenantModal from '../components/modals/SuspendTenantModal.jsx';
import ReactivateTenantModal from '../components/modals/ReactivateTenantModal.jsx';
import ExtendTrialModal from '../components/modals/ExtendTrialModal.jsx';
import SetPaidUntilModal from '../components/modals/SetPaidUntilModal.jsx';
import DeleteTenantModal from '../components/modals/DeleteTenantModal.jsx';
import ChangePaisTenantModal from '../components/modals/ChangePaisTenantModal.jsx';
import MergeClasesModal from '../components/modals/MergeClasesModal.jsx';

// ── Helpers locales ───────────────────────────────────────────────────

// Descriptor textual de la salud — usa la category del backend (#440) si
// está, sino cae al threshold del score viejo para retro-compat.
function healthDescriptor(score, category) {
  if (category) return healthCategoryLabel(category);
  if (score >= 80) return 'excelente';
  if (score >= 55) return 'estable';
  if (score >= 40) return 'en riesgo';
  return 'frío';
}

// Cuántos días faltan / pasaron del trial_until.
function trialDaysDelta(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return Math.round((day - now) / 86400000);
}

const ACTIVITY_TABS = [
  { value: 'ventas',   label: 'Ventas' },
  { value: 'cajas',    label: 'Cajas' },
  { value: 'bot',      label: 'Bot' },
  { value: 'alertas',  label: 'Alertas' },
  { value: 'audit',    label: 'Audit log' },
];

// Mapping audit accion → tone para el badge inline.
function auditAccionTone(accion) {
  const a = String(accion || '').toLowerCase();
  if (a.includes('insert') || a === 'create' || a === 'created') return 'pos';
  if (a.includes('delete') || a === 'destroy') return 'neg';
  if (a.includes('update') || a === 'modify') return 'info';
  return 'default';
}

export default function Ficha() {
  const { id } = useParams();
  const navigate = useNavigate();

  // Tenant detail.
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tabs UI.
  const [activeTab, setActiveTab] = useState('resumen');
  const [activitySubTab, setActivitySubTab] = useState('ventas');

  // Activity per-subtab.
  const [activityData, setActivityData] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');

  // Modal abierto: 'edit' | 'suspend' | 'reactivate' | 'extend-trial' | null
  const [openModal, setOpenModal] = useState(null);

  // ── Carga del tenant ──────────────────────────────────────────────
  // Memoizamos para reusar en el onSaved de los modals (reload tras mutate).
  //
  // S-3 fix (audit 2026-06-22): el `id` cambia cuando se navega entre
  // /clientes/X. React Router NO desmonta el componente — reconcilia el
  // mismo Ficha con nuevo `id`. Sin guard de race, el fetch del tenant
  // anterior puede resolver DESPUÉS del fetch del actual, llamando
  // `setTenant(dataViejo)` sobre el componente con id nuevo. UI muestra
  // brevemente al tenant equivocado.
  // Pattern: reqIdRef para versionar el fetch (mismo approach que Clientes.jsx).
  const reqIdRef = useRef(0);
  const reloadTenant = useCallback(() => {
    if (id == null) return;
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    adminApi
      .getTenant(id)
      .then((data) => {
        // Solo aplicar si esta es la request más reciente.
        if (reqIdRef.current !== myReqId) return;
        setTenant(data);
        setLoading(false);
      })
      .catch((err) => {
        if (reqIdRef.current !== myReqId) return;
        setTenant(null);
        // 404 vs error general — mensaje distinto.
        if (err?.status === 404) {
          setError('NOT_FOUND');
        } else {
          setError(err?.message || 'No pudimos cargar el tenant.');
        }
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    reloadTenant();
  }, [reloadTenant]);

  // ── Carga de activity (solo cuando se ve la tab Actividad) ────────
  useEffect(() => {
    if (activeTab !== 'actividad' || !id) return;
    let alive = true;
    setActivityLoading(true);
    setActivityError('');
    setActivityData(null);
    adminApi
      .getActivity(id, activitySubTab, 20)
      .then((data) => {
        if (!alive) return;
        setActivityData(data);
        setActivityLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setActivityError(err?.message || 'No pudimos cargar la actividad.');
        setActivityLoading(false);
      });
    return () => { alive = false; };
  }, [activeTab, activitySubTab, id]);

  // Cuando un modal guarda OK, recargamos tenant y cerramos modal.
  // (El modal en sí no necesita esperar al reload — el cierre + skeleton
  // del page provee feedback inmediato.)
  const handleSaved = useCallback(() => {
    setOpenModal(null);
    reloadTenant();
  }, [reloadTenant]);

  // ── Render: error state (404 / otro) ──────────────────────────────
  // UX-3 fix (audit 2026-06-22): botón "Volver" extraído a componente
  // local con ícono ArrowLeft propio (no más scaleX(-1) de ChevronRight).
  // Reusado en NotFound / error / loading / detail header. Antes había 4
  // variantes inconsistentes ("←" literal, span vacío con scale, etc.).
  const BackBtn = () => (
    <Btn
      kind="ghost"
      sm
      icon="ArrowLeft"
      onClick={() => navigate('/clientes')}
      className="ficha-back"
    >
      Volver a clientes
    </Btn>
  );

  if (!loading && error === 'NOT_FOUND') {
    return (
      <>
        <BackBtn />
        <Card>
          <div className="empty-state">
            <div className="empty-title">Tenant no encontrado</div>
            El tenant con id <span className="mono">{id}</span> no existe o
            fue eliminado.
            <div className="empty-action">
              <Btn onClick={() => navigate('/clientes')}>Volver a clientes</Btn>
            </div>
          </div>
        </Card>
      </>
    );
  }

  if (!loading && error && error !== 'NOT_FOUND') {
    return (
      <>
        <BackBtn />
        <div role="alert" className="banner banner-neg">{error}</div>
      </>
    );
  }

  // Loading state — UX-16 fix (audit 2026-06-22): skeleton estructurado
  // matching la shape real de la pantalla (back + header + 4 stat cards),
  // en vez de un "Cargando…" en texto plano. Operador clickea una fila
  // del listado y ve algo coherente inmediatamente.
  if (loading && !tenant) {
    return (
      <>
        <BackBtn />
        <div className="page-head" aria-busy="true">
          <div>
            <span className="skeleton" style={{ display: 'block', width: 80, height: 11, marginBottom: 8 }} />
            <span className="skeleton" style={{ display: 'block', width: 240, height: 26, marginBottom: 6 }} />
            <span className="skeleton" style={{ display: 'block', width: 320, height: 13 }} />
          </div>
        </div>
        <div className="kpi-grid u-mt-var-gap">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="kpi">
              <span className="skeleton" style={{ display: 'block', width: 70, height: 11, marginBottom: 10 }} />
              <span className="skeleton" style={{ display: 'block', width: 90, height: 22 }} />
            </div>
          ))}
        </div>
      </>
    );
  }

  // tenant existe a partir de acá.
  const statusKey = getTenantStatus(tenant);
  const statusMeta = TENANT_STATUS[statusKey] || TENANT_STATUS.active;
  // Health real (#440): preferimos lo que devuelve el backend.
  // Si el backend aún no lo manda (cache stale tras deploy), cae al
  // proxy legacy via healthProxy(tenant).
  const health = healthProxy(tenant);
  const hCategory = tenant?.health_category;
  const hColor = healthColor(health, hCategory);
  const hDesc = healthDescriptor(health, hCategory);
  // Breakdown del backend para las 4 barras del tab Resumen. Si falta,
  // usamos defaults visualmente útiles (no cero — sería confuso).
  const breakdown = tenant?.health_breakdown || {
    actividad: 0, cobros: 50, adopcion: 0, asientos: 0,
  };
  const isSuspended = !!tenant?.suspended_at;
  const isTrial = tenant?.plan === 'trial';

  return (
    <>
      <BackBtn />


      <PageHead
        title={
          <span className="flex-row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span>{tenant.nombre || '—'}</span>
            <Badge tone={planTone(tenant.plan)}>{planLabel(tenant.plan)}</Badge>
            <Status tone={statusMeta.tone}>{statusMeta.label}</Status>
          </span>
        }
        subtitle={`#${tenant.id} · ${tenant.slug || '—'} · cliente desde ${fmtDate(tenant.created_at)}`}
        breadcrumb={
          <div
            className="company-logo company-logo-lg u-mb-10"
          >
            {tenantInitials(tenant.nombre)}
          </div>
        }
        actions={
          <>
            {isSuspended ? (
              <Btn
                kind="primary"
                icon="Refresh"
                onClick={() => setOpenModal('reactivate')}
              >
                Reactivar
              </Btn>
            ) : (
              <Btn icon="Lock" onClick={() => setOpenModal('suspend')}>
                Suspender
              </Btn>
            )}
            {isTrial && (
              <Btn icon="Calendar" onClick={() => setOpenModal('extend-trial')}>
                Extender trial
              </Btn>
            )}
            <Btn icon="DollarSign" onClick={() => setOpenModal('set-paid-until')}>
              Marcar pago
            </Btn>
            <Btn icon="Sliders" onClick={() => setOpenModal('edit')}>
              Editar
            </Btn>
            {/* Eliminar (#438): destructivo crítico, va último en la fila
                para alejarlo visualmente de las acciones rutinarias. kind="danger"
                lo pinta rojo — combinado con el modal bloqueante (slug-confirm)
                hace falta intención clara para llegar a borrar. */}
            <Btn
              kind="danger"
              icon="Trash"
              onClick={() => setOpenModal('delete')}
            >
              Eliminar
            </Btn>
          </>
        }
      />

      {/* Banners contextuales ─────────────────────────────────────── */}
      {isSuspended && (
        <div className="banner banner-warn">
          <Icons.Lock size={16} />
          <span>
            <strong>Suspendida desde {fmtDate(tenant.suspended_at)}</strong>
            {' · '}
            {tenant.suspended_reason || 'sin razón documentada'}
          </span>
        </div>
      )}
      {isTrial && tenant.trial_until && (() => {
        const delta = trialDaysDelta(tenant.trial_until);
        if (delta == null) return null;
        if (delta < 0) {
          return (
            <div className="banner banner-neg">
              <Icons.Calendar size={16} />
              <span>
                <strong>Trial vencido</strong> hace {Math.abs(delta)} días
                ({fmtDate(tenant.trial_until)})
              </span>
            </div>
          );
        }
        return (
          <div className="banner banner-info">
            <Icons.Calendar size={16} />
            <span>
              Trial activo hasta <strong>{fmtDate(tenant.trial_until)}</strong>
              {' '}({delta} {delta === 1 ? 'día' : 'días'} restantes)
            </span>
          </div>
        );
      })()}

      {/* Banner paid_until (TANDA 4.B billing). Solo se muestra para
         non-trial tenants con paid_until set. Trial usa su propio banner
         arriba — paid_until y trial_until conviven pero conceptualmente
         se usa uno u otro según el plan. */}
      {!isTrial && tenant.paid_until && (() => {
        const delta = trialDaysDelta(tenant.paid_until);
        if (delta == null) return null;
        if (delta < 0) {
          return (
            <div className="banner banner-neg">
              <Icons.DollarSign size={16} />
              <span>
                <strong>Pago vencido</strong> hace {Math.abs(delta)} días
                ({fmtDate(tenant.paid_until)}) — el tenant está en read-only
              </span>
            </div>
          );
        }
        if (delta <= 7) {
          return (
            <div className="banner banner-warn">
              <Icons.DollarSign size={16} />
              <span>
                Pago vence en {delta} {delta === 1 ? 'día' : 'días'}
                {' '}(<strong>{fmtDate(tenant.paid_until)}</strong>)
              </span>
            </div>
          );
        }
        return (
          <div className="banner banner-info">
            <Icons.DollarSign size={16} />
            <span>
              Pagado hasta <strong>{fmtDate(tenant.paid_until)}</strong>
              {' '}({delta} días)
            </span>
          </div>
        );
      })()}

      {/* 4 stat cards ─────────────────────────────────────────────── */}
      <div className="ficha-stats">
        <Card tight>
          <div className="kpi-label">MRR</div>
          <div className="kpi-value">
            {fmtMoney(tenant.mrr_usd ?? 0)}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500, marginLeft: 4 }}>/mes</span>
          </div>
          <div className="muted tiny">Plan {planLabel(tenant.plan)}</div>
        </Card>

        <Card tight>
          <div className="kpi-label">Usuarios activos</div>
          <div className="kpi-value">{fmt(tenant.users_count ?? 0)}</div>
          <div className="muted tiny">miembros del tenant</div>
        </Card>

        <Card tight>
          <div className="kpi-label">Salud (proxy)</div>
          <div className="kpi-value" style={{ color: hColor }}>
            {health}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500, marginLeft: 4 }}>/100</span>
          </div>
          <div className="muted tiny">{hDesc}</div>
        </Card>

        <Card tight>
          <div className="kpi-label">Última venta</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>
            {tenant.last_venta_at ? ago(tenant.last_venta_at) : '—'}
          </div>
          <div className="muted tiny">
            {tenant.last_venta_at ? fmtDateTime(tenant.last_venta_at) : 'sin actividad de venta'}
          </div>
        </Card>
      </div>

      {/* Tabs ─────────────────────────────────────────────────────── */}
      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        options={[
          { value: 'resumen',    label: 'Resumen' },
          { value: 'actividad',  label: 'Actividad' },
        ]}
      />

      {activeTab === 'resumen' && (
        <div className="split-2 u-mt-var-gap">
          {/* Salud de la cuenta — 4 componentes del score (#440). El backend
              calcula cada uno y los devuelve en tenant.health_breakdown. La
              suma ponderada (30/30/20/20) da el score total. */}
          <Card title="Salud de la cuenta" subtitle="Componentes del score (ponderado)">
            <HealthBar
              label="Actividad (30%) — ventas + bot últimos 30d"
              value={breakdown.actividad}
              color="var(--info)"
            />
            <HealthBar
              label="Cobros al día (30%) — días hasta vencer pago"
              value={breakdown.cobros}
              color={breakdown.cobros >= 60 ? 'var(--pos)' : breakdown.cobros >= 30 ? 'var(--warn)' : 'var(--neg)'}
            />
            <HealthBar
              label="Adopción (20%) — features que usa el tenant"
              value={breakdown.adopcion}
              color="var(--accent)"
            />
            <HealthBar
              label="Asientos (20%) — users vs capacity del plan"
              value={breakdown.asientos}
              color="var(--accent)"
            />
            <div className="muted tiny u-mt-12">
              {hCategory === 'onboarding' && (
                <>
                  <strong>Onboarding:</strong> tenant nuevo (&lt;7 días). El score
                  tiene piso de 50 hasta que el cliente tenga oportunidad de
                  generar actividad.
                </>
              )}
              {hCategory === 'suspended' && (
                <>
                  <strong>Suspendida:</strong> el score se fuerza a 0 porque
                  el tenant está bloqueado operativamente.
                </>
              )}
              {hCategory !== 'onboarding' && hCategory !== 'suspended' && (
                <>
                  Score total = 0.3 × Actividad + 0.3 × Cobros + 0.2 × Adopción
                  {' '}+ 0.2 × Asientos.
                </>
              )}
            </div>
          </Card>

          <Card
            flush
            title="Actividad admin"
            subtitle="Últimas acciones sobre este tenant"
          >
            {!Array.isArray(tenant.recent_admin_actions) || tenant.recent_admin_actions.length === 0 ? (
              <div className="empty-state">
                <div className="empty-title">Sin acciones admin sobre este tenant todavía.</div>
                Las suspensiones, cambios de plan y notas que hagas acá
                aparecen en el feed.
              </div>
            ) : (
              <div className="activity">
                {tenant.recent_admin_actions.map((a) => {
                  const d = describeAction(a);
                  return (
                    <div key={a.id} className="activity-item">
                      <div
                        className="dot-ico"
                        style={{ color: `var(--${d.tone === 'muted' ? 'text-muted' : d.tone})` }}
                      >
                        <d.IconCmp size={14} />
                      </div>
                      <div className="activity-msg">{actionShortText(a)}</div>
                      <div className="activity-time">{ago(a.created_at)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Card de país (#473) — visible solo en tab Resumen, debajo del split.
         Acción super-admin exclusiva: cambiar pais del tenant arrastra
         side-effects (cajas nuevas + alerta TC). NO se muestra en
         tab Actividad para no contaminar el panel de drill-down. */}
      {activeTab === 'resumen' && (
        <div className="card u-mt-var-gap">
          <h3 style={{ margin: '0 0 8px' }}>País del tenant</h3>
          <p style={{ margin: '0 0 6px' }}>
            Actualmente:{' '}
            <strong>
              {tenant.pais === 'UY' ? 'Uruguay (UYU)' : 'Argentina (ARS)'}
            </strong>
          </p>
          <p className="muted tiny" style={{ margin: '0 0 12px' }}>
            Cambiar arrastra side-effects: se crean cajas nuevas en la moneda
            local del país nuevo (con sufijo en el nombre, sin borrar las
            viejas) y se actualiza el threshold de la alerta TC. Historial
            intacto.
          </p>
          <Btn icon="Tag" onClick={() => setOpenModal('change-pais')}>
            Cambiar país
          </Btn>
        </div>
      )}

      {/* Card de footer custom email comprobante (#475) — visible en tab
          Resumen. UI minimalista: textarea + Guardar + preview. No abre
          modal (no es destructivo, no requiere confirmación). */}
      {activeTab === 'resumen' && (
        <ComprobanteEmailFooterCard
          tenant={tenant}
          onSaved={handleSaved}
        />
      )}

      {/* Card de clases duplicadas (2026-07-14) — visible en tab Resumen.
         Detecta categorías de producto casi-duplicadas via trigram similarity
         + containment; permite fusionarlas con audit trail. Herramienta de
         mantenimiento post-hoc para clientes que dupliquen categorías via
         import XLSX / typing manual antes de que existiera este check. */}
      {activeTab === 'resumen' && (
        <ClasesDuplicadasCard tenantId={tenant.id} />
      )}

      {activeTab === 'actividad' && (
        <div className="u-mt-var-gap">
          <div className="flex-row u-mb-12">
            <Seg
              value={activitySubTab}
              onChange={setActivitySubTab}
              options={ACTIVITY_TABS}
            />
          </div>
          <ActivityPanel
            type={activitySubTab}
            data={activityData}
            loading={activityLoading}
            error={activityError}
          />
        </div>
      )}

      {/* Modals — siempre montados, controlados por openModal ─────── */}
      <EditTenantModal
        tenant={tenant}
        open={openModal === 'edit'}
        onClose={() => setOpenModal(null)}
        onSaved={handleSaved}
      />
      <SuspendTenantModal
        tenant={tenant}
        open={openModal === 'suspend'}
        onClose={() => setOpenModal(null)}
        onSaved={handleSaved}
      />
      <ReactivateTenantModal
        tenant={tenant}
        open={openModal === 'reactivate'}
        onClose={() => setOpenModal(null)}
        onSaved={handleSaved}
      />
      <ExtendTrialModal
        tenant={tenant}
        open={openModal === 'extend-trial'}
        onClose={() => setOpenModal(null)}
        onSaved={handleSaved}
      />
      <SetPaidUntilModal
        tenant={tenant}
        open={openModal === 'set-paid-until'}
        onClose={() => setOpenModal(null)}
        onSaved={handleSaved}
      />
      <ChangePaisTenantModal
        tenant={tenant}
        open={openModal === 'change-pais'}
        onClose={() => setOpenModal(null)}
        onSaved={handleSaved}
      />
      <DeleteTenantModal
        tenant={tenant}
        open={openModal === 'delete'}
        onClose={() => setOpenModal(null)}
        // onDeleted: a diferencia de onSaved, después de borrar el tenant
        // YA NO existe (o es soft-deleted), no tiene sentido recargarlo
        // y quedar viendo la misma ficha. Mandamos al user al listado con
        // un flag en navigate.state para que /clientes pueda mostrar un
        // toast/banner "Tenant X eliminado" si quiere.
        onDeleted={(meta) => {
          setOpenModal(null);
          navigate('/clientes', {
            state: {
              deletedTenant: {
                id: tenant?.id,
                nombre: tenant?.nombre,
                alreadyDeleted: !!meta?.alreadyDeleted,
              },
            },
          });
        }}
      />
    </>
  );
}

// ── Sub-componente: barra horizontal para "Salud de la cuenta" ─────
function HealthBar({ label, value, color }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="bar-row">
      <span className="bar-row-label">{label}</span>
      <span className="bar-row-value" style={{ color }}>{safe}</span>
      <div className="bar-row-track bar-track" style={{ height: 6 }}>
        <div
          className="bar-fill"
          style={{ width: safe + '%', background: color }}
        />
      </div>
    </div>
  );
}

// ── Sub-componente: panel de actividad por tipo ────────────────────
// Recibe el tipo activo + data crudo. Decide qué shape esperar.
function ActivityPanel({ type, data, loading, error }) {
  if (loading) {
    return (
      <Card flush>
        <table className="tbl">
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="tbl-skel-row">
                <td colSpan={5}>
                  <div className="skeleton" style={{ height: 14, width: '70%' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <div className="banner banner-neg" role="alert">{error}</div>
      </Card>
    );
  }
  if (!data) return null;

  switch (type) {
    case 'ventas':   return <VentasPanel items={data.items} />;
    case 'cajas':    return <CajasPanel items={data.items} />;
    case 'bot':      return <BotPanel summary={data.summary} conversations={data.recent_conversations} />;
    case 'alertas':  return <AlertasPanel items={data.items} />;
    case 'audit':    return <AuditPanel items={data.items} />;
    default:         return null;
  }
}

function emptyState(text) {
  return (
    <div className="empty-state">
      <div className="empty-title">{text}</div>
    </div>
  );
}

function VentasPanel({ items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return <Card flush>{emptyState('Sin ventas en el período.')}</Card>;
  }
  return (
    <Card flush>
      {/* TANDA 6 a11y (audit 2026-06-22): caption + scope="col". */}
      <table className="tbl">
        <caption className="sr-only">Ventas recientes de este tenant.</caption>
        <thead>
          <tr>
            <th scope="col">Fecha</th>
            <th scope="col">Order ID</th>
            <th scope="col">Cliente</th>
            <th scope="col" className="num">Total</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id}>
              <td className="muted tiny">{fmtDateTime(v.fecha || v.created_at)}</td>
              <td className="mono tiny">{v.order_id || '—'}</td>
              <td>{v.cliente_nombre || '—'}</td>
              <td className="num mono u-fw-600">
                {fmtMoney(v.total_usd ?? 0)}
              </td>
              <td><Status tone="muted">{v.estado || '—'}</Status></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CajasPanel({ items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return <Card flush>{emptyState('Sin movimientos de caja.')}</Card>;
  }
  return (
    <Card flush>
      <table className="tbl">
        <caption className="sr-only">Movimientos de caja recientes.</caption>
        <thead>
          <tr>
            <th scope="col">Fecha</th>
            <th scope="col">Caja</th>
            <th scope="col">Tipo</th>
            <th scope="col">Concepto</th>
            <th scope="col" className="num">Monto (USD)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td className="muted tiny">{fmtDateTime(m.fecha)}</td>
              <td>{m.caja_nombre || '—'}</td>
              <td><Badge tone="default">{m.tipo || '—'}</Badge></td>
              <td>{m.concepto || '—'}</td>
              <td className="num mono u-fw-600">
                {fmtMoney(m.monto_usd ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function BotPanel({ summary, conversations }) {
  const hasConvs = Array.isArray(conversations) && conversations.length > 0;
  const hasSummary = summary && (summary.mensajes_total || summary.conversaciones);
  if (!hasConvs && !hasSummary) {
    return <Card flush>{emptyState('Este tenant no usó el bot todavía.')}</Card>;
  }
  return (
    <div className="stack">
      {summary && (
        <div className="ficha-stats">
          <Card tight>
            <div className="kpi-label">Mensajes total</div>
            <div className="kpi-value">{fmt(summary.mensajes_total ?? 0)}</div>
          </Card>
          <Card tight>
            <div className="kpi-label">Mensajes user</div>
            <div className="kpi-value">{fmt(summary.mensajes_user ?? 0)}</div>
          </Card>
          <Card tight>
            <div className="kpi-label">Conversaciones</div>
            <div className="kpi-value">{fmt(summary.conversaciones ?? 0)}</div>
          </Card>
          <Card tight>
            <div className="kpi-label">Último mensaje</div>
            <div className="kpi-value" style={{ fontSize: 16 }}>
              {summary.ultimo_mensaje ? ago(summary.ultimo_mensaje) : '—'}
            </div>
          </Card>
        </div>
      )}

      <Card flush title="Conversaciones recientes" subtitle="Top 20 por actividad">
        {!hasConvs ? (
          emptyState('Sin conversaciones recientes.')
        ) : (
          <table className="tbl">
            <caption className="sr-only">Conversaciones recientes del bot.</caption>
            <thead>
              <tr>
                <th scope="col">Título</th>
                <th scope="col">Usuario</th>
                <th scope="col" className="num">Mensajes</th>
                <th scope="col">Creada</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.conversation_id}>
                  <td>{c.titulo || '—'}</td>
                  <td>{c.username || '—'}</td>
                  <td className="num mono">{fmt(c.msg_count ?? 0)}</td>
                  <td className="muted tiny">{c.created_at ? ago(c.created_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function AlertasPanel({ items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return <Card flush>{emptyState('Sin alertas configuradas.')}</Card>;
  }
  return (
    <Card flush>
      <table className="tbl">
        <caption className="sr-only">Alertas configuradas para este tenant.</caption>
        <thead>
          <tr>
            <th scope="col">Tipo</th>
            <th scope="col">Estado</th>
            <th scope="col">Parámetros</th>
            <th scope="col">Actualizada</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={`${a.tipo}-${i}`}>
              <td><Badge tone="info">{a.tipo || '—'}</Badge></td>
              <td>
                <Status tone={a.activa ? 'pos' : 'muted'}>
                  {a.activa ? 'Activa' : 'Inactiva'}
                </Status>
              </td>
              <td className="mono tiny" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {a.parametros ? JSON.stringify(a.parametros) : '—'}
              </td>
              <td className="muted tiny">{fmtDateTime(a.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function AuditPanel({ items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return <Card flush>{emptyState('Sin cambios de datos recientes.')}</Card>;
  }
  return (
    <Card flush>
      <table className="tbl">
        <caption className="sr-only">Cambios recientes auditados del tenant.</caption>
        <thead>
          <tr>
            <th scope="col">Cuándo</th>
            <th scope="col">Tabla</th>
            <th scope="col">Acción</th>
            <th scope="col">Registro</th>
            <th scope="col">User</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="mono tiny">{fmtDateTime(a.created_at)}</td>
              <td className="mono">{a.tabla || '—'}</td>
              <td><Badge tone={auditAccionTone(a.accion)}>{a.accion || '—'}</Badge></td>
              <td className="mono">{a.registro_id || '—'}</td>
              <td className="mono">{a.user_id || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// Memo: este componente vive bajo un Route protegido; el unmount/mount
// natural al cambiar :id resetea state. No hace falta cleanup explícito
// del fetch en useEffect (alive flag) salvo en /activity — ahí sí está.

// ── #475: Card de footer custom email comprobante ───────────────────────
//
// Card embebida (no modal) — la mutación es 1 textarea + Guardar, no
// requiere flow multi-paso ni confirmación destructiva. Local state simple,
// PATCH inline, preview que refleja el textarea en tiempo real.
//
// Max 500 chars — enforced en backend (Zod). El frontend valida en input
// con counter visual para que el operador no se sorprenda con un 400.
const FOOTER_DEFAULT_PREVIEW = 'Gracias por confiar en {tenant.nombre}.';
const FOOTER_MAX = 500;

function ComprobanteEmailFooterCard({ tenant, onSaved }) {
  const initial = tenant.comprobante_email_footer || '';
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // Sync local state cuando el tenant cambia (post-save → onSaved re-fetches
  // y refresca el tenant prop).
  useEffect(() => {
    setValue(tenant.comprobante_email_footer || '');
    setSaved(false);
    setError('');
  }, [tenant.id, tenant.comprobante_email_footer]);

  const dirty = value !== initial;
  const overLimit = value.length > FOOTER_MAX;

  async function handleSave() {
    if (overLimit) {
      setError(`Máximo ${FOOTER_MAX} caracteres`);
      return;
    }
    setSaving(true); setError(''); setSaved(false);
    try {
      // null cuando vacío post-trim → revierte al default.
      const payload = value.trim() === '' ? null : value;
      await adminApi.updateComprobanteFooter(tenant.id, payload);
      setSaved(true);
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      setError(err.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  // Preview en el shell del email — el operador ve cómo se ve sin tener
  // que hacer un envío de prueba.
  const previewText = value.trim() || FOOTER_DEFAULT_PREVIEW.replace('{tenant.nombre}', tenant.nombre || 'Tecny');

  return (
    <div className="card u-mt-var-gap">
      <h3 style={{ margin: '0 0 8px' }}>Footer email comprobante</h3>
      <p className="muted tiny" style={{ margin: '0 0 12px' }}>
        Texto que aparece al final del email de comprobante de venta retail que
        recibe el cliente final. Plain-text — sin HTML (se escapa al renderizar).
        Dejá vacío para usar el footer default.
      </p>
      <div className="field u-mb-10">
        <label className="field-label" htmlFor="footer-textarea">
          Footer custom <span className="muted tiny">({value.length}/{FOOTER_MAX})</span>
        </label>
        <textarea
          id="footer-textarea"
          className="input"
          rows={5}
          maxLength={FOOTER_MAX + 50}  // soft cap; real cap enforced abajo
          placeholder={`Ej:\nAv. Corrientes 1234, CABA\nWhatsApp: 11-2233-4455\n@miempresa_ok`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ fontFamily: 'inherit', resize: 'vertical' }}
        />
        {overLimit && (
          <div className="tiny u-color-neg-mt-4">
            Excede el máximo de {FOOTER_MAX} caracteres
          </div>
        )}
      </div>
      <div className="flex-row" style={{ gap: 8, alignItems: 'center' }}>
        <Btn icon="Save" onClick={handleSave} disabled={!dirty || saving || overLimit}>
          {saving ? 'Guardando…' : 'Guardar'}
        </Btn>
        {saved && <span className="tiny u-color-pos">✓ Guardado</span>}
        {error && <span className="tiny u-color-neg">{error}</span>}
      </div>

      {/* Preview — aproximación visual al footer del email */}
      <div style={{ marginTop: 16 }}>
        <div className="muted tiny" style={{ marginBottom: 6 }}>Vista previa del footer:</div>
        <div style={{
          padding: '14px 18px',
          background: 'var(--surface-2)',
          borderTop: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--text-muted)',
          textAlign: 'center',
          whiteSpace: 'pre-wrap',
        }}>
          {previewText}
        </div>
      </div>
    </div>
  );
}

// ── Sub-componente: card de "Categorías duplicadas" (2026-07-14) ──────
//
// Diseñado como herramienta on-demand (fetch al clickear "Buscar duplicados"),
// no fetch automático al montar. Razón: la lista de tenants tiene ~10 clientes
// y solo pocos van a tener duplicados; hacer 10 queries pg_trgm cada vez que
// se abre una ficha es waste. El operador clickea cuando sospecha.
//
// El componente maneja su propio estado (pairs + loading + error + modal
// abierto). No participa del handleSaved del componente padre porque las
// mutations acá no afectan al objeto tenant (solo tocan clases_producto +
// productos + tenant_admin_actions).
function ClasesDuplicadasCard({ tenantId }) {
  const [pairs, setPairs] = useState(null);   // null = no fetched, [] = fetched empty
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openPair, setOpenPair] = useState(null);
  const [lastMergeResult, setLastMergeResult] = useState(null);

  const fetchPairs = useCallback(async () => {
    setLoading(true);
    setError('');
    setLastMergeResult(null);
    try {
      const data = await adminApi.getClasesDuplicadas(tenantId);
      setPairs(Array.isArray(data?.pairs) ? data.pairs : []);
    } catch (err) {
      setError(err?.message || 'No pudimos buscar duplicados.');
      setPairs(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  const handleMerged = useCallback((result) => {
    // Post-merge: cerramos el modal, guardamos el resultado para mostrar un
    // banner de éxito, y re-fetcheamos la lista (la duplicada ya no debería
    // aparecer, pero puede haber otros pares afectados por el mismo cambio).
    setOpenPair(null);
    setLastMergeResult(result);
    fetchPairs();
  }, [fetchPairs]);

  const confidenceTone = (c) => {
    if (c === 'high')   return 'pos';
    if (c === 'medium') return 'warn';
    return 'muted';
  };

  return (
    <>
      <div className="card u-mt-var-gap">
        <div className="flex-between u-mb-8">
          <div>
            <h3 style={{ margin: '0 0 4px' }}>Categorías duplicadas</h3>
            <p className="muted tiny" style={{ margin: 0 }}>
              Detecta categorías de producto casi-duplicadas dentro del tenant
              (ej: <code>iPads</code> vs <code>ipad</code>) via trigram similarity
              + containment. Fusionar mueve los productos a la canónica y
              soft-deletea la duplicada.
            </p>
          </div>
          <Btn
            icon="Search"
            onClick={fetchPairs}
            disabled={loading}
          >
            {loading ? 'Buscando…' : (pairs == null ? 'Buscar duplicados' : 'Refrescar')}
          </Btn>
        </div>

        {lastMergeResult && (
          <div className="banner banner-info u-mt-10">
            <Icons.Sparkle size={16} />
            <span>
              Fusionadas: <code>{lastMergeResult.duplicada_nombre}</code>
              {' → '}
              <code>{lastMergeResult.canonica_nombre}</code>
              {' '}({lastMergeResult.productos_movidos} producto{lastMergeResult.productos_movidos === 1 ? '' : 's'} movido{lastMergeResult.productos_movidos === 1 ? '' : 's'}).
            </span>
          </div>
        )}

        {error && (
          <div className="banner banner-neg u-mt-10" role="alert">
            {error}
          </div>
        )}

        {pairs != null && !loading && !error && pairs.length === 0 && (
          <div className="empty-state u-mt-10">
            <div className="empty-title">Sin duplicados detectados</div>
            No se encontraron categorías casi-duplicadas en este tenant.
          </div>
        )}

        {Array.isArray(pairs) && pairs.length > 0 && (
          <div className="u-mt-10">
            <table className="tbl">
              <caption className="sr-only">
                Pares de categorías casi-duplicadas detectadas en el catálogo del tenant.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Canónica sugerida</th>
                  <th scope="col">Duplicada sugerida</th>
                  <th scope="col" className="num">Sim.</th>
                  <th scope="col">Confianza</th>
                  <th scope="col" className="u-w-100px">Acción</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => {
                  const canonica = p.a.id === p.canonica_suggested_id ? p.a : p.b;
                  const duplicada = p.a.id === p.duplicada_suggested_id ? p.a : p.b;
                  const key = `${p.a.id}::${p.b.id}`;
                  return (
                    <tr key={key}>
                      <td>
                        <div className="u-fw-600">{canonica.nombre}</div>
                        <div className="muted tiny">
                          {canonica.count_productos} prod
                          {canonica.es_base && ' · base'}
                          {canonica.es_sin_categoria && ' · sin_cat'}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, opacity: 0.85 }}>{duplicada.nombre}</div>
                        <div className="muted tiny">
                          {duplicada.count_productos} prod
                          {duplicada.es_base && ' · base'}
                          {duplicada.es_sin_categoria && ' · sin_cat'}
                        </div>
                      </td>
                      <td className="num mono tiny">
                        {Math.round((p.similarity || 0) * 100)}%
                      </td>
                      <td>
                        <Status tone={confidenceTone(p.confidence)}>
                          {p.confidence}
                        </Status>
                      </td>
                      <td>
                        <Btn sm onClick={() => setOpenPair(p)}>
                          Fusionar
                        </Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="muted tiny u-mt-8">
              Ordenados por score (containment {'>'} similitud). Confianza{' '}
              <strong>high</strong> = score ≥ 0.9 (típicamente uno contiene al otro);
              {' '}<strong>medium</strong> = resto de matches.
            </div>
          </div>
        )}

        {loading && pairs == null && (
          <div className="muted tiny u-mt-10">Analizando el catálogo…</div>
        )}
      </div>

      <MergeClasesModal
        tenantId={tenantId}
        pair={openPair}
        open={!!openPair}
        onClose={() => setOpenPair(null)}
        onMerged={handleMerged}
      />
    </>
  );
}
