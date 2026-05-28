import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App.jsx'
import { reloadForNewVersion } from './lib/chunkReload'
import { installGlobalErrorHandlers } from './lib/reportError'

// Vite emite este evento cuando falla el preload de un chunk dinámico
// (típico tras un deploy: el hash viejo ya no existe). Recargamos para tomar
// el bundle nuevo en vez de mostrar una pantalla de error.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault?.();
  reloadForNewVersion();
});

// window.onerror + unhandledrejection → /api/client-errors → backend Sentry.
// Throttled (max 5/sesión, mín 2s entre reportes). No-op en dev.
installGlobalErrorHandlers();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
