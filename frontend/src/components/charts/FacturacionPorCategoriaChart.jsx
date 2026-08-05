/**
 * FacturacionPorCategoriaChart (B3, task #309) — barras horizontales con
 * facturación (USD) por categoría. Complementa B1 (unidades): una categoría
 * puede vender muchas unidades baratas o pocas caras — este chart lo aclara.
 *
 * Consume `data.actual.ventas.por_categoria[]` (mismo array que B1, ordenado
 * distinto localmente).
 */
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import ChartCard from './ChartCard';

function fmtUsd(v) {
  const n = Number(v) || 0;
  return `u$s${Math.round(n).toLocaleString('es-AR')}`;
}

export default function FacturacionPorCategoriaChart({ data, loading = false }) {
  // Re-ordenar por USD desc + Top 8 (data del backend viene ordenado por unidades).
  const items = [...(data || [])]
    .filter(r => Number(r.usd) > 0)
    .sort((a, b) => Number(b.usd) - Number(a.usd))
    .slice(0, 8);
  const chartData = items.map(r => ({
    nombre: `${r.emoji || '📦'} ${r.nombre}`,
    USD:    Number(r.usd) || 0,
  }));
  // task #311: idem UnidadesPorCategoriaChart — evita "Top 0" cuando vacío.
  const subtitle = items.length > 0
    ? `Top ${items.length} en USD (retail + B2B)`
    : 'USD (retail + B2B)';
  return (
    <ChartCard
      title="Facturación por categoría"
      subtitle={subtitle}
      height="lg"
      loading={loading}
      empty={!loading && chartData.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 20, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border, #2a2f3a)" />
          <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v/1000)}k`} />
          <YAxis type="category" dataKey="nombre" tick={{ fontSize: 12 }} width={140} />
          <Tooltip formatter={(v) => fmtUsd(v)} contentStyle={{ background: '#1a1f2b', border: '1px solid #2a2f3a' }} />
          <Bar dataKey="USD" fill="#4ade80" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
