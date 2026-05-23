import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Shell from './components/Shell';
import Login from './screens/Login';
import Inicio from './screens/Inicio';
import CuentasCC from './screens/CuentasCC';
import Financiera from './screens/Financiera';
import Envios from './screens/Envios';
import Cajas from './screens/Cajas';
import Usados from './screens/Usados';
import Historial from './screens/Historial';
import Usuarios from './screens/Usuarios';
import Config from './screens/Config';
import Cotizador from './screens/Cotizador';

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
              <Route path="cotizador" element={<Cotizador />} />
              <Route path="financiera/*" element={<Financiera />} />
              <Route path="cajas/*" element={<Cajas />} />
              <Route path="envios" element={<Envios />} />
              <Route path="cuentas/*" element={<CuentasCC />} />
              <Route path="usados" element={<Usados />} />
              <Route path="historial" element={<Historial />} />
              <Route path="usuarios" element={<Usuarios />} />
              <Route path="config" element={<Config />} />
            </Route>
          </Routes>
        </RequireAuth>
      </BrowserRouter>
    </AuthProvider>
  );
}
