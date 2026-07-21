// ErrorBoundary — fallback de UI si un componente crashea en render.
//
// Audit 2026-06-22 (S-13): sin esto, cualquier excepción no manejada en
// el árbol React deja al super-admin con pantalla en blanco sin pista del
// error. Lucas se entera por reportes de Sentry, mientras tanto la app
// está rota desde el punto de vista del usuario.
//
// Casos típicos que cubre:
//   · `describeAction({ icon: 'NoExiste' })` cuando el backend agrega
//     una action con icon que el frontend no mapea.
//   · `fmtDate(obj)` recibiendo algo que no es ISO string ni Date.
//   · `data.user.is_super_admin` cuando data viene null por race condition.
//   · Cualquier error en useMemo/useEffect que escape al render.
//
// UX del fallback: minimalista pero accionable.
//   1. Mensaje claro "Algo salió mal" (no jerga técnica).
//   2. Detalles colapsables (para diagnosticar sin abusar de la pantalla).
//   3. Botón "Recargar página" — el escape obvio para el operador.
//   4. Botón "Volver al inicio" — si el problema es de una ruta específica.
//
// Sin librerías externas (react-error-boundary) — class component nativo
// es suficiente y evita una dep más.

import { Component } from 'react';
import { reportError } from '../lib/reportError.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
    this.handleReload = this.handleReload.bind(this);
    this.handleHome = this.handleHome.bind(this);
  }

  static getDerivedStateFromError(error) {
    // Marca el state como "tiene error" para que el render muestre fallback.
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // 2026-07-15 (task #137): antes solo console.error — errors del admin
    // eran ciegos para Sentry. Ahora reportamos con source='admin:react-boundary'
    // + componentStack para que en Sentry se vea qué componente crasheó.
    // eslint-disable-next-line no-console
    console.error('[admin] ErrorBoundary captured:', error, info?.componentStack);
    reportError(error, {
      source: 'admin:react-boundary',
      component_stack: info?.componentStack?.slice(0, 2000) || null,
    });
  }

  handleReload() {
    // window.location.reload() — fuerza re-fetch del bundle. Si el error
    // era por un bundle stale post-deploy, esto lo arregla.
    if (typeof window !== 'undefined') window.location.reload();
  }

  handleHome() {
    // Reset state + navegar al inicio. Usamos window.location en vez de
    // useNavigate porque este es un class component sin acceso a hooks,
    // y de todas formas un error de render puede haber dejado el router
    // en estado inconsistente — reload completo es más seguro.
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { error, info } = this.state;
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg, #0d1117)',
          color: 'var(--text, #e6edf3)',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div className="u-mw-520">
          <h1 style={{ fontSize: 32, margin: '0 0 12px', fontWeight: 700 }}>
            Algo salió mal
          </h1>
          <p style={{ color: 'var(--text-muted, #5a6781)', fontSize: 14, marginBottom: 24 }}>
            El admin encontró un error inesperado. Probá recargar la página.
            Si el problema persiste, abrí la consola del browser para ver detalles.
          </p>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={this.handleReload}
              className="btn btn-primary"
              style={{
                padding: '10px 18px',
                fontSize: 14,
                background: 'var(--accent, #2f6df4)',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Recargar página
            </button>
            <button
              type="button"
              onClick={this.handleHome}
              className="btn"
              style={{
                padding: '10px 18px',
                fontSize: 14,
                background: 'transparent',
                color: 'var(--text, #e6edf3)',
                border: '1px solid var(--hairline, #2a3142)',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              Ir al Resumen
            </button>
          </div>

          {/* Detalles técnicos colapsables — para que el operador pueda copiar
              el error y compartirlo con el dev si hace falta. */}
          {error && (
            <details style={{ marginTop: 32, textAlign: 'left', fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted, #5a6781)' }}>
                Detalles técnicos
              </summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: 'var(--bg-soft, #161b22)',
                  border: '1px solid var(--hairline, #2a3142)',
                  borderRadius: 6,
                  overflow: 'auto',
                  maxHeight: 200,
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                {error.toString()}
                {info?.componentStack && '\n\n' + info.componentStack}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
