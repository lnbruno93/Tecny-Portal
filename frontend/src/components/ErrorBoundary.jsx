// ErrorBoundary — captura errores de render de React antes de que lleguen al root.
// Necesita ser class component (limitación de la API de React).
// Úsalo como: <ErrorBoundary><Screen /></ErrorBoundary>

import { Component } from 'react';
import { isChunkLoadError, reloadForNewVersion } from '../lib/chunkReload';

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
    // En producción con Sentry: Sentry.captureException(error, { extra: info })
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.state.reloading) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 28 }}>⏳</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Actualizando a la última versión…</div>
        </div>
      );
    }

    const chunkErr = isChunkLoadError(this.state.error);

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
        <div style={{ fontSize: 36 }}>⚠️</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text)' }}>
          Algo salió mal
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14, maxWidth: 420 }}>
          Esta pantalla tuvo un error inesperado. Podés intentar recargar o volver al inicio.
        </div>
        {this.state.error && (
          <code style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            background: 'var(--surface-2)',
            padding: '8px 14px',
            borderRadius: 8,
            maxWidth: 480,
            overflow: 'auto',
            display: 'block',
          }}>
            {this.state.error.message}
          </code>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
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
