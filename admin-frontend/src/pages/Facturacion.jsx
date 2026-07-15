// Pantalla Facturación y cobros del admin console (task #131, 2026-07-15 v2).
//
// V2 (rediseño post-feedback): la v1 mostraba facturas mock con hash y
// quedaba vacío cuando todos los tenants eran trial (o plan_prices en 0).
// Ahora la tabla lista los TENANTS REALES con su estado de cuenta derivado
// de campos que ya usa Ficha (paid_until, trial_until, suspended_at).
//
// Es honesto sobre el estado actual: cobro manual por WhatsApp/transferencia,
// no hay facturas ni pasarela de pago integrada. Cuando integremos billing
// real (Stripe/MP), esta pantalla sigue siendo válida como "estado de cuenta"
// y se agrega /facturas separada para el histórico transaccional.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import { Btn, Card, Badge, PageHead, Tabs } from '../components/primitives/index.jsx';
import { fmtMoney, fmtDate, fmt } from '../lib/format.js';
import { planTone } from '../lib/uiHelpers.js';

// Estado canónico del tenant → { tone, label } para el badge.
// Los tones ya existen en styles.css (s-pos/s-neg/s-warn/s-info/s-muted).
const ESTADO_META = {
  al_dia:        { tone: 'pos',    label: 'Al día' },
  vencida:       { tone: 'neg',    label: 'Vencida' },
  trial:         { tone: 'info',   label: 'Trial' },
  trial_vencido: { tone: 'warn',   label: 'Trial vencido' },
  sin_config:    { tone: 'muted',  label: 'Sin configurar' },
  suspendida:    { tone: 'muted',  label: 'Suspendida' },
};

export default function Facturacion() {
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('todos');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');

    adminApi.getFacturacion()
      .then((res) => {
        if (!alive) return;
        setData(res);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || 'No pudimos cargar la facturación.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => { alive = false; };
  }, []);

  const kpis = data?.kpis || {};
  const clientes = data?.clientes || [];

  const clientesFiltrados = useMemo(() => {
    if (tab === 'todos') return clientes;
    if (tab === 'al_dia')   return clientes.filter((c) => c.estado === 'al_dia');
    if (tab === 'vencidos') return clientes.filter((c) => c.estado === 'vencida' || c.estado === 'sin_config');
    if (tab === 'trials')   return clientes.filter((c) => c.estado === 'trial' || c.estado === 'trial_vencido');
    if (tab === 'suspendidos') return clientes.filter((c) => c.estado === 'suspendida');
    return clientes;
  }, [clientes, tab]);

  return (
    <>
      <PageHead
        label="Facturación"
        title="Facturación y cobros"
        subtitle="Estado de cuenta de tus clientes · cobros manuales todavía (WhatsApp / transferencia)"
        actions={
          <>
            <Btn
              icon="Download"
              onClick={() => {}}
              disabled
              title="Próximamente — exportar estado de cuenta en CSV"
            >
              Exportar
            </Btn>
          </>
        }
      />

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

      {/* KPI grid — 4 columnas responsive (colapsan a 2 en mobile por minmax). */}
      <div
        className="kpi-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}
      >
        <div className="kpi">
          <div className="kpi-label">MRR</div>
          <div className="kpi-value">
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 80, height: 22 }} />
            ) : (
              fmtMoney(kpis.mrr_usd ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className="muted">
              {loading ? '' : `${fmt(kpis.total_clientes ?? 0)} clientes total`}
            </span>
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Al día</div>
          <div
            className="kpi-value"
            style={{ color: (kpis.al_dia_count ?? 0) > 0 ? 'var(--pos)' : undefined }}
          >
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 60, height: 22 }} />
            ) : (
              fmt(kpis.al_dia_count ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className="muted">
              {loading ? '' : fmtMoney(kpis.al_dia_usd ?? 0) + '/mes'}
            </span>
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Vencidos</div>
          <div
            className="kpi-value"
            style={{ color: (kpis.vencidos_count ?? 0) > 0 ? 'var(--neg)' : undefined }}
          >
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 60, height: 22 }} />
            ) : (
              fmt(kpis.vencidos_count ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className="muted">
              {loading ? '' : (kpis.vencidos_count ?? 0) > 0
                ? fmtMoney(kpis.vencidos_usd ?? 0) + ' pendiente'
                : 'sin vencidos'}
            </span>
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Trials</div>
          <div className="kpi-value">
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 60, height: 22 }} />
            ) : (
              fmt(kpis.trials_count ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className={
              (kpis.trials_por_vencer_7d ?? 0) > 0
                ? 'status s-warn'
                : 'muted'
            } style={{ fontSize: 12 }}>
              {loading ? '' : (kpis.trials_por_vencer_7d ?? 0) > 0
                ? `${kpis.trials_por_vencer_7d} vencen en 7d`
                : 'sin urgencias'}
            </span>
          </div>
        </div>
      </div>

      {/* Tabla de clientes */}
      <Card
        flush
        title="Clientes"
        subtitle="Estado de cuenta de cada tenant · click en fila para ver la ficha"
        style={{ marginTop: 'var(--gap)' }}
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'todos',       label: 'Todos' },
              { value: 'al_dia',      label: 'Al día' },
              { value: 'vencidos',    label: 'Vencidos' },
              { value: 'trials',      label: 'Trials' },
              { value: 'suspendidos', label: 'Suspendidos' },
            ]}
          />
        }
      >
        {loading && (
          <div className="empty-state">
            <div className="empty-title">Cargando…</div>
          </div>
        )}

        {!loading && clientesFiltrados.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">
              {tab === 'todos'
                ? 'Sin clientes todavía.'
                : 'Ningún cliente en este estado.'}
            </div>
          </div>
        )}

        {!loading && clientesFiltrados.length > 0 && (
          <table className="tbl">
            <caption className="sr-only">
              Clientes activos con su estado de cuenta.
            </caption>
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col">Plan</th>
                <th scope="col" className="num">MRR/mes</th>
                <th scope="col">Próximo cobro</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {clientesFiltrados.map((c) => {
                const est = ESTADO_META[c.estado] || { tone: 'muted', label: c.estado };
                const fechaLabel =
                  c.plan === 'trial' && c.fecha_referencia
                    ? `Trial hasta ${fmtDate(c.fecha_referencia)}`
                    : c.fecha_referencia
                    ? fmtDate(c.fecha_referencia)
                    : '—';
                return (
                  <tr
                    key={c.id}
                    className="tbl-row-click"
                    onClick={() => navigate('/clientes/' + c.tenant_id)}
                    title={`Ver ficha de ${c.tenant_nombre}`}
                  >
                    <td style={{ fontWeight: 600 }}>{c.tenant_nombre || '—'}</td>
                    <td>
                      <Badge tone={planTone(c.plan)}>{c.plan_label || c.plan}</Badge>
                    </td>
                    <td className="num mono" style={{ fontWeight: 600 }}>
                      {c.monto_usd > 0 ? fmtMoney(c.monto_usd) : '—'}
                    </td>
                    <td className="muted tiny">{fechaLabel}</td>
                    <td>
                      <span
                        className={'status s-' + est.tone}
                        title={c.suspended_reason || undefined}
                      >
                        {est.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
