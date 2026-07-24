/**
 * Pantalla 404 — fallback para URLs sin match en el routing.
 *
 * Antes la app no tenía `path="*"` → una URL errada renderizaba blanco bajo
 * el Shell (ErrorBoundary no se dispara porque no hay error, simplemente no
 * matchea). Útil para typos en deep links de mail / PWA refresh sobre rutas
 * viejas.
 */
import { Link } from 'react-router-dom';
import { Icons } from '../components/Icons';

export default function NotFound() {
  return (
    <div className="u-notfound-page">
      <div className="u-notfound-code">
        404
      </div>
      <h1 className="page-title u-mb-8">Pantalla no encontrada</h1>
      <p className="u-notfound-desc">
        La URL que abriste no corresponde a ninguna sección del portal. Puede que la dirección esté mal escrita o que la pantalla haya cambiado de lugar.
      </p>
      <div className="u-notfound-actions">
        <Link to="/inicio" className="btn btn-primary">
          <Icons.Home size={14} /> Ir al Inicio
        </Link>
        <Link to="/historial" className="btn">
          <Icons.Refresh size={14} /> Ver actividad reciente
        </Link>
      </div>
    </div>
  );
}
