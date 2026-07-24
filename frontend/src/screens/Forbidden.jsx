// Pantalla 403 — se muestra cuando el usuario navega a un módulo sin permiso.
import { useNavigate } from 'react-router-dom';

export default function Forbidden() {
  const navigate = useNavigate();
  return (
    <div className="u-forbidden-page">
      <div className="u-forbidden-emoji">🔒</div>
      <div className="u-forbidden-title">
        Sin acceso
      </div>
      <div className="u-forbidden-desc">
        No tenés permisos para ver este módulo.
        <br />
        Pedile al administrador que habilite el acceso.
      </div>
      <button className="btn btn-ghost" onClick={() => navigate('/inicio')}>
        Volver al inicio
      </button>
    </div>
  );
}
