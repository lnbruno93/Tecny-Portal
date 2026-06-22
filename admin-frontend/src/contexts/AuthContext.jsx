import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { adminApi, saveToken, clearToken, getToken } from '../lib/api.js';

const AuthContext = createContext(null);

// Storage key separada del portal — un mismo browser puede tener sesión
// activa en admin.tecnyapp.com y tecnyapp.com sin pisarse.
const USER_KEY = 'admin_user';

function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // S-8 fix (audit 2026-06-22): validar shape. localStorage corrupto
    // o manipulado puede tener JSON válido pero no-objeto: `[1,2,3]`,
    // `42`, `"string"`, `null`. Si dejamos pasar eso, `user.is_super_admin`
    // = undefined → isAuthenticated=false (OK), pero los spreads
    // `{ ...(prev || {}), ...data }` con prev=[1,2,3] producen objetos
    // raros. Mejor sanitizar acá.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveUser(u) {
  // S-8 fix (audit 2026-06-22): localStorage.setItem puede tirar
  // `QuotaExceededError` en Safari iOS modo privado (quota = 0). Sin el
  // try/catch, el login completo crashea con excepción no manejada.
  // Failure mode: el user no se persiste cross-reload (acepta-le),
  // pero la sesión en memoria sigue funcionando.
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[admin] localStorage write failed:', err?.message);
  }
}

export function AuthProvider({ children }) {
  // user puede ser:
  //   - null mientras `loading` (todavía no validamos el token)
  //   - null si no hay sesión
  //   - { id, username, email, is_super_admin, ... } si autenticado
  const [user, setUser] = useState(() => loadUser());
  const [token, setToken] = useState(() => getToken());
  const [loading, setLoading] = useState(true);

  // Revalidate session on mount — si hay token cacheado, pegarle a /me
  // para confirmar que el flag is_super_admin sigue válido server-side.
  // Si el token expiró o el flag se revocó, el wrapper api() ya dispara
  // 'admin-session-expired' y nos clavamos en null.
  useEffect(() => {
    // BLOCKER S-1 fix (audit 2026-06-22): registrar listener ANTES del
    // fetch a /me. Si el token cacheado está expirado, el wrapper api()
    // dispara `admin-session-expired` DURANTE la resolución de la promise
    // — si el addEventListener estuviera DESPUÉS del .then/.catch, el
    // listener no existiría cuando el evento se emita y se perdería.
    // Resultado: user/token quedan stale hasta el siguiente refresh.
    // Race-y especialmente en React 19 + StrictMode (doble mount en dev).
    const onExpired = () => {
      saveUser(null);
      setUser(null);
      setToken(null);
    };
    window.addEventListener('admin-session-expired', onExpired);

    const cachedToken = getToken();
    if (!cachedToken) {
      setLoading(false);
      // Cleanup vuelve al final del effect.
    } else {
      adminApi.me()
        .then((data) => {
          if (!data?.is_super_admin) {
            // Token válido pero el user perdió el flag de super-admin → logout.
            clearToken();
            saveUser(null);
            setUser(null);
            setToken(null);
            return;
          }
          // Mergeamos la info de /me con la cacheada de login. /me trae
          // { is_super_admin, user_id, username } — el resto (email) ya
          // está en cache.
          setUser((prev) => {
            const merged = { ...(prev || {}), ...data, id: data.user_id };
            saveUser(merged);
            return merged;
          });
        })
        .catch((err) => {
          // 401 ya disparó `admin-session-expired` desde el wrapper api(),
          // el onExpired listener (ya registrado arriba) lo procesa. Otros
          // errores (red caída, 500) los ignoramos — el user retry-ará al
          // hacer la próxima acción. Logueamos para diagnóstico.
          if (err?.status !== 401) {
            // eslint-disable-next-line no-console
            console.warn('[admin] /me revalidation failed:', err?.message);
          }
        })
        .finally(() => setLoading(false));
    }

    return () => window.removeEventListener('admin-session-expired', onExpired);
  }, []);

  const login = useCallback((newToken, newUser) => {
    saveToken(newToken);
    saveUser(newUser);
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    saveUser(null);
    setUser(null);
    setToken(null);
  }, []);

  const value = {
    user,
    token,
    loading,
    login,
    logout,
    isAuthenticated: Boolean(token && user?.is_super_admin === true),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
