// Pantalla 403 — se muestra cuando el usuario navega a un módulo sin permiso.
import { useNavigate } from 'react-router-dom';

export default function Forbidden() {
  const navigate = useNavigate();
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 16,
      padding: 32,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 42, lineHeight: 1 }}>🔒</div>
      <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text)' }}>
        Sin acceso
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 14, maxWidth: 360 }}>
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
