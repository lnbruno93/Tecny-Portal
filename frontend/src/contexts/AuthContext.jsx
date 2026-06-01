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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
