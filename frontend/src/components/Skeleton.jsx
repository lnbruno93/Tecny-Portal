// Skeleton — placeholders animados mientras carga contenido (U-12 auditoría
// 2026-06-10). Reemplaza el "Cargando..." plano por una silueta del contenido
// final, lo que reduce el "perceived loading time" (Nielsen ~20% en estudios
// internos).
//
// Variantes:
//   <Skeleton width="100%" height={40} />     primitivo (caja con shimmer)
//   <SkeletonRow columns={6} />               fila de tabla con N celdas
//   <SkeletonCard />                          card de KPI con título + valor
//
// Animación: keyframes CSS `skeleton-shimmer` definidos en styles.css.
// Sin libs externas.

export function Skeleton({ width = '100%', height = 16, style }) {
  return (
    <span
      className="skeleton"
      // role="presentation" para que lectores de pantalla no anuncien
      // cada pulso individual — el contenedor padre debería tener
      // aria-busy="true" si es relevante.
      role="presentation"
      aria-hidden="true"
      style={{ width, height, ...style }}
    />
  );
}

// Fila de tabla skeleton — N celdas iguales, util para listas mientras carga.
// Usa `colSpan` cuando se pone dentro de un <tbody> sin estructura: igual,
// dejamos `td` por columna para que el layout encaje con el header existente.
export function SkeletonRow({ columns = 4, height = 18 }) {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i}><Skeleton height={height} /></td>
      ))}
    </tr>
  );
}

// Card de KPI con un title chiquito y un valor grande, replicando el
// shape de las KPI cards reales del dashboard.
export function SkeletonCard({ title = true }) {
  return (
    <div className="kpi-card" aria-hidden="true">
      {title && <Skeleton width="40%" height={12} className="u-mb-8" />}
      <Skeleton width="70%" height={28} />
    </div>
  );
}

export default Skeleton;
