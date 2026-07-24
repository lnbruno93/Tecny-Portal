// HourChart — barras verticales de cantidad de ventas por hora (0-23).
// Sin dependencias externas: usa solo flexbox + divs.
//
// Datos esperados: array de { hora: number, n: number }. Las horas sin
// datos se renderizan como barras vacías (borde gris). Las que tienen
// al menos 1 venta se pintan con `var(--pos)`.
//
// Eje X muestra solo las horas múltiplo de 4 (00, 04, 08, 12, 16, 20)
// para no saturar a la vista; las otras tienen un espacio en blanco.
export default function HourChart({ data }) {
  const byH = {};
  (data || []).forEach(h => { byH[h.hora] = h.n; });
  const max = Math.max(1, ...Object.values(byH));
  return (
    <div className="u-hourchart">
      {Array.from({ length: 24 }, (_, h) => {
        const n = byH[h] || 0;
        const pct = Math.max(Math.round((n / max) * 100), 3);
        return (
          <div
            key={h}
            title={`${h}:00 — ${n} venta(s)`}
            className="u-hourchart-col"
          >
            {/* Bar height es data-driven (data-attr no ayuda, height varía continuo).
                CSS controla width/border-radius/color (via .empty modifier). El
                width/pct queda como único residual — necesario para el visual. */}
            <div
              className={'u-hourchart-bar' + (n ? '' : ' u-hourchart-bar-empty')}
              style={{ height: pct + '%' }}
            />
            <div className="muted u-hourchart-tick">
              {h % 4 === 0 ? String(h).padStart(2, '0') : ' '}
            </div>
          </div>
        );
      })}
    </div>
  );
}
