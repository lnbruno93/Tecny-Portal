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
      <div role="alert" className="u-error-boundary-wrap">
        <div className="u-mw-520">
          <h1 className="u-error-boundary-title">
            Algo salió mal
          </h1>
          <p className="u-error-boundary-desc">
            El admin encontró un error inesperado. Probá recargar la página.
            Si el problema persiste, abrí la consola del browser para ver detalles.
          </p>

          <div className="u-error-boundary-btn-row">
            <button
              type="button"
              onClick={this.handleReload}
              className="btn btn-primary u-error-boundary-btn-primary"
            >
              Recargar página
            </button>
            <button
              type="button"
              onClick={this.handleHome}
              className="btn u-error-boundary-btn-ghost"
            >
              Ir al Resumen
            </button>
          </div>

          {/* Detalles técnicos colapsables — para que el operador pueda copiar
              el error y compartirlo con el dev si hace falta. */}
          {error && (
            <details className="u-error-boundary-details">
              <summary className="u-error-boundary-summary">
                Detalles técnicos
              </summary>
              <pre className="u-error-boundary-pre">
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
