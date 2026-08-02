import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Icons } from '../components/Icons';
// 2026-08-02 (task #284): cajasApi/blockInvalidNumberKeys/fmt eran usados
// por la sección "Comisiones de métodos de pago" que se movió al Cotizador.
// Solo queda `configApi` para el toggle de privacidad (task #280).
import { config as configApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import AlertasModule from './Alertas';
import TwoFaSection from '../components/TwoFaSection';
import MantenimientoSection from '../components/MantenimientoSection';
import { userHasCap } from '../lib/userHasCap';
// 2026-06-22: el perfil del negocio (ficha de Google que usa el Cotizador
// para personalizar el mensaje generado) vive como tab "Configuración"
// dentro de Cotizador, NO acá en Config global. Se hizo así para que el
// dato esté al lado del lugar donde se usa — Lucas pidió evitar la confusión
// de tener configuración "general del portal" mezclada con configuración
// específica de un módulo. Por eso `BusinessProfileSection` no se importa
// más desde acá.


// Fallback usado si /api/config/system-limits falla (red caída, deploy mid-flight).
// Los VALORES REALES vienen del backend (#443). Mantenemos este fallback
// porque la sección es informativa — preferible mostrar algo a romper el
// render. Sincronizar a mano con backend/src/lib/systemLimits.js si cambia.
const SYSTEM_LIMITS_FALLBACK = [
  { t: 'OCR rate-limit',  d: '60 solicitudes/hora por usuario' },
  { t: 'Tamaño máximo archivos', d: 'Máximo 10 MB por archivo subido' },
  { t: 'Soft delete',     d: 'Los registros nunca se borran físicamente' },
  { t: 'Permisos',        d: 'Owner + Admin bypassean checks; otros según permisos' },
  { t: 'Auditoría',       d: 'Cambios registrados por 90 días' },
  { t: 'Cotizador',       d: 'Client-side, TC default = último cambio del tenant' },
];

export default function Config() {
  const location = useLocation();
  const { user } = useAuth();
  // 2026-06-23 F5c: gating per-tab basado en caps del sistema nuevo.
  // El RequirePermission del route ya garantiza que el user tiene AL MENOS
  // UNA de las 3 caps de Config — acá decidimos qué tabs renderear y a
  // cuál arrancar.
  const canGeneral       = userHasCap(user, 'config.general');
  const canAlertas       = userHasCap(user, 'config.alertas');
  const canMantenimiento = userHasCap(user, 'config.mantenimiento');

  // Tab inicial: respeta el hash si el user puede ver esa tab, sino fallback
  // a la primera tab visible. Seguridad (2FA propia) es siempre accesible
  // — todo user logueado puede gestionar su propia 2FA.
  const hashTab = location.hash.replace('#', '');
  const wantedFromHash =
    (hashTab === 'general'       && canGeneral)       ? 'general' :
    (hashTab === 'alertas'       && canAlertas)       ? 'alertas' :
    (hashTab === 'mantenimiento' && canMantenimiento) ? 'mantenimiento' :
    (hashTab === 'seguridad')                         ? 'seguridad' :
    null;
  // Default: primera tab disponible (general → alertas → mantenimiento → seguridad).
  const firstAvailableTab =
    canGeneral       ? 'general' :
    canAlertas       ? 'alertas' :
    canMantenimiento ? 'mantenimiento' :
    'seguridad';
  const initialTab = wantedFromHash || firstAvailableTab;
  const [tab, setTab]           = useState(initialTab); // 'general' | 'alertas' | 'seguridad' | 'mantenimiento'
  // 2026-08-02 (task #284): las comisiones de métodos de pago (Financiera +
  // Tarjetas) fueron MOVIDAS a Cotizador → Tarjetas de crédito. Config →
  // General ahora solo tiene el toggle de "Privacidad en Ventas" (task #280)
  // + las Limitaciones del sistema. Racional: el operador ve realmente el
  // impacto de cada % en el Cotizador, no en Config; y la deuda técnica de
  // tener el UI acá + el cotizador leyendo hardcoded era latente (Cotizador
  // ignoraba las % del tenant hasta el fix del #284).
  //
  // 2026-08-01 (task #280): toggle "Ocultar ganancia en modal de Ventas".
  // `hideGanancia` = valor actual del switch; `hideGananciaOriginal` = valor
  // persistido en DB (para detectar dirty).
  const [hideGanancia, setHideGanancia] = useState(false);
  const [hideGananciaOriginal, setHideGananciaOriginal] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(true);
  // #443: System limits ahora vienen del backend (antes hardcoded). Fallback
  // al array local si el fetch falla — no rompemos render por una llamada
  // informativa.
  const [systemLimits, setSystemLimits] = useState(SYSTEM_LIMITS_FALLBACK);
  useEffect(() => {
    let alive = true;
    configApi.systemLimits()
      .then((res) => { if (alive && Array.isArray(res?.limits)) setSystemLimits(res.limits); })
      .catch(() => { /* silent: ya tenemos fallback */ });
    return () => { alive = false; };
  }, []);

  // Si el hash cambia mientras estamos en Config (ej: click al badge de
  // alertas estando ya en Config), sincronizar la tab. F5c: gated por cap.
  // Si el user no tiene la cap, ignoramos el hash (se queda en la tab actual).
  useEffect(() => {
    if (location.hash === '#alertas' && canAlertas) setTab('alertas');
    else if (location.hash === '#seguridad') setTab('seguridad');
    else if (location.hash === '#mantenimiento' && canMantenimiento) setTab('mantenimiento');
    else if (location.hash === '#general' && canGeneral) setTab('general');
  }, [location.hash, canAlertas, canMantenimiento, canGeneral]);

  // TANDA 5 trazab (UX L4): cambiar tab actualiza el hash con replaceState (no
  // pushState — evita ensuciar el history). Permite copiar URL y compartir,
  // y que F5 mantenga la tab activa en lugar de pegarse al hash inicial.
  function goToTab(t) {
    setTab(t);
    if (window.history.replaceState) {
      window.history.replaceState(null, '', `#${t}`);
    } else {
      window.location.hash = `#${t}`;
    }
  }

  // 2026-08-02 (task #284): antes también fetcheaba pct_financiera + cajas
  // TC porque el UI las editaba. Ahora ese trabajo se movió a Cotizador →
  // Tarjetas de crédito (el hook useComisionesTenant), y acá solo queda el
  // toggle de privacidad (task #280).
  useEffect(() => {
    let alive = true;
    configApi.get()
      .then(cfg => {
        if (!alive) return;
        const hg = cfg?.ocultar_ganancia_venta === true;
        setHideGanancia(hg);
        setHideGananciaOriginal(hg);
      })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const gananciaDirty = hideGanancia !== hideGananciaOriginal;
  const dirty = gananciaDirty;

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      if (gananciaDirty) await configApi.update({ ocultar_ganancia_venta: hideGanancia });
      setHideGananciaOriginal(hideGanancia);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setHideGanancia(hideGananciaOriginal);
    setError('');
    setSaved(false);
  }

  if (loading) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Configuración</h1>
        </div>
        <div className="empty">Cargando configuración…</div>
      </div>
    );
  }

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Configuración</h1>
          <div className="page-sub">Ajustes globales del portal · sólo administradores</div>
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      {/* TANDA 5 trazab (UX L4): goToTab sincroniza el hash con el tab activo.
          Antes, si el usuario llegaba via #mantenimiento y luego cambiaba a
          General, el hash quedaba pegado y un F5 lo devolvía a Mantenimiento. */}
      {/* 2026-06-23 F5c: tabs visibles según caps del user. Seguridad (2FA
          propia) siempre visible — todo user puede gestionar su propia 2FA. */}
      <div className="flex-row u-tabs-row">
        {canGeneral && (
          <button className={'btn ' + (tab === 'general' ? 'btn-primary' : '')}
                  onClick={() => goToTab('general')}>
            General
          </button>
        )}
        {canAlertas && (
          <button className={'btn ' + (tab === 'alertas' ? 'btn-primary' : '')}
                  onClick={() => goToTab('alertas')}>
            <Icons.Bell size={14} /> Alertas
          </button>
        )}
        <button className={'btn ' + (tab === 'seguridad' ? 'btn-primary' : '')}
                onClick={() => goToTab('seguridad')}>
          <Icons.Shield size={14} /> Seguridad
        </button>
        {canMantenimiento && (
          <button className={'btn ' + (tab === 'mantenimiento' ? 'btn-primary' : '')}
                  onClick={() => goToTab('mantenimiento')}>
            <Icons.Bolt size={14} /> Mantenimiento
          </button>
        )}
      </div>

      {tab === 'alertas' && canAlertas && <AlertasModule />}
      {tab === 'seguridad' && <TwoFaSection />}
      {tab === 'mantenimiento' && canMantenimiento && <MantenimientoSection />}

      {tab === 'general' && canGeneral && (
      <>

      {/* Hint que "Comisiones de métodos de pago" se movió al Cotizador
          (task #284). Si un admin llega acá buscando editar las %, le damos
          el pointer. */}
      <div className="card u-mb-16">
        <div className="card-hd">
          <div className="u-fw-600-fs-15">Comisiones de métodos de pago</div>
          <div className="muted tiny u-mt-2">
            Se movieron al Cotizador para que puedas ajustar y ver el impacto en vivo. <a href="/cotizador">Ir al Cotizador →</a>
          </div>
        </div>
      </div>

      {/* Limitaciones del sistema (informativo) */}
      <div className="card">
        <div className="card-hd">
          <div className="u-fw-600-fs-15">Limitaciones del sistema</div>
          <div className="muted tiny u-mt-2">
            Comportamientos que conviene tener presentes
          </div>
        </div>
        <div className="u-config-limits-grid">
          {systemLimits.map(({ t, d }) => (
            <div
              key={t}
              className="u-config-limit-card"
            >
              <div className="u-fw-600-fs-13-mb-4">{t}</div>
              <div className="muted tiny u-lh-14">{d}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 2026-08-01 (task #280, pedido tenant): toggle privacidad para
          ocultar el bloque "Preview de ganancia" del modal de Ventas.
          Cuando el operador carga ventas frente al cliente en el mostrador,
          el cliente ve la pantalla y puede leer el margen del negocio →
          incómodo. Toggle per-tenant, default apagado (muestra ganancia).
          2026-08-02 (task #284): ahora tiene su propio save (antes compartía
          con la sección de comisiones que se movió al Cotizador). */}
      <div className="card u-mt-16">
        <div className="card-hd">
          <div className="u-fw-600-fs-15">Privacidad en Ventas</div>
          <div className="muted tiny u-mt-2">
            Qué mostrar en la pantalla al cargar una venta
          </div>
        </div>
        <div className="u-p-0-0-16">
          <label className="u-flex-center-gap-10" htmlFor="config-hide-ganancia">
            <input
              type="checkbox"
              id="config-hide-ganancia"
              data-testid="config-hide-ganancia"
              checked={hideGanancia}
              onChange={e => {
                setHideGanancia(e.target.checked);
                setSaved(false);
                setError('');
              }}
            />
            <span className="u-fw-600-fs-14">Ocultar "Ganancia" en el modal de Ventas</span>
          </label>
          <div className="muted tiny u-mt-6 u-lh-14">
            Cuando está activado, no se muestran las líneas <strong>Ganancia bruta</strong>,
            <strong> Vuelto entregado</strong> ni <strong>Ganancia real</strong> en el modal
            de nueva venta. Útil si cargás ventas frente al cliente y no querés que vea el margen.
            El resto (Total venta, Cubierto, Diferencia) sigue visible para verificar el pago.
          </div>
          <div className="muted tiny u-mt-4">
            Estado guardado: <span className="mono u-fw-700">{hideGananciaOriginal ? 'Oculto' : 'Visible'}</span>
          </div>

          {/* Feedback + save */}
          {error && <div className="u-alert-neg u-mt-14">{error}</div>}
          {saved && <div className="u-alert-pos u-mt-14">Configuración guardada correctamente.</div>}
          <div className="flex-row u-gap-8 u-mt-14">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !dirty}
              data-testid="config-privacidad-save"
            >
              <Icons.Check size={15} />
              {saving ? 'Guardando…' : dirty ? 'Guardar cambios' : 'Sin cambios'}
            </button>
            {dirty && (
              <button className="btn btn-ghost" onClick={handleCancel}>
                Cancelar
              </button>
            )}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
