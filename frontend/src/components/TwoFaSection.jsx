// TwoFaSection — sección de seguridad para el screen Config.
//
// Estados visibles:
//   · Cargando: spinner hasta tener el status.
//   · NO configurado: hint + botón "Activar 2FA" → muestra TwoFaSetup.
//   · Activado: status con check + 2 acciones (Desactivar, Regenerar recovery codes).
//
// U1 auditoría 2026-06: las acciones de "Desactivar" y "Regenerar" antes
// usaban window.prompt() — rompía el look-and-feel oscuro del portal, sin
// validación inline, sin a11y (aria-describedby), difícil pegar en mobile.
// Ahora usan TwoFaCodeModal — modal embebido con input estilizado, autoComplete
// one-time-code, validación visual, Esc para cancelar, mismo lenguaje que el
// resto del portal.

import { useState, useEffect, useRef } from 'react';
import { twoFa } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { fmtFecha } from '../lib/format';
import TwoFaSetup from './TwoFaSetup';
import useModal from '../lib/useModal';

// Modal embebido que pide código TOTP o recovery code. Reemplazo de window.prompt().
function TwoFaCodeModal({ open, title, description, onSubmit, onCancel, loading }) {
  const [code, setCode] = useState('');
  const overlayRef = useRef(null);
  const inputRef = useRef(null);
  useModal({ open, onClose: onCancel, overlayRef });

  // Reset al abrir/cerrar para no mostrar el código viejo.
  useEffect(() => { if (open) { setCode(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  if (!open) return null;
  const trimmed = code.trim();
  const valid = trimmed.length >= 6 && trimmed.length <= 20;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="dialog" aria-modal="true" aria-labelledby="twofa-code-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onCancel(); }}
      style={{ zIndex: 700 }}
    >
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <form onSubmit={(e) => { e.preventDefault(); if (valid && !loading) onSubmit(trimmed); }}>
          <div className="modal-body" style={{ padding: '24px 22px 14px' }}>
            <h3 id="twofa-code-modal-title" style={{ marginTop: 0, fontSize: 17, fontWeight: 700 }}>
              {title}
            </h3>
            <div className="muted tiny u-lh-15-mb-14" id="twofa-code-modal-desc">
              {description}
            </div>
            <input
              ref={inputRef}
              className="input mono"
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
              aria-describedby="twofa-code-modal-desc"
              disabled={loading}
              style={{ fontSize: 17, letterSpacing: 1, textAlign: 'center' }}
            />
          </div>
          <div className="modal-ft u-gap-8-justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={loading}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={!valid || loading}>
              {loading ? 'Verificando…' : 'Confirmar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function TwoFaSection() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState(null);
  // codeModal.action es 'disable' | 'regenerate' | null
  const [codeModal, setCodeModal] = useState({ open: false, action: null });
  const [codeModalLoading, setCodeModalLoading] = useState(false);

  function refresh() {
    setLoading(true);
    twoFa.status()
      .then(s => setStatus(s))
      .catch(e => toast.error(e.message || 'No se pudo cargar el estado de 2FA'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDisable() {
    const ok = await confirm({
      title: 'Desactivar 2FA',
      message: 'Vas a desactivar la autenticación de dos factores. ¿Continuar?',
      confirmLabel: 'Continuar',
    });
    if (!ok) return;
    setCodeModal({ open: true, action: 'disable' });
  }

  async function handleRegenerateRecovery() {
    const ok = await confirm({
      title: 'Regenerar recovery codes',
      message: 'Vas a generar 8 nuevos recovery codes. Los anteriores quedarán invalidados. ¿Continuar?',
      confirmLabel: 'Continuar',
    });
    if (!ok) return;
    setCodeModal({ open: true, action: 'regenerate' });
  }

  // Cuando el user confirma el código en el modal, ejecutamos la acción
  // correspondiente. El modal cierra al éxito; si falla, queda abierto para
  // que el user pueda reintentar.
  async function handleCodeSubmit(code) {
    setCodeModalLoading(true);
    try {
      if (codeModal.action === 'disable') {
        await twoFa.disable(code);
        toast.success('2FA desactivado.');
      } else if (codeModal.action === 'regenerate') {
        const { recovery_codes } = await twoFa.regenerateRecovery(code);
        setNewRecoveryCodes(recovery_codes);
        toast.success('Nuevos recovery codes generados. Guardalos.');
      }
      setCodeModal({ open: false, action: null });
      refresh();
    } catch (err) {
      toast.error(err.message || 'Código incorrecto.');
      // No cerramos el modal — el user puede reintentar con otro código.
    } finally {
      setCodeModalLoading(false);
    }
  }

  if (loading && !status) {
    return <div className="empty">Cargando estado de 2FA…</div>;
  }

  if (showSetup) {
    return (
      <TwoFaSetup
        onDone={() => { setShowSetup(false); refresh(); }}
        onCancel={() => setShowSetup(false)}
      />
    );
  }

  // ── Estado activado ──
  if (status?.enabled) {
    return (
      <div>
        <div className="card card-tight" style={{ padding: 18, marginBottom: 12 }}>
          <div className="flex-between" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="flex-row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span className="badge badge-pos">Activo</span>
                <strong>Autenticación de dos factores</strong>
              </div>
              <div className="muted tiny" style={{ lineHeight: 1.5 }}>
                Activado el {fmtFecha(status.enabled_at)}.
                {status.last_used_at && <> Último uso: {fmtFecha(status.last_used_at)}.</>}
                <br />
                {status.recovery_codes_remaining} de 8 recovery codes disponibles.
                {status.recovery_codes_remaining <= 2 && (
                  <span className="u-color-warn">{' '}⚠️ Te quedan pocos. Considerá regenerarlos.</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex-row" style={{ gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={handleRegenerateRecovery}>
              Regenerar recovery codes
            </button>
            <button className="btn btn-sm u-color-neg" onClick={handleDisable}>
              Desactivar 2FA
            </button>
          </div>
        </div>

        {newRecoveryCodes && (
          <div className="card card-tight" role="alert" aria-live="assertive" style={{
            padding: 14, background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
          }}>
            <div className="field-label u-mb-8">
              ⚠️ Nuevos recovery codes — guardalos AHORA
            </div>
            <div className="tiny" style={{ marginBottom: 10, lineHeight: 1.4 }}>
              Los anteriores ya no funcionan. Si cerrás esta pantalla sin copiarlos, no se vuelven a mostrar.
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
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(newRecoveryCodes.join('\n'));
                    toast.success('Codes copiados al portapapeles');
                  } catch {
                    toast.error('No se pudo copiar');
                  }
                }}
              >Copiar todos</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setNewRecoveryCodes(null)}
              >Ya los guardé</button>
            </div>
          </div>
        )}

        <TwoFaCodeModal
          open={codeModal.open}
          title={codeModal.action === 'disable' ? 'Desactivar 2FA' : 'Regenerar recovery codes'}
          description={codeModal.action === 'disable'
            ? 'Ingresá tu código actual de 6 dígitos (o un recovery code) para confirmar.'
            : 'Ingresá tu código actual de 6 dígitos (o un recovery code). Los recovery codes anteriores quedarán invalidados.'}
          onSubmit={handleCodeSubmit}
          onCancel={() => !codeModalLoading && setCodeModal({ open: false, action: null })}
          loading={codeModalLoading}
        />
      </div>
    );
  }

  // ── Estado SETUP PENDIENTE ──
  // Task #497: el user llamó /setup (row existe con enabled_at=NULL) pero no
  // completó el paso 3 (ingresar código de 6 dígitos + enable). Ofrecemos 2
  // caminos: continuar el setup (genera secret nuevo, /setup es idempotente)
  // o cancelar y borrar el row para empezar de cero limpio.
  if (status?.configured && !status?.enabled) {
    return (
      <div>
        <div className="card card-tight" style={{
          padding: 18,
          background: 'rgba(234, 179, 8, 0.08)',
          border: '1px solid rgba(234, 179, 8, 0.3)',
        }}>
          <div className="flex-row u-gap-8-center-mb-6">
            <span className="badge" style={{ background: 'var(--warn)', color: '#000' }}>Setup pendiente</span>
            <strong>Autenticación de dos factores</strong>
          </div>
          <div className="muted tiny u-lh-15-mb-14">
            Empezaste a activar 2FA pero no completaste el paso final (ingresar el código de 6 dígitos de tu app autenticadora). Para terminar, continuá el setup. Si perdiste el QR o querés empezar de cero, cancelá.
          </div>
          <div className="flex-row u-gap-8-justify-end">
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const ok = await confirm({
                  title: 'Cancelar setup pendiente',
                  message: 'Se borra el setup incompleto y podrás empezar de cero. ¿Continuar?',
                  confirmLabel: 'Cancelar setup',
                });
                if (!ok) return;
                try {
                  await twoFa.cancelSetup();
                  toast.success('Setup cancelado. Podés empezar de cero cuando quieras.');
                  refresh();
                } catch (e) {
                  toast.error(e.message || 'No se pudo cancelar el setup.');
                }
              }}
            >
              Cancelar setup
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setShowSetup(true)}>
              Continuar setup
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Estado NO configurado ──
  return (
    <div className="card card-tight" style={{ padding: 18 }}>
      <div className="flex-row u-gap-8-center-mb-6">
        <span className="badge badge-default">No activado</span>
        <strong>Autenticación de dos factores</strong>
      </div>
      <div className="muted tiny u-lh-15-mb-14">
        Agregá una capa extra de seguridad. Cuando esté activo, el portal va a
        pedirte un código de 6 dígitos de tu app autenticadora (Google
        Authenticator, Authy, 1Password, etc.) después del password.
        <br /><br />
        <strong>Recomendado para cuentas admin</strong> — tu usuario tiene
        acceso a información financiera sensible.
      </div>
      <button className="btn btn-primary" onClick={() => setShowSetup(true)}>
        Activar 2FA
      </button>
    </div>
  );
}
