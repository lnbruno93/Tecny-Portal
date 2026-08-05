/**
 * MargenNetoCard (A2, task #309) — KPI de margen neto % del período.
 *
 * `margen_neto_pct` viene calculado por el backend en el mismo bundle
 * `/api/dashboard/resumen-mensual` para asegurar single source of truth
 * (ganancia − egresos) / facturación. Frontend solo formatea + compara.
 */
import { fmtSignedParts } from '../../lib/format';

function fmtPct(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

export default function MargenNetoCard({ margenActual, margenComparado }) {
  if (margenActual == null) return null;
  const showDelta = margenComparado != null;
  let deltaBadge = null;
  if (showDelta) {
    const diff = Number(margenActual) - Number(margenComparado);
    const { sign, magnitude, cls } = fmtSignedParts(diff);
    deltaBadge = (
      <span className={`badge tiny ${cls}`}>
        {sign}{magnitude.toFixed ? magnitude.toFixed(1) : magnitude}pp vs mes ant.
      </span>
    );
  }
  return (
    <div className="card card-tight">
      <div className="card-hd u-flex-between-center">
        <div>
          <h3 className="u-m-0-fs-16">Margen neto</h3>
          <div className="muted tiny u-mt-4">Ganancia bruta − egresos, sobre facturación</div>
        </div>
        {deltaBadge}
      </div>
      <div className="u-p-8">
        <div className="u-fs-32-mono u-fw-700">{fmtPct(margenActual)}</div>
      </div>
    </div>
  );
}
