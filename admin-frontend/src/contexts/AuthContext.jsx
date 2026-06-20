import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { adminApi, saveToken, clearToken, getToken } from '../lib/api.js';

const AuthContext = createContext(null);

// Storage key separada del portal — un mismo browser puede tener sesión
// activa en admin.tecnyapp.com y tecnyapp.com sin pisarse.
const USER_KEY = 'admin_user';

function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveUser(u) {
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
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
    const cachedToken = getToken();
    if (!cachedToken) {
      setLoading(false);
      return;
    }
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
      .catch(() => {
        // 401 ya limpió el token; otros errores los ignoramos en silencio
        // (puede ser red caída — el user retry-ará al hacer la próxima acción).
      })
      .finally(() => setLoading(false));

    const onExpired = () => {
      saveUser(null);
      setUser(null);
      setToken(null);
    };
    window.addEventListener('admin-session-expired', onExpired);
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
