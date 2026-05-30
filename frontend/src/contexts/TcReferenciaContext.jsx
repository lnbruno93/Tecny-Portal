// TcReferenciaContext — provee el TC de referencia configurado en Alertas.
//
// Se levanta una vez al montar la app (después del login). Si el usuario
// edita el TC desde Config → Alertas → Configurar TC, el provider re-fetch
// vía la función `reload` expuesta en el hook.
//
// El hook `useTcReferencia()` devuelve:
//   - tcRef: { valor, tolerancia_pct, alerta_por_debajo } | null si no se cargó.
//   - verificarTc(tcTipeado): null o { msg, tcRef, diferencia_pct }
//   - reload(): re-fetch del config.
//
// El TC se compara solo "por debajo" según la política inicial (#1).
// Si en el futuro se quiere alertar también por arriba, se agrega un flag.

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { alertas as alertasApi } from '../lib/api';
import { useAuth } from './AuthContext';

// Pure helper expuesto aparte para testeo en aislamiento (sin React/context).
// Devuelve null si el TC tipeado está dentro de tolerancia o si el config
// no está configurado/activado. Si retorna objeto, el componente lo muestra.
//
//   verificarTcContraRef({ valor:1400, tolerancia_pct:1, alerta_por_debajo:true }, 1380)
//   → { msg, tcRef, diferencia_pct: 1.43 }
//
//   verificarTcContraRef({ valor:1400, ... }, 1390) → null  (dentro de tolerancia)
//   verificarTcContraRef(null, 1000)                → null  (no config)
export function verificarTcContraRef(tcRef, tcTipeado) {
  if (!tcRef || !tcRef.alerta_por_debajo || !tcRef.valor) return null;
  const n = Number(tcTipeado);
  if (!n || n <= 0) return null;
  const minPermitido = tcRef.valor * (1 - tcRef.tolerancia_pct / 100);
  if (n >= minPermitido) return null;
  const diferenciaPct = ((tcRef.valor - n) / tcRef.valor) * 100;
  return {
    msg: `Chequear Tipo de Cambio. Posible error (TC ref: ${tcRef.valor}, diferencia ${diferenciaPct.toFixed(1)}%)`,
    tcRef,
    diferencia_pct: diferenciaPct,
  };
}

const TcReferenciaContext = createContext({
  tcRef: null,
  verificarTc: () => null,
  reload: () => {},
});

export function TcReferenciaProvider({ children }) {
  const { user } = useAuth();
  const [tcRef, setTcRef] = useState(null);

  const load = useCallback(async () => {
    if (!user) { setTcRef(null); return; }
    // Solo intentamos cargar si el user tiene permiso de financiera (donde
    // vive el endpoint). Si no, queda null — no rompe nada.
    const hasFinanciera = user.role === 'admin' || user.perms?.financiera === true;
    if (!hasFinanciera) { setTcRef(null); return; }
    try {
      const configs = await alertasApi.config();
      const cfg = configs.find(c => c.tipo === 'tc_referencia');
      if (cfg && cfg.activa) {
        setTcRef({
          valor:             Number(cfg.parametros?.valor) || 0,
          tolerancia_pct:    Number(cfg.parametros?.tolerancia_pct) || 1,
          alerta_por_debajo: cfg.parametros?.alerta_por_debajo !== false,
        });
      } else {
        setTcRef(null); // desactivado
      }
    } catch {
      setTcRef(null); // best-effort: si falla, no rompe la app
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const verificarTc = useCallback(
    (tcTipeado) => verificarTcContraRef(tcRef, tcTipeado),
    [tcRef]
  );

  return (
    <TcReferenciaContext.Provider value={{ tcRef, verificarTc, reload: load }}>
      {children}
    </TcReferenciaContext.Provider>
  );
}

export function useTcReferencia() {
  return useContext(TcReferenciaContext);
}
