// Multi-país F3 (#469): hook centralizado para que cualquier pantalla con un
// dropdown de moneda lea el set permitido + la moneda local del tenant.
//
// Por qué un hook y no leer user.tenant.pais directo en cada screen:
//   1. Resolución del fallback en un solo lugar (AR si no hay tenant cargado).
//   2. Memoizado implícito por useAuth (cambios de user → re-render).
//   3. Documentación contextual: el call site lee `monedas` y sabe que es
//      "lo que este tenant puede operar" sin importar el helper crudo.
//
// Convivimos con el `lib/` flat del repo — no creamos `hooks/` dedicado para
// no diverger del layout existente (mismo patrón que useDebouncedValue,
// useLoadingAction, useModal). Ver lib/ para precedentes.

import { useAuth } from '../contexts/AuthContext';
import { getMonedasParaPais, getMonedaLocalParaPais, getPaisLabel } from './monedasPais';

export function useMonedasTenant() {
  // Safe destructure: useAuth() puede devolver null en tests que renderean
  // un screen sin AuthProvider (mismo guard que Inventario.jsx, Capital,
  // etc.). En prod siempre hay un AuthProvider arriba.
  const { user } = useAuth() || {};
  // user puede ser:
  //   · null     → loading (mount inicial)
  //   · object   → autenticado; user.tenant puede faltar si /me falló
  //                (fail-open: ExpiredBanner usa el mismo guard).
  // En cualquier caso devolvemos AR como fallback seguro.
  const pais = user?.tenant?.pais || 'AR';
  return {
    pais,
    monedas: getMonedasParaPais(pais),
    monedaLocal: getMonedaLocalParaPais(pais),
    paisLabel: getPaisLabel(pais),
  };
}
