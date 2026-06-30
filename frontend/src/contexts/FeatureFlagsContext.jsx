// FeatureFlagsContext — provee el estado de los feature flags al árbol React.
//
// Diseño minimalista (M-08 GRAN auditoría 2026-06-10):
//   · Al mount (y on user change), fetch a GET /api/feature-flags → guarda el
//     map { name: bool } en state.
//   · Hook `useFeatureFlag(name)` → bool (false por default si el flag no
//     existe o todavía está cargando). El default-false es deliberado: hacer
//     que un flag esté apagado SIEMPRE es el comportamiento "seguro" (si la
//     feature aún no salió, no exponerla).
//   · Hook `useFeatureFlags()` → { flags, loading, error } para casos que
//     necesitan más contexto (admin panel futuro, debug overlays).
//   · Fail-safe: si /api/feature-flags rompe (red, 5xx, JSON malformado),
//     logueamos via silentReport y `flags` queda en {}. Todos los flags
//     devuelven false. Bajo NINGUNA circunstancia un fallo de la API debe
//     romper el árbol — el flag system es metadata, no datos del negocio.
//
// Re-fetch en user change: el endpoint requiere sesión, así que cuando el
// user se loguea/desloguea, los flags se re-piden (sin auth no hay flags
// que mostrar; con auth queremos los flags al toque sin esperar refresh).

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { featureFlags as featureFlagsApi } from '../lib/api';
import { silentReport } from '../lib/reportError';
import { useAuth } from './AuthContext';

const FeatureFlagsContext = createContext({
  flags: {},
  loading: false,
  error: null,
  reload: () => {},
});

export function FeatureFlagsProvider({ children }) {
  const { user } = useAuth();
  const [flags, setFlags] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    // Sin sesión no hay nada que cargar (el endpoint requiere auth y
    // devolvería 401). Limpiamos por si veníamos con flags de una sesión
    // previa.
    if (!user) { setFlags({}); setLoading(false); setError(null); return; }
    setLoading(true);
    try {
      const data = await featureFlagsApi.list();
      // El endpoint devuelve { flags: { name: bool } }. Si por algún motivo
      // el shape llega raro, `flags || {}` evita que un undefined rompa
      // el render.
      setFlags(data?.flags || {});
      setError(null);
    } catch (err) {
      // Fail-safe: si la API rompe, dejamos flags vacíos (todos default
      // false). Logueamos a Sentry via silentReport para enterarnos sin
      // mostrar un toast — el usuario no debería ver "falló feature_flags"
      // porque desde su perspectiva no pasó nada (la feature simplemente
      // está apagada).
      silentReport(err, { screen: 'FeatureFlagsContext', action: 'list' });
      setFlags({});
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Auditoría 2026-06-30 F-23: memoizar value para evitar re-render en cascada
  // de todos los consumers de useFeatureFlag/useFeatureFlags en cada render
  // del provider.
  const value = useMemo(
    () => ({ flags, loading, error, reload: load }),
    [flags, loading, error, load]
  );

  return (
    <FeatureFlagsContext.Provider value={value}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

/**
 * Hook puntual: ¿está activo el flag X?
 * Default: false (si no hay flag o todavía cargando o la API rompió).
 *
 *   const dark = useFeatureFlag('dark_mode_v2');
 *   if (dark) { ... }
 */
export function useFeatureFlag(name) {
  const ctx = useContext(FeatureFlagsContext);
  // `=== true` por seguridad: si por bug llega un valor truthy no-booleano
  // (string "false", número, etc.), forzamos a false. El backend devuelve
  // bool puro pero defensa en profundidad no cuesta.
  return ctx.flags[name] === true;
}

/**
 * Hook completo: devuelve el objeto entero + loading + error + reload.
 * Útil para admin UI futura o componentes que necesitan reaccionar a más
 * de un flag a la vez sin generar N subscripciones.
 */
export function useFeatureFlags() {
  return useContext(FeatureFlagsContext);
}
