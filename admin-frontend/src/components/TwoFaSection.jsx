// TwoFaSection — sección de estado 2FA para la pantalla "Mi cuenta" del
// admin console (task #498).
//
// Portado de frontend/src/components/TwoFaSection.jsx con simplificaciones
// específicas del back office:
//   · SIN useToast (el admin-frontend no lo tiene) — los mensajes de éxito/
//     error se propagan al padre vía la prop `onMessage`, que MiCuenta usa
//     para renderizar un banner en la parte superior de la pantalla. Si el
//     caller no pasa onMessage, degradamos a state local para no perder
//     feedback (usable standalone en tests).
//   · SIN useConfirm — usamos Modal primitive (2 steps: warning + pedir código
//     TOTP) para no depender de un hook global de confirmación que el admin
//     no tiene.
//   · SIN fmtFecha compartido (no existe en lib/format.js del admin) — helper
//     local con Intl.DateTimeFormat('es-AR').
//
// Estados visibles:
//   1. Cargando: skeleton mínimo hasta tener el status.
//   2. NO activado: card "No activado" + botón "Activar 2FA" → renderiza
//      TwoFaSetup (que ya vive en components/TwoFaSetup.jsx).
//   3. Activo: badge verde + fecha de activación + contador de recovery
//      codes + 2 acciones (Regenerar recovery, Desactivar rojo).
//
// Flujo de disable / regenerate (2 modales encadenados):
//   1. User hace click en la acción → Modal #1 muestra warning + "Continuar".
//   2. Confirma → Modal #2 pide código TOTP/recovery de 6-20 chars.
//   3. Confirma → llama al endpoint. En éxito, refresh() del status + mensaje.
//      En error, mantenemos Modal #2 abierto para reintentar.
//
// Regeneración: al éxito mostramos los 8 nuevos codes en un card amarillo
// dentro de la misma pantalla, con botones "Copiar todos" + "Ya los guardé"
// (idéntico al del portal).

import { useState, useEffect } from 'react';
import { twoFa } from '../lib/api.js';
import { Btn, Badge } from './primitives/index.jsx';
import Modal from './primitives/Modal.jsx';
import TwoFaSetup from './TwoFaSetup.jsx';

