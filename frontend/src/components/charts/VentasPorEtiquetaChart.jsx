/**
 * VentasPorEtiquetaChart (B2, task #309) — dona con distribución de ventas
 * por etiqueta. Incluye 'Sin etiqueta' (retail sin tag) y 'B2B' como slice
 * adicional para lectura unificada. Colores vienen de la BD (etiqueta.color)
 * cuando existen, fallback a paleta si no.
 *
 * Consume `data.actual.ventas.por_etiqueta[]` del bundle `resumen-mensual`.
 */
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import ChartCard from './ChartCard';

// Paleta fallback (accesible dark theme) para etiquetas sin color en DB.
const PALETTE = ['#4a9eff', '#4ade80', '#f47272', '#facc15', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6'];

function fmtUsd(v) {
  const n = Number(v) || 0;
  return `u$s${Math.round(n).toLocaleString('es-AR')}`;
}

export default function VentasPorEtiquetaChart({ data, loading = false }) {
  const items = (data || []).filter(r => Number(r.usd) > 0);
  const chartData = items.map((r, i) => ({
    name:  r.etiqueta,
    value: Number(r.usd),
    color: r.color || PALETTE[i % PALETTE.length],
  }));
  const total = chartData.reduce((a, b) => a + b.value, 0);
  return (
    <ChartCard
      title="Ventas por etiqueta"
      subtitle="Distribución en USD (retail por etiqueta + B2B)"
      height="lg"
      loading={loading}
      empty={!loading && chartData.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            cx="50%" cy="50%"
            innerRadius="45%"
            outerRadius="75%"
            paddingAngle={2}
            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            labelLine={false}
          >
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={(v) => [`${fmtUsd(v)} (${((v/total)*100).toFixed(1)}%)`, 'USD']}
            contentStyle={{ background: '#1a1f2b', border: '1px solid #2a2f3a' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
