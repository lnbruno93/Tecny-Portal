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

  const login = useCallback(async (username, password) => {
    const data = await authApi.login(username, password);
    saveToken(data.token);
    setUser(data.user);
    return data.user;
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
