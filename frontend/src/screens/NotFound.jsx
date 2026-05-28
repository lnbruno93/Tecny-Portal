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
    <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center', padding: '0 20px' }}>
      <div style={{ fontSize: 72, fontWeight: 700, color: 'var(--accent)', lineHeight: 1, marginBottom: 12 }}>
        404
      </div>
      <h1 className="page-title" style={{ marginBottom: 8 }}>Pantalla no encontrada</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
        La URL que abriste no corresponde a ninguna sección del portal. Puede que la dirección esté mal escrita o que la pantalla haya cambiado de lugar.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
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
