// NuevaVentaFab — atajo flotante global para crear una venta desde
// cualquier sección del portal (task #281, pedido tenant 2026-08-01).
//
// Se monta en Shell.jsx junto al `<ChatWidget />` FAB. Position: fixed,
// arriba del chat bot para que ambos convivan sin taparse. El click no
// abre un modal in-place — navega a `/ventas?action=nueva` para que la
// URL sea copiable/compartible y el flow siga siendo el mismo del botón
// "Nueva venta" del header (misma ruta, mismo estado inicial, mismo
// draft auto-save si el usuario abandona).
//
// Gated por capability `ventas.trabajar` — mismo permiso que el módulo
// completo (backend/src/app.js:988 monta las rutas con esa cap). Users
// sin permiso no ven el FAB. Doble check en el server (RequirePermission
// del route + validate del handler) hace que el gating frontend sea UX,
// no security.

import { useNavigate, useLocation } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { userHasCap } from '../lib/userHasCap';
import Icons from './Icons';

export default function NuevaVentaFab() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Solo mostrar si el user puede trabajar Ventas.
  if (!userHasCap(user, 'ventas.trabajar')) return null;

  const handleClick = () => {
    // Si ya estamos en /ventas, mantenemos la URL actual y agregamos el
    // param. Sino navegamos a /ventas con el param. Ventas.jsx detecta
    // `action=nueva` y abre el modal + limpia el param del URL para no
    // repetir la acción al refrescar.
    const isVentas = location.pathname === '/ventas';
    const search = new URLSearchParams(isVentas ? location.search : '');
    search.set('action', 'nueva');
    // Timestamp para forzar el trigger si el user clickea el FAB dos
    // veces seguidas estando ya en /ventas (React Router no re-renderiza
    // si el location no cambió, y el modal podría haber sido cerrado).
    search.set('t', String(Date.now()));
    const url = `/ventas?${search.toString()}`;
    if (isVentas) {
      navigate(url, { replace: true });
    } else {
      navigate(url);
    }
  };

  return (
    <button
      type="button"
      className="venta-fab"
      title="Nueva venta (atajo)"
      aria-label="Nueva venta"
      onClick={handleClick}
      data-testid="fab-nueva-venta"
    >
      <Icons.Plus size={22} />
    </button>
  );
}
