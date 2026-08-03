import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
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
  //
  // 2026-07-12 (auditoría TOTAL Externa P0-1): 4to arg opcional
  // `hcaptchaResponse`. En dev/local (backend HCAPTCHA_ENABLED!='true')
  // el widget bypassa silencioso. En prod, sin token válido → 400.
  const login = useCallback(async (username, password, code = undefined, hcaptchaResponse = undefined) => {
    const data = await authApi.login(username, password, code, hcaptchaResponse);
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

  // 2026-08-03 (task #228 Opción A): switch de tenant activo para users con
  // rows en >1 tenant_users (super-admins invitados, futuros partners Red B2B).
  // Backend re-emite JWT con tenant_id nuevo + recarga capabilities. Frontend
  // guarda el token nuevo y hace hard-reload para que TODAS las queries en
  // memoria (react-query cache, useEffect data, etc.) se re-fetchen desde cero
  // con el tenant nuevo. Sin reload, los datos stale del tenant anterior
  // seguirían visibles hasta refresh manual.
  //
  // Trade-off: reload rompe el estado de UI (formularios abiertos, scroll,
  // etc.). Aceptable porque el switch es una acción intencional del user
  // (equivalente a un logout+login mental). Alternativa "invalidar caches
  // uno por uno" quedaría para si escala a switching frecuente.
  const switchTenant = useCallback(async (tenantId) => {
    const data = await authApi.switchTenant(tenantId);
    saveToken(data.token);
    // Reload full — la forma más segura de garantizar que TODAS las queries
    // vuelen con el tenant nuevo (RLS reset). Cero riesgo de data leak.
    window.location.reload();
    return data;
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

  // Auditoría 2026-06-30 F-21: memoizar el value del provider. Sin useMemo,
  // cada render del provider creaba un objeto nuevo → todos los consumers
  // se re-renderean innecesariamente. login/logout/refreshUser ya están
  // estables vía useCallback con deps vacías; user/loading son los únicos
  // que cambian de verdad.
  const value = useMemo(
    () => ({ user, loading, login, logout, refreshUser, switchTenant }),
    [user, loading, login, logout, refreshUser, switchTenant]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
