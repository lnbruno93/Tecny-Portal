/**
 * VentasPorDiaChart (C1, task #309) — barras verticales con cantidad de
 * ventas por día del mes. Inspirado en el screenshot de EstadísticasNube
 * que Lucas envió como referencia (2026-08-05).
 *
 * Consume `data.actual.ventas.por_dia[]` — array denso con TODOS los días
 * del período (incluyendo los que tuvieron 0 ventas, para que el gráfico
 * mantenga la escala X consistente). El backend genera el array con
 * `generate_series` en SQL.
 */
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import ChartCard from './ChartCard';

// 'YYYY-MM-DD' → 'DD' (día del mes solo, para eje X compacto)
function labelDia(iso) {
  return String(iso).slice(8, 10);
}

export default function VentasPorDiaChart({ data, loading = false }) {
  const chartData = (data || []).map(d => ({
    dia:    labelDia(d.dia),
    Ventas: Number(d.n) || 0,
  }));
  return (
    <ChartCard
      title="Ventas por día"
      subtitle="Cantidad de ventas (retail + B2B) por día del período"
      height="lg"
      loading={loading}
      empty={!loading && chartData.every(d => d.Ventas === 0)}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #2a2f3a)" />
          <XAxis dataKey="dia" tick={{ fontSize: 10 }} interval={0} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip contentStyle={{ background: '#1a1f2b', border: '1px solid #2a2f3a' }} />
          <Bar dataKey="Ventas" fill="#4a9eff" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
