// Pantalla Facturación y cobros del admin console (task #130, 2026-07-15).
//
// Vista SaaS billing dashboard: MRR, cobrado del mes, pendientes, fallidas +
// tabla de facturas recientes con filtros por estado.
//
// UI-first con mock: el backend genera facturas determinísticas desde tenants
// reales, así podemos iterar la UI antes de tener billing real (Stripe/MP).
// La response del endpoint está pensada forward-compatible — cuando
// integremos billing real, esta pantalla no se toca.
//
// Diseño defensivo idéntico a Resumen.jsx:
//   · Todos los valores numéricos con ?? 0 antes de formatear.
//   · Loading state con skeletons en los KPI values.
//   · Error banner separado del render (no bloqueamos si el endpoint falla).
//   · Empty state en la tabla si no hay facturas.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import { Btn, Card, Badge, PageHead, Tabs } from '../components/primitives/index.jsx';
import { fmtMoney, fmtDate } from '../lib/format.js';
import { planTone } from '../lib/uiHelpers.js';

// Estado → tone del badge de la tabla y del status dot.
// El mockup usa verde/amarillo/rojo — mapeamos a los tones del sistema para
// mantener consistencia con el resto del back office.
const ESTADO_META = {
  pagada:    { tone: 'pos',  label: 'Pagada' },
  pendiente: { tone: 'warn', label: 'Pendiente' },
  fallida:   { tone: 'neg',  label: 'Fallida' },
};

// Método → label display. El backend devuelve claves canónicas
// (tarjeta/transferencia/mercadopago), acá capitalizamos apropiadamente.
const METODO_LABEL = {
  tarjeta:       'Tarjeta',
  transferencia: 'Transferencia',
  mercadopago:   'MercadoPago',
};

// Delta trend chip (↗ 8.4%). Solo el KPI de MRR lo usa por ahora — cuando
// tengamos history mensual real, se puede aplicar a cobrado también.
function DeltaChip({ pct }) {
  if (pct == null || isNaN(pct)) return null;
  const positive = pct >= 0;
  return (
    <span
      className={'status ' + (positive ? 's-pos' : 's-neg')}
      style={{ fontSize: 12, fontWeight: 600 }}
      aria-label={positive ? `${pct}% mes a mes, subiendo` : `${Math.abs(pct)}% mes a mes, bajando`}
    >
      {positive ? '↗' : '↘'} {Math.abs(pct).toFixed(1)}%
      <span className="muted" style={{ marginLeft: 4, fontWeight: 400 }}>· mes</span>
    </span>
  );
}

