/**
 * ChartCard — wrapper visual común para gráficos del Resumen (task #309).
 *
 * Estandariza: card + header con título + subtítulo opcional + slot para
 * badges (comparativo), body con altura fija + empty/loading state
 * consistente. Reusable por los 6 charts de Resumen y futuros gráficos.
 *
 * Prop `height` = 'sm' (200px) | 'md' (240px, default) | 'lg' (320px).
 * Sin inline styles — cumple guardrail CSP (decisión durable 69). Las
 * alturas están predefinidas como clases utility en styles.css.
 */
export default function ChartCard({
  title, subtitle, badge, height = 'md',
  loading = false, empty = false, emptyLabel = 'Sin datos en este período',
  children,
}) {
  const heightClass = height === 'sm' ? 'u-chart-h-sm'
    : height === 'lg' ? 'u-chart-h-lg'
    : 'u-chart-h-md';
  return (
    <div className="card">
      <div className="card-hd u-flex-between-center">
        <div>
          <h3 className="u-m-0-fs-16">{title}</h3>
          {subtitle && <div className="muted tiny u-mt-4">{subtitle}</div>}
        </div>
        {badge && <div>{badge}</div>}
      </div>
      <div className={`u-p-8 ${heightClass}`}>
        {loading && <div className="empty">Cargando…</div>}
        {!loading && empty && <div className="empty tiny">{emptyLabel}</div>}
        {!loading && !empty && children}
      </div>
    </div>
  );
}
