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
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110 }}>
      {Array.from({ length: 24 }, (_, h) => {
        const n = byH[h] || 0;
        const pct = Math.round((n / max) * 100);
        return (
          <div
            key={h}
            title={`${h}:00 — ${n} venta(s)`}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <div style={{
              width: '62%',
              height: Math.max(pct, 3) + '%',
              background: n ? 'var(--pos)' : 'var(--border)',
              borderRadius: '2px 2px 0 0',
            }} />
            <div className="muted" style={{ fontSize: 8 }}>
              {h % 4 === 0 ? String(h).padStart(2, '0') : ' '}
            </div>
          </div>
        );
      })}
    </div>
  );
}
