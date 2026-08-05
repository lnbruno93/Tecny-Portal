/**
 * UnidadesPorCategoriaChart (B1, task #309) — barras horizontales con Top
 * categorías (clase_id) ordenadas por unidades vendidas. Muestra el emoji
 * + nombre en el eje Y, el valor en el eje X.
 *
 * Consume `data.actual.ventas.por_categoria[]` del bundle `resumen-mensual`.
 */
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import ChartCard from './ChartCard';

export default function UnidadesPorCategoriaChart({ data, loading = false }) {
  const items = (data || []).slice(0, 8);  // Top 8 para no saturar el gráfico
  const chartData = items.map(r => ({
    nombre:   `${r.emoji || '📦'} ${r.nombre}`,
    Unidades: Number(r.unidades) || 0,
  }));
  // task #311: cuando no hay items evitamos mostrar "Top 0" (feo/confuso).
  // El ChartCard ya muestra el emptyLabel — el subtítulo se mantiene neutral.
  const subtitle = items.length > 0
    ? `Top ${items.length} (retail + B2B)`
    : 'Retail + B2B';
  return (
    <ChartCard
      title="Unidades vendidas por categoría"
      subtitle={subtitle}
      height="lg"
      loading={loading}
      empty={!loading && chartData.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 20, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border, #2a2f3a)" />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="nombre" tick={{ fontSize: 12 }} width={140} />
          <Tooltip contentStyle={{ background: '#1a1f2b', border: '1px solid #2a2f3a' }} />
          <Bar dataKey="Unidades" fill="#4a9eff" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
