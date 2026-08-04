/**
 * TenantSwitcher — dropdown para cambiar de tenant activo (task #228, Opción A).
 *
 * Rendering condicional: solo se muestra si el user tiene rows en >1
 * `tenant_users`. Para users normales (1 solo tenant) queda null → invisible.
 *
 * UI (2026-08-04, iteración B post feedback Lucas):
 *   Botón outline compacto (icono edificio + nombre truncado + chevron ▾).
 *   Click abre popover flotante con lista de tenants. El activo tiene
 *   check verde ✓; los otros son clickables → dispara switch. Reemplaza al
 *   `<select>` nativo del prototipo A (que se veía sin borde/corte en el
 *   topbar oscuro y no coincidía con el estilo de los icon-btn vecinos).
 *
 * Flow:
 *   1. Al mount, fetch GET /api/auth/tenants → guarda lista + tenant activo.
 *   2. Si len > 1, renderiza el botón outline con el nombre del tenant activo.
 *   3. Click en botón → toggle popover. Click en otro tenant → switchTenant
 *      → hard-reload (garantía cero data leak del anterior).
 *   4. Escape o click-outside → cierra popover sin efecto.
 *
 * Se renderiza dentro del `.topbar` en Shell.jsx (post PR #1006). El WARN log
 * `resolveUserTenant_multi_tenant_ambiguity` seguirá disparándose para users
 * con >1 tenant, pero ahora tienen forma UX de cambiar sin logout+login.
 */
import { useEffect, useRef, useState } from 'react';
import { auth as authApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';
import { Icons } from './Icons';

// Trunca nombres largos de tenant al mostrar en el botón (los muy largos
// desbordan el topbar en resoluciones intermedias). 20 chars cabe cómodo en
// desktop >= 1024px sin desalinear los otros elementos del topbar.
const MAX_LABEL_CHARS = 20;
function truncate(s) {
  if (!s) return '—';
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS - 1) + '…' : s;
}

export default function TenantSwitcher() {
  const { switchTenant } = useAuth();
  const { toast } = useToast();
  const [tenants, setTenants] = useState(null); // null = loading, [] = single-tenant, [...] = multi
  const [activeId, setActiveId] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

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

  // Click outside + Escape para cerrar el popover.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Solo mostrar si el user pertenece a >1 tenant.
  if (!tenants || tenants.length < 2) return null;

  const active = tenants.find(t => t.id === activeId) || tenants[0];

  async function handleSelect(targetId) {
    if (!targetId || targetId === activeId || switching) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    setOpen(false);
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
    <div ref={wrapperRef} className="tenant-switcher-wrap u-position-relative u-flex-shrink-0">
      <button
        type="button"
        className="btn-tenant-switcher"
        onClick={() => setOpen(v => !v)}
        disabled={switching}
        aria-label={`Organización activa: ${active.nombre || 'Tenant #' + active.id}. Click para cambiar.`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active.nombre || `Tenant #${active.id}`}
      >
        <Icons.Building size={14} />
        <span className="tenant-switcher-label">{truncate(active.nombre)}</span>
        <Icons.ChevronDown size={12} />
      </button>

      {open && (
        <ul className="tenant-switcher-menu" role="listbox" aria-label="Organizaciones disponibles">
          {tenants.map(t => {
            const isActive = t.id === activeId;
            return (
              <li key={t.id} role="option" aria-selected={isActive}>
                <button
                  type="button"
                  className={`tenant-switcher-item${isActive ? ' is-active' : ''}`}
                  onClick={() => handleSelect(t.id)}
                  disabled={switching}
                >
                  <span className="tenant-switcher-item-name">
                    {t.nombre || `Tenant #${t.id}`}
                  </span>
                  {t.rol && <span className="tenant-switcher-item-rol">{t.rol}</span>}
                  {isActive && (
                    <span className="tenant-switcher-item-check" aria-label="Activo">
                      <Icons.Check size={14} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
