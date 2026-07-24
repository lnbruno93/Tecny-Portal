// ChangePaisTenantModal — PATCH /api/super-admin/tenants/:id/pais (feature #473).
//
// Cambiar el país de un tenant existente desde el back office. Decisión durable
// (design doc multi-pais-uyu.md §9.1): tenant.pais es inmutable desde la UI
// normal, solo super-admin puede tocarlo, y el cambio arrastra side-effects
// (cajas nuevas + actualización de alerta TC).
//
// UX anti-clic-accidental — mismo pattern que DeleteTenantModal (#438):
//   · Modal bloqueante (closeOnBackdrop=false).
//   · Radios AR/UY excluyendo el actual (no permitimos selección no-op).
//   · Banner explicativo de los side-effects (cajas + alerta TC + historial intacto).
//   · Input "tipear el nombre del tenant" para habilitar el botón.
//   · Botón confirm primary, deshabilitado hasta match exacto del nombre + país elegido.
//
// El backend también valida same_country (400) — esto es UX defensiva, no security.
// Pero el modal hace doble check para evitar reportar errores ya bloqueables.

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';

const PAISES = [
  { value: 'AR', label: 'Argentina', flag: 'AR', monedaLocal: 'ARS', tcDefault: 1400 },
  { value: 'UY', label: 'Uruguay',   flag: 'UY', monedaLocal: 'UYU', tcDefault: 40 },
];

function paisMeta(pais) {
  return PAISES.find((p) => p.value === pais);
}

export default function ChangePaisTenantModal({ tenant, open, onClose, onSaved }) {
  const paisActual = tenant?.pais || 'AR';
  // Default destino = el OTRO país (con 2 países, único valor válido).
  // Si en el futuro hay >2 países, el default queda en el primer != actual y
  // el operador puede cambiar con los radios.
  const defaultDestino = PAISES.find((p) => p.value !== paisActual)?.value;

  const [paisNuevo, setPaisNuevo] = useState(defaultDestino);
  const [typedNombre, setTypedNombre] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const nombreId = useId();

  // Reset state cada vez que se abre — sin esto, abrir 2x mantiene el typed
  // del primer intento. Y si el tenant cambió (caso edge: usuario navega
  // entre tenants rapido y reabre acá), recalculamos default.
  useEffect(() => {
    if (open) {
      setPaisNuevo(defaultDestino);
      setTypedNombre('');
      setError('');
      setSubmitting(false);
    }
  }, [open, defaultDestino]);

  const expectedNombre = tenant?.nombre || '';
  // Case-sensitive trim-aware. Aceptamos espacios extras al final por error
  // de tipeo, pero el case debe matchear — el nombre del tenant es display
  // exacto, no slug.
  const nombreMatches =
    expectedNombre.length > 0 && typedNombre.trim() === expectedNombre.trim();

  // Botón habilitado solo si: hay un tenant, el país elegido es != actual,
  // y el nombre matchea. Defensa contra estados intermedios.
  const canSubmit =
    !!tenant && !!paisNuevo && paisNuevo !== paisActual && nombreMatches && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      await adminApi.changePaisTenant(tenant.id, paisNuevo);
      onSaved?.();
    } catch (err) {
      // Backend devuelve error.code para los 4xx esperados. Mapeamos a
      // mensajes accionables para el operador.
      const code = err?.body?.code || err?.code;
      let msg = err?.message || 'No pudimos cambiar el país del tenant.';
      if (code === 'has_active_partnerships') {
        msg = 'El tenant tiene partnerships Red B2B activas. Revocá las partnerships antes de cambiar el país.';
      } else if (code === 'tenant_suspended') {
        msg = 'No se puede cambiar el país de un tenant suspendido. Reactivalo primero.';
      } else if (code === 'same_country') {
        msg = `El tenant ya tiene país ${paisActual}. Elegí otro destino.`;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const metaActual = paisMeta(paisActual);
  const metaNuevo = paisMeta(paisNuevo);

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Cambiar país del tenant"
      size="md"
      // Click backdrop NO cierra: acción con side-effects amplios, queremos
      // intención explícita (X o Cancelar).
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? 'Cambiando país…' : `Cambiar a ${metaNuevo?.label || paisNuevo}`}
          </Btn>
        </>
      }
    >
      <div className="banner banner-info u-mb-14">
        <div>
          <strong>Side-effects del cambio AR ↔ UY:</strong>
          <ul className="u-m-8-0-0-18-p-0">
            <li>
              Se crean cajas nuevas en la moneda local del país destino, con sufijo
              <code> ({metaNuevo?.value})</code> en el nombre.
            </li>
            <li>Las cajas viejas <strong>no se borran</strong> — historial intacto.</li>
            <li>
              Se actualiza el threshold de la alerta TC a{' '}
              <strong>{metaNuevo?.tcDefault}</strong> ({metaNuevo?.monedaLocal}/USD).
            </li>
            <li>Queda registrado en el audit trail con tu user_id.</li>
          </ul>
        </div>
      </div>

      <div className="u-mb-14">
        <div className="form-label u-mb-6">País destino</div>
        <div className="flex-row u-gap-12-flex-wrap">
          {PAISES.map((p) => {
            const esActual = p.value === paisActual;
            return (
              <label
                key={p.value}
                className={`pais-radio u-pais-radio ${esActual ? 'is-disabled u-pais-radio-disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="pais"
                  value={p.value}
                  checked={paisNuevo === p.value}
                  onChange={() => setPaisNuevo(p.value)}
                  disabled={esActual || submitting}
                />
                <span>
                  <strong>{p.flag}</strong> {p.label}
                  {esActual && (
                    <span className="muted tiny u-ml-6">
                      (actual)
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <div className="muted tiny u-mt-6">
          Hoy: <strong>{metaActual?.flag} {metaActual?.label}</strong>.
          Cambiar arrastra moneda local <strong>{metaNuevo?.monedaLocal}</strong>{' '}
          y TC default <strong>{metaNuevo?.tcDefault}</strong>.
        </div>
      </div>

      <div>
        <label className="form-label" htmlFor={nombreId}>
          Para confirmar, escribí el nombre del tenant: <code>{expectedNombre}</code>
        </label>
        <input
          id={nombreId}
          className="input"
          type="text"
          value={typedNombre}
          onChange={(e) => setTypedNombre(e.target.value)}
          placeholder={expectedNombre}
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
          autoFocus
        />
        <div className="muted tiny u-mt-4">
          Match exacto (case-sensitive). El botón se habilita cuando coincide.
        </div>
      </div>

      {error && (
        <div className="banner banner-neg u-mt-12" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
