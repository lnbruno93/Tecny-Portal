/**
 * FacturacionEgresosChart (A1, task #309) — barras dobles/triples de los
 * últimos N meses mostrando Facturación bruta vs Egresos vs Ganancia neta.
 *
 * Consume `/api/dashboard/serie-6-meses` — array de { mes, facturacion_usd,
 * egresos_usd, ganancia_neta_usd }. Si `ganancia_neta_usd` está redactado
 * (user sin cap `ventas.ver_ganancias`), muestra solo 2 barras (facturación
 * vs egresos) para no filtrar rentabilidad indirectamente.
 */
import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { dashboard as dashApi } from '../../lib/api';
import ChartCard from './ChartCard';

const MES_ABBR = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
function labelMes(iso) {
  // 'YYYY-MM' → 'Ago 26'
  const [y, m] = String(iso).split('-').map(Number);
  return `${MES_ABBR[m - 1]} ${String(y).slice(-2)}`;
}
function fmtUsd(v) {
  const n = Number(v) || 0;
  return `u$s${Math.round(n).toLocaleString('es-AR')}`;
}

export default function FacturacionEgresosChart({ hastaMes = null, meses = 6 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = { meses: String(meses) };
    if (hastaMes) params.hasta = hastaMes;
    dashApi.serie6Meses(params)
      .then(bundle => { if (alive) { setData(bundle.data || []); setLoading(false); } })
      .catch(() => { if (alive) { setData([]); setLoading(false); } });
    return () => { alive = false; };
  }, [hastaMes, meses]);

  const chartData = (data || []).map(d => ({
    mes: labelMes(d.mes),
    Facturación: Number(d.facturacion_usd) || 0,
    Egresos:     Number(d.egresos_usd) || 0,
    ...(d.ganancia_neta_usd != null ? { 'Ganancia neta': Number(d.ganancia_neta_usd) } : {}),
  }));
  const mostrarGanancia = chartData.length > 0 && 'Ganancia neta' in chartData[0];

  return (
    <ChartCard
      title="Facturación vs Egresos"
      subtitle={`Últimos ${meses} meses (USD)`}
      height="lg"
      loading={loading}
      empty={!loading && chartData.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #2a2f3a)" />
          <XAxis dataKey="mes" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v/1000)}k`} />
          <Tooltip formatter={(v) => fmtUsd(v)} contentStyle={{ background: '#1a1f2b', border: '1px solid #2a2f3a' }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Facturación" fill="#4a9eff" />
          <Bar dataKey="Egresos" fill="#f47272" />
          {mostrarGanancia && <Bar dataKey="Ganancia neta" fill="#4ade80" />}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
