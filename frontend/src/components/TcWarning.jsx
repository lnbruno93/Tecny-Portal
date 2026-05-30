// TcWarning — banner inline debajo de un input de TC que avisa si el valor
// tipeado está fuera de rango respecto al TC de referencia configurado
// en Alertas → Configurar TC.
//
// No bloquea el guardado (solo es un hint visual). Si la config está
// desactivada, el componente no muestra nada.
//
// Debounce: el warning no aparece instantáneamente al tipear cada dígito.
// Esperamos 400ms sin cambios para evitar el flicker mientras el usuario
// está escribiendo "1400" (pasa por 1, 14, 140, 1400 y solo el último
// es el valor real). El feedback inmediato a cada tecleo era irritante.
//
// Uso:
//   <input type="number" value={tc} onChange={...} />
//   <TcWarning tc={tc} />

import { useTcReferencia } from '../contexts/TcReferenciaContext';
import { useDebouncedValue } from '../lib/useDebouncedValue';

export default function TcWarning({ tc, style }) {
  const { verificarTc } = useTcReferencia();
  // Debounce el valor: ignoramos cambios <400ms entre tecleos. Para inputs
  // type=number, el browser pasa el value crudo (string) o '' al limpiar.
  const debounced = useDebouncedValue(tc, 400);
  const warning = verificarTc(debounced);
  if (!warning) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        fontSize: 11,
        color: 'var(--warn, #d97706)',
        background: 'rgba(234, 179, 8, 0.08)',
        border: '1px solid rgba(234, 179, 8, 0.3)',
        borderRadius: 4,
        padding: '4px 8px',
        marginTop: 4,
        lineHeight: 1.3,
        ...style,
      }}
      title="Configurable en Config → Alertas → Configurar TC"
    >
      ⚠ {warning.msg}
    </div>
  );
}
