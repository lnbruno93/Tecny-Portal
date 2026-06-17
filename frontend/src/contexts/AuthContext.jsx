import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { auth as authApi, saveToken, clearToken } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);        // null = loading, false = not authed, object = authed
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const token = localStorage.getItem('fin_token');
    if (!token) { setLoading(false); return; }

    authApi.me()
      .then(u => setUser(u))
      .catch(() => { clearToken(); })
      .finally(() => setLoading(false));

    // Listen for 401 events from api.js
    const onExpired = () => { setUser(null); };
    window.addEventListener('session-expired', onExpired);
    return () => window.removeEventListener('session-expired', onExpired);
  }, []);

  // Login flow soporta 2FA opcional:
  //   1. Sin code (primer intento): si el user tiene 2FA enabled, devuelve
  //      { twofa_required: true }. El form muestra input de código.
  //   2. Con code (segundo intento): completa el login.
  //
  // Devuelve { user } si OK, { twofa_required: true } si falta el código.
  // Lanza error en otros casos (password mala, lockout, etc.).
  const login = useCallback(async (username, password, code = undefined) => {
    const data = await authApi.login(username, password, code);
    if (data.twofa_required) return { twofa_required: true };
    saveToken(data.token);
    setUser(data.user);
    return { user: data.user };
  }, []);

  const logout = useCallback(() => {
    authApi.logout().catch(() => {}); // fire-and-forget
    clearToken();
    setUser(null);
  }, []);

  // TANDA 2.2: refreshUser — invocado por <VerifyEmail /> después de un
  // verify exitoso. Re-fetch GET /api/auth/me para que `user.email_verified`
  // pase de false a true en memoria y el banner desaparezca. Si el user no
  // estaba logueado (verificó en otro device), me() falla con NO_AUTH y
  // lo ignoramos — el redirect al /login lo maneja el llamador.
  const refreshUser = useCallback(async () => {
    try {
      const u = await authApi.me();
      setUser(u);
      return u;
    } catch (_) {
      return null;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
