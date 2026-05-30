// TcWarning — banner inline debajo de un input de TC que avisa si el valor
// tipeado está fuera de rango respecto al TC de referencia configurado
// en Alertas → Configurar TC.
//
// No bloquea el guardado (solo es un hint visual). Si la config está
// desactivada, el componente no muestra nada.
//
// Uso:
//   <input type="number" value={tc} onChange={...} />
//   <TcWarning tc={tc} />

import { useTcReferencia } from '../contexts/TcReferenciaContext';

export default function TcWarning({ tc, style }) {
  const { verificarTc } = useTcReferencia();
  const warning = verificarTc(tc);
  if (!warning) return null;
  return (
    <div
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
