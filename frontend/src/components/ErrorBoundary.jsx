// ErrorBoundary — captura errores de render de React antes de que lleguen al root.
// Necesita ser class component (limitación de la API de React).
// Úsalo como: <ErrorBoundary><Screen /></ErrorBoundary>

import { Component } from 'react';
import { isChunkLoadError, reloadForNewVersion } from '../lib/chunkReload';
import { reportError } from '../lib/reportError';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, reloading: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Chunk viejo tras un deploy → recargar para tomar el bundle nuevo.
    if (isChunkLoadError(error) && reloadForNewVersion()) {
      this.setState({ reloading: true });
      return;
    }
    console.error('[ErrorBoundary]', error, info.componentStack);
    // Reportar al backend (que lo reenvía a Sentry si está configurado).
    // Throttle interno en reportError: máximo 5 por sesión, 2s entre cada uno.
    reportError(error, { source: 'ErrorBoundary', componentStack: info?.componentStack?.slice(0, 2000) });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.state.reloading) {
      return (
        <div className="u-eb-wrap">
          <div className="u-eb-icon-28">⏳</div>
          <div className="u-eb-text">Actualizando a la última versión…</div>
        </div>
      );
    }

    const chunkErr = isChunkLoadError(this.state.error);

    return (
      <div className="u-eb-wrap-lg">
        <div className="u-eb-icon-36">⚠️</div>
        <div className="u-eb-title">
          Algo salió mal
        </div>
        <div className="u-eb-desc">
          Esta pantalla tuvo un error inesperado. Podés intentar recargar o volver al inicio.
        </div>
        {this.state.error && (
          <code className="u-eb-code">
            {this.state.error.message}
          </code>
        )}
        <div className="u-eb-btn-row">
          <button
            className="btn btn-ghost"
            onClick={() => window.location.assign('/inicio')}
          >
            Ir al inicio
          </button>
          <button
            className="btn btn-primary"
            onClick={() => { chunkErr ? window.location.reload() : this.setState({ hasError: false, error: null }); }}
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }
}
