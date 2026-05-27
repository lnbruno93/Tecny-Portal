import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App.jsx'
import { reloadForNewVersion } from './lib/chunkReload'

// Vite emite este evento cuando falla el preload de un chunk dinámico
// (típico tras un deploy: el hash viejo ya no existe). Recargamos para tomar
// el bundle nuevo en vez de mostrar una pantalla de error.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault?.();
  reloadForNewVersion();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
