/**
 * TenantSwitcher — dropdown para cambiar de tenant activo (task #228, Opción A).
 *
 * Rendering condicional: solo se muestra si el user tiene rows en >1
 * `tenant_users`. Para users normales (1 solo tenant) queda null → invisible.
 *
 * Flow:
 *   1. Al mount, fetch GET /api/auth/tenants → guarda lista + tenant activo.
 *   2. Si len > 1, renderiza un `<select>` con las opciones (activo pre-selected).
 *   3. onChange → useAuth().switchTenant(id) → backend re-emite JWT + AuthContext
 *      hace `window.location.reload()` para refrescar TODA la UI desde cero
 *      (evita data leaks del tenant anterior en react-query cache, memoized
 *      useEffect data, etc.).
 *
 * Se renderiza dentro del `user-pill` en Shell.jsx. El WARN log
 * `resolveUserTenant_multi_tenant_ambiguity` seguirá disparándose para users
 * con >1 tenant, pero ahora tienen forma de cambiar sin logout+login.
 */
import { useEffect, useState } from 'react';
import { auth as authApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';

export default function TenantSwitcher() {
  const { switchTenant } = useAuth();
  const { toast } = useToast();
  const [tenants, setTenants] = useState(null); // null = loading, [] = single-tenant, [...] = multi
  const [activeId, setActiveId] = useState(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi.getTenants()
      .then(data => {
        if (cancelled) return;
        setTenants(Array.isArray(data.tenants) ? data.tenants : []);
        setActiveId(data.active_tenant_id ?? null);
      })
      .catch(() => {
        // Silent fail — si el endpoint rebota (sin tenants o network flake),
        // el switcher simplemente no aparece. No es P0 mostrar error acá.
        if (!cancelled) setTenants([]);
      });
    return () => { cancelled = true; };
  }, []);

  // Solo mostrar si el user pertenece a >1 tenant.
  if (!tenants || tenants.length < 2) return null;

  async function handleChange(e) {
    const targetId = Number(e.target.value);
    if (!targetId || targetId === activeId || switching) return;
    setSwitching(true);
    try {
      await switchTenant(targetId);
      // switchTenant hace window.location.reload() — no llegamos acá.
    } catch (err) {
      const msg = friendlyError(err, 'No se pudo cambiar de organización');
      toast.error(msg);
      setSwitching(false);
    }
  }

  return (
    <select
      className="input u-fs-12 u-flex-shrink-0"
      value={activeId ?? ''}
      onChange={handleChange}
      disabled={switching}
      aria-label="Cambiar organización activa"
      title="Cambiar organización activa"
    >
      {tenants.map(t => (
        <option key={t.id} value={t.id}>
          {t.nombre || `Tenant #${t.id}`}
        </option>
      ))}
    </select>
  );
}