// Helper local: formatea una fecha ISO como "1 jul 2026, 10:30". Usa el
// locale es-AR — es coherente con lo que verían en el portal principal
// (que sí importa fmtFecha desde lib/format). Defensivo ante value null.
const DATE_FMT = new Intl.DateTimeFormat('es-AR', {
  day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_FMT.format(d);
}

export default function TwoFaSection({ onMessage }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState(null);

  // Modales de confirmación. Se manejan como 2 pasos: warning + código.
  // action ∈ 'disable' | 'regenerate' | null.
  const [confirmOpen, setConfirmOpen] = useState({ open: false, action: null });
  const [codeModal, setCodeModal] = useState({ open: false, action: null });
  const [code, setCode] = useState('');
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState('');

  // Task #497: confirm inline para "Cancelar setup pendiente" (evitamos
  // window.confirm para mantener el look-and-feel; usamos el Modal primitive).
  const [cancelSetupModalOpen, setCancelSetupModalOpen] = useState(false);
  const [cancelSetupLoading, setCancelSetupLoading] = useState(false);

  // Fallback local para el banner cuando el padre no pasa onMessage —
  // permite usar el componente standalone (tests / sanity check).
  const [localMessage, setLocalMessage] = useState(null);

  function emit(type, text) {
    if (typeof onMessage === 'function') onMessage({ type, text });
    else setLocalMessage({ type, text });
  }

  function refresh() {
    setLoading(true);
    twoFa.status()
      .then((s) => setStatus(s))
      .catch((e) => emit('error', e.message || 'No se pudo cargar el estado de 2FA'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers de acciones ─────────────────────────────────────────────
  function handleDisable() {
    setConfirmOpen({ open: true, action: 'disable' });
  }

  function handleRegenerateRecovery() {
    setConfirmOpen({ open: true, action: 'regenerate' });
  }

  // Confirm warning → abre el segundo modal que pide código.
  function proceedFromConfirm() {
    const action = confirmOpen.action;
    setConfirmOpen({ open: false, action: null });
    setCode('');
    setCodeError('');
    setCodeModal({ open: true, action });
  }

  async function submitCode(e) {
    e?.preventDefault?.();
    const trimmed = code.trim();
    if (trimmed.length < 6 || trimmed.length > 20) {
      setCodeError('El código debe tener entre 6 y 20 caracteres.');
      return;
    }
    setCodeLoading(true);
    setCodeError('');
    try {
      if (codeModal.action === 'disable') {
        await twoFa.disable(trimmed);
        emit('success', '2FA desactivado.');
      } else if (codeModal.action === 'regenerate') {
        const { recovery_codes } = await twoFa.regenerateRecovery(trimmed);
        setNewRecoveryCodes(recovery_codes);
        emit('success', 'Nuevos recovery codes generados. Guardalos.');
      }
      setCodeModal({ open: false, action: null });
      setCode('');
      refresh();
    } catch (err) {
      // No cerramos el modal — el user puede reintentar con otro código
      // (típico caso: código expirado por reloj desincronizado).
      setCodeError(err?.message || 'Código incorrecto.');
    } finally {
      setCodeLoading(false);
    }
  }

  function cancelCodeModal() {
    if (codeLoading) return;
    setCodeModal({ open: false, action: null });
    setCode('');
    setCodeError('');
  }

  // Task #497: cancelar setup pendiente (row con enabled_at=NULL).
  async function confirmCancelSetup() {
    setCancelSetupLoading(true);
    try {
      await twoFa.cancelSetup();
      emit('success', 'Setup cancelado. Podés empezar de cero cuando quieras.');
      setCancelSetupModalOpen(false);
      refresh();
    } catch (err) {
      emit('error', err?.message || 'No se pudo cancelar el setup.');
    } finally {
      setCancelSetupLoading(false);
    }
  }

  async function copyRecoveryCodes() {
    if (!newRecoveryCodes) return;
    try {
      await navigator.clipboard.writeText(newRecoveryCodes.join('\n'));
      emit('success', 'Codes copiados al portapapeles.');
    } catch {
      emit('error', 'No se pudo copiar al portapapeles.');
    }
  }

  // ── Sub-render: setup en curso (activación desde cero) ───────────────
  if (showSetup) {
    return (
      <TwoFaSetup
        onDone={() => { setShowSetup(false); refresh(); emit('success', '2FA activado.'); }}
        onCancel={() => setShowSetup(false)}
        onError={(msg) => emit('error', msg)}
      />
    );
  }

  // ── Sub-render: cargando ─────────────────────────────────────────────
  if (loading && !status) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div className="muted">Cargando estado de 2FA…</div>
      </div>
    );
  }

  // ── Sub-render: mensaje local (solo cuando no hay onMessage padre) ──
  // El padre normalmente renderiza sus propios banners; este slot sólo
  // aparece si el componente vive sin onMessage.
  const localBanner = localMessage && !onMessage ? (
    <div
      role={localMessage.type === 'error' ? 'alert' : 'status'}
      style={{
        marginBottom: 10, padding: '8px 10px', fontSize: 13, borderRadius: 6,
        background: localMessage.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
        color: `var(--${localMessage.type === 'error' ? 'neg' : 'pos'})`,
      }}
    >
      {localMessage.text}
    </div>
  ) : null;

  // ── Estado ACTIVADO ──────────────────────────────────────────────────
  if (status?.enabled) {
    const lowRecovery = (status.recovery_codes_remaining ?? 0) <= 2;
    const confirmTitle = confirmOpen.action === 'disable'
      ? 'Desactivar 2FA'
      : 'Regenerar recovery codes';
    const confirmMsg = confirmOpen.action === 'disable'
      ? 'Vas a desactivar la autenticación de dos factores. Después vas a poder loguearte al back office sólo con usuario y contraseña.'
      : 'Vas a generar 8 nuevos recovery codes. Los anteriores quedarán invalidados — asegurate de guardar los nuevos en un lugar seguro.';
    const codeTitle = codeModal.action === 'disable'
      ? 'Desactivar 2FA'
      : 'Regenerar recovery codes';
    const codeDesc = codeModal.action === 'disable'
      ? 'Ingresá tu código actual de 6 dígitos (o un recovery code) para confirmar.'
      : 'Ingresá tu código actual de 6 dígitos (o un recovery code). Los recovery codes anteriores quedarán invalidados.';

    return (
      <div>
        {localBanner}

        <div className="card" style={{ padding: 18, marginBottom: 12 }}>
          <div className="flex-between" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="flex-row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <Badge tone="pos">Activo</Badge>
                <strong>Autenticación de dos factores</strong>
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                Activado el {fmtFecha(status.enabled_at)}.
                {status.last_used_at && <> Último uso: {fmtFecha(status.last_used_at)}.</>}
                <br />
                {status.recovery_codes_remaining} de 8 recovery codes disponibles.
                {lowRecovery && (
                  <span className="u-color-warn">{' '}Te quedan pocos. Considerá regenerarlos.</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex-row" style={{ gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <Btn kind="ghost" sm onClick={handleRegenerateRecovery}>
              Regenerar recovery codes
            </Btn>
            <Btn kind="danger" sm onClick={handleDisable}>
              Desactivar 2FA
            </Btn>
          </div>
        </div>

        {/* Card amarillo con los 8 recovery codes recién generados. Se
            muestra una única vez — si el user cierra sin copiar, tiene
            que pedir /regenerate-recovery de nuevo. */}
        {newRecoveryCodes && (
          <div
            className="card"
            role="alert"
            aria-live="assertive"
            style={{
              padding: 14, marginBottom: 12,
              background: 'rgba(234, 179, 8, 0.08)',
              border: '1px solid rgba(234, 179, 8, 0.3)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              Nuevos recovery codes — guardalos AHORA
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.4 }}>
              Los anteriores ya no funcionan. Si cerrás esta pantalla sin copiarlos,
              no se vuelven a mostrar.
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6,
              fontFamily: 'monospace', fontSize: 13, marginBottom: 10,
            }}>
              {newRecoveryCodes.map((c, i) => (
                <div key={i} style={{
                  padding: '6px 10px', background: 'var(--surface)', borderRadius: 4,
                }}>{c}</div>
              ))}
            </div>
            <div className="flex-row u-gap-8">
              <Btn kind="ghost" sm onClick={copyRecoveryCodes}>Copiar todos</Btn>
              <Btn kind="primary" sm onClick={() => setNewRecoveryCodes(null)}>
                Ya los guardé
              </Btn>
            </div>
          </div>
        )}

        {/* Modal #1: warning con "Continuar" */}
        <Modal
          open={confirmOpen.open}
          onClose={() => setConfirmOpen({ open: false, action: null })}
          title={confirmTitle}
          size="sm"
          actions={
            <>
              <Btn kind="ghost" onClick={() => setConfirmOpen({ open: false, action: null })}>
                Cancelar
              </Btn>
              <Btn
                kind={confirmOpen.action === 'disable' ? 'danger' : 'primary'}
                onClick={proceedFromConfirm}
              >
                Continuar
              </Btn>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            {confirmMsg}
          </p>
        </Modal>

        {/* Modal #2: pide código TOTP/recovery. */}
        <Modal
          open={codeModal.open}
          onClose={cancelCodeModal}
          title={codeTitle}
          size="sm"
          actions={
            <>
              <Btn kind="ghost" onClick={cancelCodeModal} disabled={codeLoading}>
                Cancelar
              </Btn>
              <Btn
                kind="primary"
                onClick={submitCode}
                disabled={codeLoading || !code.trim()}
              >
                {codeLoading ? 'Verificando…' : 'Confirmar'}
              </Btn>
            </>
          }
        >
          <form onSubmit={submitCode}>
            <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
              {codeDesc}
            </p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="6 dígitos o recovery code"
              autoComplete="one-time-code"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={20}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={codeLoading}
              aria-invalid={!!codeError}
              autoFocus
              style={{
                width: '100%', fontFamily: 'monospace', fontSize: 16,
                letterSpacing: 1, textAlign: 'center',
                padding: '8px 12px', borderRadius: 4,
                border: '1px solid var(--border, rgba(148,163,184,0.3))',
                background: 'var(--bg)', color: 'var(--text)',
              }}
            />
            {codeError && (
              <div role="alert" style={{ fontSize: 12, color: 'var(--neg)', marginTop: 6 }}>
                {codeError}
              </div>
            )}
          </form>
        </Modal>
      </div>
    );
  }

  // ── Estado SETUP PENDIENTE ───────────────────────────────────────────
  // Task #497: el user llamó /setup (row existe con enabled_at=NULL) pero no
  // completó el paso 3 (ingresar código de 6 dígitos + enable). Ofrecemos 2
  // caminos: "Continuar setup" muestra TwoFaSetup (que es idempotente: regenera
  // secret + recovery codes vía /setup) o "Cancelar setup" borra el row para
  // empezar de cero.
  if (status?.configured && !status?.enabled) {
    return (
      <div>
        {localBanner}
        <div
          className="card"
          style={{
            padding: 18,
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
          }}
        >
          <div className="flex-row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <Badge tone="warn">Setup pendiente</Badge>
            <strong>Autenticación de dos factores</strong>
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
            Empezaste a activar 2FA pero no completaste el paso final (ingresar
            el código de 6 dígitos de tu app autenticadora). Para terminar,
            continuá el setup. Si perdiste el QR o querés empezar de cero,
            cancelá.
          </div>
          <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <Btn kind="ghost" sm onClick={() => setCancelSetupModalOpen(true)}>
              Cancelar setup
            </Btn>
            <Btn kind="primary" sm onClick={() => setShowSetup(true)}>
              Continuar setup
            </Btn>
          </div>
        </div>

        {/* Confirm modal para cancelar setup */}
        <Modal
          open={cancelSetupModalOpen}
          onClose={() => !cancelSetupLoading && setCancelSetupModalOpen(false)}
          title="Cancelar setup pendiente"
          size="sm"
          actions={
            <>
              <Btn
                kind="ghost"
                onClick={() => setCancelSetupModalOpen(false)}
                disabled={cancelSetupLoading}
              >
                Volver
              </Btn>
              <Btn
                kind="danger"
                onClick={confirmCancelSetup}
                disabled={cancelSetupLoading}
              >
                {cancelSetupLoading ? 'Cancelando…' : 'Cancelar setup'}
              </Btn>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Se borra el setup incompleto y podrás empezar de cero. ¿Continuar?
          </p>
        </Modal>
      </div>
    );
  }

  // ── Estado NO ACTIVADO ───────────────────────────────────────────────
  return (
    <div>
      {localBanner}
      <div className="card" style={{ padding: 18 }}>
        <div className="flex-row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Badge>No activado</Badge>
          <strong>Autenticación de dos factores</strong>
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
          Agregá una capa extra de seguridad al back office. Cuando esté activo,
          el portal te va a pedir un código de 6 dígitos de tu app autenticadora
          (Google Authenticator, Authy, 1Password, etc.) después del password.
          <br /><br />
          <strong>Obligatorio para super-admin:</strong> el guard S-25
          (auditoría 2026-06-30) exige 2FA para llegar a /api/super-admin/*.
        </div>
        <Btn kind="primary" onClick={() => setShowSetup(true)}>
          Activar 2FA
        </Btn>
      </div>
    </div>
  );
}
