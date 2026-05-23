import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Shell from './components/Shell';
import Login from './screens/Login';
import Inicio from './screens/Inicio';
import CuentasCC from './screens/CuentasCC';
import Financiera from './screens/Financiera';

// Placeholder screens — replace with real implementations
const Placeholder = ({ name }) => (
  <div style={{ padding: 32, color: 'var(--text-2)' }}>
    <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{name}</h2>
    <p style={{ color: 'var(--text-muted)' }}>Próximamente</p>
  </div>
);

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      color: 'var(--text-muted)',
      fontSize: 14
    }}>
      Verificando sesión...
    </div>
  );
  if (!user) return <Login />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <RequireAuth>
          <Routes>
            <Route path="/" element={<Shell />}>
              <Route index element={<Navigate to="/inicio" replace />} />
              <Route path="inicio" element={<Inicio />} />
              <Route path="cotizador" element={<Placeholder name="Cotizador" />} />
              <Route path="financiera/*" element={<Financiera />} />
              <Route path="cajas/*" element={<Placeholder name="Cajas" />} />
              <Route path="envios" element={<Placeholder name="Envíos" />} />
              <Route path="cuentas/*" element={<CuentasCC />} />
              <Route path="usados" element={<Placeholder name="Usados" />} />
              <Route path="historial" element={<Placeholder name="Historial" />} />
              <Route path="usuarios" element={<Placeholder name="Usuarios" />} />
              <Route path="config" element={<Placeholder name="Config" />} />
            </Route>
          </Routes>
        </RequireAuth>
      </BrowserRouter>
    </AuthProvider>
  );
}
