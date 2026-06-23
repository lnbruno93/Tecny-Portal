// Pantalla Resumen del admin console (#353).
//
// Compone 4 bloques contra los endpoints reales de /api/super-admin/*:
//   1. Hero "hola, X" con saludo + acciones placeholder
//   2. Grid de 6 KPIs (MRR, activos, ARPA, churn, signups, trials)
//   3. Split: chart de evolución 90 días + activity feed
//   4. Split: top clientes por usuarios + distribución MRR por plan
//
// Diseño defensivo: todos los valores numéricos usan ?? 0 antes de
// pasar a formatters, todos los textos de tenant usan ?? '—'. El
// endpoint puede devolver shapes parciales si el backend agrega/quita
// campos — la UI debería seguir renderizando sin crashes.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Btn, Card, Badge } from '../components/primitives/index.jsx';
import { fmt, fmtMoney, fmtPct, ago } from '../lib/format.js';
import { planTone, planLabel, tenantInitials } from '../lib/uiHelpers.js';
import { describeAction, actionLongText } from '../lib/actionDescriptors.js';
import ColChart from '../components/charts/ColChart.jsx';

// ── Helpers locales (no se reusan fuera de Resumen) ──────────────────

// "lucas.bruno" → "Lucas". Si no hay dot/underscore tomamos todo el
// username. Email funciona porque tomamos antes del @ primero.
function firstName(user) {
  const raw = user?.username || user?.email || '';
  if (!raw) return 'Lucas'; // fallback obvio: el único super-admin actual
  const base = String(raw).split('@')[0];
  const first = base.split(/[._-]/)[0] || base;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// El mapeo action→{icon,tone,texto} vive en lib/actionDescriptors.js para
// reuso desde Ficha. Importamos describeAction + actionLongText arriba.

// Plan canónico → CSS var para color de barra en "Distribución por plan".
// Usamos PLAN_TONES vía planTone() para el badge, pero la barra necesita
// el color resuelto (no la clase). Tablita chica acá.
const PLAN_BAR_COLOR = {
  trial:      'var(--text-dim)',
  starter:    'var(--accent)',
  pro:        'var(--info)',
  enterprise: 'var(--warn)',
};

export default function Resumen() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [metrics, setMetrics] = useState(null);
  const [history, setHistory] = useState([]);
  const [actions, setActions] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Cargamos los 4 endpoints en paralelo. Si alguno falla, NO bloqueamos
  // el render — mostramos el que funcionó y un banner muted con error.
  // La alternativa "todo o nada" era hostil para el caso típico
  // (un endpoint con problema temporal, el resto OK).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');

    Promise.allSettled([
      adminApi.getMetrics(),
      adminApi.getMetricsHistory(),
      adminApi.getRecentActions(10),
      adminApi.listTenants(),
    ]).then((results) => {
      if (!alive) return;
      const [m, h, a, t] = results;
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (h.status === 'fulfilled') setHistory(h.value?.history || []);
      if (a.status === 'fulfilled') setActions(a.value?.recent_actions || []);
      // PERF-2 (audit 2026-06-22): listTenants ahora devuelve
      // { tenants, total, ... }. Defensive: aceptar shape viejo (array).
      if (t.status === 'fulfilled') {
        const list = Array.isArray(t.value)
          ? t.value
          : Array.isArray(t.value?.tenants) ? t.value.tenants : [];
        setTenants(list);
      }

      // Si TODOS fallaron, mostramos error banner. Si alguno funcionó,
      // dejamos que el render parcial hable.
      const allFailed = results.every((r) => r.status === 'rejected');
      if (allFailed) {
        const firstErr = results.find((r) => r.status === 'rejected');
        setError(firstErr?.reason?.message || 'No pudimos cargar los datos.');
      }
      setLoading(false);
    });

    return () => { alive = false; };
  }, []);

  // ── Derivaciones para los KPIs ───────────────────────────────────
  const kpis = useMemo(() => {
    const m = metrics || {};
    const active = m.tenants_active ?? 0;
    const mrr = m.mrr_total_usd ?? 0;
    const signups30 = m.signups_30d ?? 0;
    const signups7 = m.signups_7d ?? 0;
    const churn = m.churn_30d ?? 0;
    const trials = m.tenants_trial ?? 0;
    const conv = m.conversion_trial_paid_30d ?? 0;
    // ARPA: MRR / clientes activos. Si no hay activos lo evitamos
    // (division by zero → Infinity → "$Infinity" en pantalla).
    const arpa = active > 0 ? mrr / active : 0;
    // Churn rate como % de activos. Si churn=0 → 0% (no NaN).
    const churnPct = active > 0 ? (churn / active) * 100 : 0;

    return [
      {
        label: 'MRR',
        value: fmtMoney(mrr),
        unit: '/mes',
        sub: 'ver detalle por plan abajo',
      },
      {
        label: 'Clientes activos',
        value: String(active),
        unit: '',
        sub: signups30 > 0 ? `+${signups30} en 30d` : 'sin altas en 30d',
        tone: signups30 > 0 ? 'pos' : 'muted',
      },
      {
        label: 'ARPA',
        value: fmtMoney(arpa),
        unit: '/mes',
        sub: 'por cuenta activa',
      },
      {
        label: 'Churn (30d)',
        value: fmtPct(churnPct),
        unit: '',
        sub: churn > 0 ? `${churn} suspensiones` : 'sin bajas',
        tone: churn > 0 ? 'neg' : 'muted',
      },
      {
        label: 'Nuevos (mes)',
        value: String(signups30),
        unit: '',
        sub: `${signups7} en últ. 7 días`,
      },
      {
        label: 'Trials activos',
        value: String(trials),
        unit: '',
        sub: `conv 30d: ${fmtPct(conv)}`,
      },
    ];
  }, [metrics]);

  // Nudge cuando los precios de plan están en 0 (placeholder) — Lucas
  // todavía no configuró pricing real. Sin esto el "$0 MRR" se ve como bug.
  const pricesPending = useMemo(() => {
    const p = metrics?.plan_prices_usd;
    if (!p) return false;
    return (p.starter ?? 0) === 0 && (p.pro ?? 0) === 0 && (p.enterprise ?? 0) === 0;
  }, [metrics]);

  // Top 5 tenants por usuarios, excluyendo suspendidos. Lo recalculamos
  // solo cuando cambia el array de tenants — `useMemo` evita rehacer
  // el sort en cada render.
  const topTenants = useMemo(() => {
    if (!Array.isArray(tenants)) return [];
    return tenants
      .filter((t) => !t.suspended_at)
      .slice()
      .sort((a, b) => (b.users_count || 0) - (a.users_count || 0))
      .slice(0, 5);
  }, [tenants]);

  // Distribución por plan: el backend ya devuelve ordenado por MRR
  // descendente. Si llega vacío (race con seed inicial), no rompemos.
  const planDist = metrics?.tenants_by_plan || [];
  const totalMrr = metrics?.mrr_total_usd ?? 0;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      {/* Hero "hola" — fuera de PageHead a propósito para no perder el
          espacio del label/título normal. */}
      <div className="hello">
        <div className="greet">
          <h1>Hola, {firstName(user)}</h1>
          <div className="sub">
            Así viene Tecny hoy ·{' '}
            {(metrics?.tenants_active ?? 0)} empresas suscriptas ·{' '}
            {(metrics?.signups_30d ?? 0)} altas este mes
          </div>
        </div>
        <div className="quick">
          <Btn icon="Download" disabled title="Próximamente">Exportar</Btn>
          <Btn kind="primary" icon="Plus" disabled title="Próximamente">
            Invitar cliente
          </Btn>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="card"
          style={{
            marginBottom: 'var(--gap)',
            background: 'var(--neg-soft)',
            border: '1px solid transparent',
            color: 'var(--neg)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* KPI grid — 6 columnas. La clase kpi-grid-6 setea el grid-template
          en CSS, y los breakpoints colapsan a 3/2 cols en mobile. */}
      <div className="kpi-grid kpi-grid-6">
        {kpis.map((k, i) => (
          <div key={k.label} className="kpi">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: 60, height: 22 }} /> : k.value}
              {k.unit && (
                <span className="muted" style={{ fontSize: 12, fontWeight: 500, marginLeft: 4 }}>
                  {k.unit}
                </span>
              )}
            </div>
            <div className={'kpi-trend' + (k.tone === 'pos' ? ' t-pos' : k.tone === 'neg' ? ' t-neg' : '')}>
              <span className="muted">{k.sub}</span>
            </div>
            {/* Sparkbar visual placeholder — MRR histórico no existe aún
                en el endpoint. Lo dejamos vacío para mantener el ritmo
                visual del grid sin engañar con datos fake. */}
            {i === 0 && pricesPending ? (
              <div className="muted tiny" style={{ marginTop: 4 }}>
                (precios pendientes de configurar)
              </div>
            ) : (
              <div className="kpi-sparkbar" />
            )}
          </div>
        ))}
      </div>

      {/* Split 1: chart de evolución + activity feed */}
      <div className="split-2" style={{ marginTop: 'var(--gap)' }}>
        <Card
          title="Evolución (90 días)"
          subtitle="Signups y suspensiones diarias"
        >
          <ColChart series={history} />
          <div className="chart-legend">
            <span>
              <span className="lg-dot" style={{ background: 'var(--accent)' }} />
              Altas
            </span>
            <span>
              <span className="lg-dot" style={{ background: 'var(--neg)' }} />
              Suspensiones
            </span>
          </div>
          <div className="muted tiny" style={{ marginTop: 8 }}>
            MRR histórico próximamente.
          </div>
        </Card>

        <Card
          flush
          title="Actividad reciente"
          subtitle="Últimas acciones admin"
          actions={
            <Btn kind="ghost" sm disabled title="Próximamente">
              Ver todo
            </Btn>
          }
        >
          {actions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-title">Sin acciones admin todavía.</div>
              Lo que hagas en Clientes / Ficha aparece acá.
            </div>
          ) : (
            <div className="activity">
              {actions.slice(0, 7).map((a) => {
                const d = describeAction(a);
                return (
                  <div key={a.id} className="activity-item">
                    <div
                      className="dot-ico"
                      style={{ color: `var(--${d.tone === 'muted' ? 'text-muted' : d.tone})` }}
                    >
                      <d.IconCmp size={14} />
                    </div>
                    <div className="activity-msg">{actionLongText(a)}</div>
                    <div className="activity-time">{ago(a.created_at)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Split 2: top tenants + distribución por plan */}
      <div className="split-2" style={{ marginTop: 'var(--gap)' }}>
        <Card
          flush
          title="Top clientes por usuarios"
          subtitle="Tenants con mayor adopción"
          actions={
            <Btn kind="ghost" sm onClick={() => navigate('/clientes')}>
              Ver todos
            </Btn>
          }
        >
          {topTenants.length === 0 ? (
            <div className="empty-state">
              <div className="empty-title">Sin tenants activos.</div>
              Cuando alguien se suscriba aparece acá.
            </div>
          ) : (
            <table className="tbl">
              {/* TANDA 6 a11y (audit 2026-06-22): caption + scope. */}
              <caption className="sr-only">
                Top 5 clientes activos ordenados por cantidad de usuarios.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Empresa</th>
                  <th scope="col">Plan</th>
                  <th scope="col" className="num">Usuarios</th>
                  <th scope="col">Última venta</th>
                </tr>
              </thead>
              <tbody>
                {topTenants.map((t) => (
                  <tr
                    key={t.id}
                    className="tbl-row-click"
                    onClick={() => navigate('/clientes/' + t.id)}
                  >
                    <td>
                      <div className="flex-row" style={{ gap: 10 }}>
                        <div className="company-logo">{tenantInitials(t.nombre)}</div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{t.nombre || '—'}</div>
                          <div className="muted tiny">{t.slug || ''}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={planTone(t.plan)}>{planLabel(t.plan)}</Badge>
                    </td>
                    <td className="num mono" style={{ fontWeight: 600 }}>
                      {fmt(t.users_count ?? 0)}
                    </td>
                    <td className="muted tiny">{t.last_venta_at ? ago(t.last_venta_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Distribución por plan" subtitle="Suscriptores y MRR por plan">
          {planDist.length === 0 ? (
            <div className="empty-state">
              <div className="empty-title">Sin datos de planes.</div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              {planDist.map((p) => {
                const price = metrics?.plan_prices_usd?.[p.plan] ?? 0;
                // % de la barra basado en MRR. Si totalMrr=0 (precios
                // placeholder), TODAS las barras quedan en 0% — lo
                // explicitamos abajo con el nudge.
                const widthPct = totalMrr > 0
                  ? Math.min(100, (Number(p.mrr_usd || 0) / totalMrr) * 100)
                  : 0;
                return (
                  <div key={p.plan}>
                    <div className="flex-between" style={{ marginBottom: 6 }}>
                      <span className="flex-row" style={{ gap: 8 }}>
                        <Badge tone={planTone(p.plan)}>{planLabel(p.plan)}</Badge>
                        <span className="muted tiny">
                          {p.count ?? 0} clientes · {fmtMoney(price)} precio/mes
                        </span>
                      </span>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {fmtMoney(p.mrr_usd ?? 0)} MRR
                      </span>
                    </div>
                    <div className="bar-track" style={{ height: 8 }}>
                      <div
                        className="bar-fill"
                        style={{
                          width: widthPct + '%',
                          background: PLAN_BAR_COLOR[p.plan] || 'var(--accent)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
              {pricesPending && (
                <div className="muted tiny">
                  (precios pendientes — definir en Planes)
                </div>
              )}
            </div>
          )}
          <hr className="h-rule" />
          <div className="flex-between">
            <span className="muted tiny">MRR total</span>
            <span className="mono" style={{ fontWeight: 700, fontSize: 18 }}>
              {fmtMoney(totalMrr)}
              <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>/mes</span>
            </span>
          </div>
        </Card>
      </div>
    </>
  );
}

// Nota: el hero "hello" reemplaza al PageHead estándar en esta pantalla.
// Si en el futuro Lucas decide volver al PageHead clásico, importarlo
// desde ../components/primitives/index.jsx y reemplazar el <div className="hello">.