export default function Facturacion() {
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('todas');

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
  const facturas = data?.facturas || [];

  const facturasFiltradas = useMemo(() => {
    if (tab === 'todas') return facturas;
    const target = tab === 'pagadas' ? 'pagada'
                 : tab === 'pendientes' ? 'pendiente'
                 : tab === 'fallidas' ? 'fallida'
                 : null;
    if (!target) return facturas;
    return facturas.filter((f) => f.estado === target);
  }, [facturas, tab]);

  // Reintentar fallidos — deshabilitado hasta que exista billing real.
  // Sin backend real, el botón no puede tener efecto verdadero, así que lo
  // mostramos con tooltip explicativo en vez de esconderlo (el mockup ya lo
  // tiene, ocultarlo sería inconsistente con lo que Lucas eligió).
  const canReintentar = false;

  return (
    <>
      <PageHead
        label="Facturación"
        title="Facturación y cobros"
        subtitle="Suscripciones, pagos y MRR"
        actions={
          <>
            <Btn
              icon="Refresh"
              onClick={() => {}}
              disabled={!canReintentar}
              title={canReintentar ? 'Reintentar cobros fallidos' : 'Próximamente — pendiente de integración con pasarela de pago'}
            >
              Reintentar fallidos
            </Btn>
            <Btn
              kind="primary"
              icon="Download"
              onClick={() => {}}
              disabled
              title="Próximamente — exportar historial de facturación en CSV"
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

      {/* KPI grid 4 columnas — usamos kpi-grid con grid-template inline
          porque no hay clase kpi-grid-4 en styles.css y no queremos tocar
          el global por una pantalla. Colapsa a 2 cols en mobile via
          media query implícita (minmax evita overflow). */}
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
            {!loading && kpis.mrr_delta_pct != null && <DeltaChip pct={kpis.mrr_delta_pct} />}
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Cobrado (mes)</div>
          <div className="kpi-value">
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 80, height: 22 }} />
            ) : (
              fmtMoney(kpis.cobrado_mes_usd ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className="muted">
              {loading ? '' : `${kpis.cobrado_count ?? 0} pago${kpis.cobrado_count === 1 ? '' : 's'}`}
            </span>
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Pendiente</div>
          <div className="kpi-value">
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 80, height: 22 }} />
            ) : (
              fmtMoney(kpis.pendiente_usd ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className="muted">
              {loading ? '' : `${kpis.pendiente_count ?? 0} factura${kpis.pendiente_count === 1 ? '' : 's'}`}
            </span>
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Fallidos</div>
          <div
            className="kpi-value"
            style={{ color: (kpis.fallidos_count ?? 0) > 0 ? 'var(--neg)' : undefined }}
          >
            {loading ? (
              <span className="skeleton" style={{ display: 'inline-block', width: 80, height: 22 }} />
            ) : (
              fmtMoney(kpis.fallidos_usd ?? 0)
            )}
          </div>
          <div className="kpi-trend">
            <span className="muted">
              {loading ? '' : (kpis.fallidos_count ?? 0) > 0
                ? `reintento en ${kpis.reintento_dias ?? 2} d`
                : 'sin fallidos'}
            </span>
          </div>
        </div>
      </div>

      {/* Tabla de facturas recientes */}
      <Card
        flush
        title="Facturas recientes"
        subtitle="Últimos cobros y facturas emitidas"
        style={{ marginTop: 'var(--gap)' }}
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'todas',     label: 'Todas' },
              { value: 'pagadas',   label: 'Pagadas' },
              { value: 'pendientes', label: 'Pendientes' },
              { value: 'fallidas',  label: 'Fallidas' },
            ]}
          />
        }
      >
        {loading && (
          <div className="empty-state">
            <div className="empty-title">Cargando facturas…</div>
          </div>
        )}

        {!loading && facturasFiltradas.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">
              {tab === 'todas' ? 'Sin facturas todavía.' : 'Sin facturas en este estado.'}
            </div>
            {tab === 'todas' && 'Se generan una por tenant activo cuando el sistema de billing esté conectado.'}
          </div>
        )}

        {!loading && facturasFiltradas.length > 0 && (
          <table className="tbl">
            <caption className="sr-only">
              Facturas recientes emitidas a los tenants de Tecny.
            </caption>
            <thead>
              <tr>
                <th scope="col">Factura</th>
                <th scope="col">Cliente</th>
                <th scope="col">Plan</th>
                <th scope="col" className="num">Monto</th>
                <th scope="col">Fecha</th>
                <th scope="col">Método</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {facturasFiltradas.map((f) => {
                const est = ESTADO_META[f.estado] || { tone: 'muted', label: f.estado };
                return (
                  <tr
                    key={f.id}
                    className="tbl-row-click"
                    onClick={() => navigate('/clientes/' + f.tenant_id)}
                    title={`Ver ficha de ${f.tenant_nombre}`}
                  >
                    <td className="mono">{f.numero}</td>
                    <td style={{ fontWeight: 600 }}>{f.tenant_nombre || '—'}</td>
                    <td>
                      <Badge tone={planTone(f.plan)}>{f.plan_label || f.plan}</Badge>
                    </td>
                    <td className="num mono" style={{ fontWeight: 600 }}>
                      {fmtMoney(f.monto_usd ?? 0)}
                    </td>
                    <td className="muted tiny">{fmtDate(f.fecha)}</td>
                    <td className="muted">{METODO_LABEL[f.metodo] || f.metodo}</td>
                    <td>
                      <span className={'status s-' + est.tone}>{est.label}</span>
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
