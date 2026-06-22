// Column chart "barato" — sin librería extra (decisión explícita: no
// agregamos chart libs todavía). Pensado para series cortas
// (~90 puntos) con dos magnitudes apiladas: signups (positivo / accent)
// arriba de suspensions (negativo / neg). El stacked vertical visualiza
// "movimiento neto" del día sin recurrir a líneas que requieren SVG.
//
// Si en el futuro necesitamos charts más complejos (líneas, áreas,
// múltiples series), evaluar recharts o visx — pero para esto alcanza.
//
// Props:
//   - series: [{ date, signups, suspensions }]
//   - height (opcional): alto en px del área de barras (default 140)
//   - xLabels (opcional): array de strings a mostrar bajo el chart;
//     si no se pasa, derivamos meses únicos del primer/último de cada
//     mes presente en la serie.

import { useMemo } from 'react';

// Mes corto en español. No usamos Intl directo porque para los 90 días
// (cortos) queremos siempre "Ene/Feb/..." sin acentos raros.
const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function deriveMonthLabels(series) {
  // Tomamos un label por cambio de mes. Resultado: ~3-4 labels para 90 días.
  const seen = new Set();
  const out = [];
  for (const item of series || []) {
    if (!item?.date) continue;
    const d = new Date(item.date);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(MESES_CORTOS[d.getMonth()] || '');
    }
  }
  return out;
}

export default function ColChart({ series = [], height = 140, xLabels }) {
  // El max combinado (signups+suspensions) fija el techo del eje Y.
  // Default a 1 para evitar división por cero — si todo es 0 las barras
  // quedan a altura mínima y el chart se ve vacío (que es lo esperado).
  const max = useMemo(() => {
    let m = 0;
    for (const it of series) {
      const total = (it?.signups || 0) + (it?.suspensions || 0);
      if (total > m) m = total;
    }
    return Math.max(1, m);
  }, [series]);

  // useMemo SIEMPRE — los hooks no pueden ser condicionales (Rules of
  // Hooks). Si el caller pasa xLabels explícito, usamos ese; sino el
  // derivado. La memoización es barata.
  const derivedLabels = useMemo(() => deriveMonthLabels(series), [series]);
  const labels = xLabels || derivedLabels;

  // Empty state defensivo — si el endpoint devuelve {history: []}, no
  // queremos renderizar un chart vacío sin contexto. Sin data, mostramos
  // un placeholder muted en lugar del esqueleto.
  if (!series.length) {
    return (
      <div className="muted tiny" style={{ padding: '20px 0', textAlign: 'center' }}>
        Sin datos en el período.
      </div>
    );
  }

  return (
    <>
      <div className="colchart" style={{ height }}>
        {series.map((it, i) => {
          const s = it?.signups || 0;
          const x = it?.suspensions || 0;
          // % del techo. Si ambos son 0, no renderizamos los <i> — el
          // hueco de la barra deja un slot vacío que mantiene la grilla.
          const sH = (s / max) * 100;
          const xH = (x / max) * 100;
          const title = `${it?.date || ''} · ${s} altas · ${x} bajas`;
          return (
            <div key={it?.date || i} className="colbar" title={title}>
              {/* Suspensions arriba (rojas) — visualmente "comen" el día */}
              {x > 0 && <i className="colbar-neg" style={{ height: `${xH}%` }} />}
              {/* Signups abajo (accent) — base del día */}
              {s > 0 && <i style={{ height: `${sH}%` }} />}
            </div>
          );
        })}
      </div>
      {labels.length > 0 && (
        <div className="colchart-x">
          {labels.map((m, i) => <span key={i}>{m}</span>)}
        </div>
      )}
    </>
  );
}
