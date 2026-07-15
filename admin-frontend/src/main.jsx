import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { installGlobalErrorHandlers } from './lib/reportError.js';
import './styles.css';

// 2026-07-15 (task #137): captura errores fuera del árbol React (fetch
// promises no-cacheados, window.onerror). Instalado UNA vez al bootstrap.
// Los errores viajan a /api/client-errors → Sentry con source='admin:*'.
installGlobalErrorHandlers();

// ErrorBoundary envuelve TODO el árbol (incluso router + auth provider).
// Si un componente crashea en render, mostramos UI de fallback en vez de
// pantalla en blanco. Audit 2026-06-22 (S-13).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
