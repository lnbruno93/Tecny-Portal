// TwoFaSetup — flow guiado para activar 2FA en una cuenta:
//   1. Llama POST /api/auth/2fa/setup → recibe secret + otpauth URI + 8 recovery codes.
//   2. Muestra QR (renderizado client-side con la lib `qrcode`) + secret manual + recovery codes.
//   3. User escanea con Google Authenticator (o similar) y tipea el primer código.
//   4. POST /api/auth/2fa/enable con ese código → marca enabled_at = NOW().
//   5. Llama onDone para refrescar el status en el componente padre.
//
// Importante: los recovery codes se muestran UNA SOLA VEZ — el user tiene que
// guardarlos. Si los pierde, no hay forma de recuperarlos sin desactivar 2FA
// (y eso requiere ya un código TOTP válido). Documentado en RUNBOOK.

import { useState, useEffect, useRef } from 'react';
import { twoFa } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import QRCode from 'qrcode';

export default function TwoFaSetup({ onDone, onCancel }) {
  const { toast } = useToast();
  const [step, setStep] = useState('loading'); // loading | scan | verifying | done
  const [setupData, setSetupData] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const canvasRef = useRef(null);

  // Step 1: llamar setup al montar.
  useEffect(() => {
    twoFa.setup()
      .then(data => {
        setSetupData(data);
        setStep('scan');
      })
      .catch(err => {
        toast.error(err.message || 'No se pudo iniciar el setup de 2FA');
        onCancel?.();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Renderizar el QR cuando setupData esté listo (post-render, en el canvas).
  useEffect(() => {
    if (!setupData || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, setupData.otpauth_uri, {
      width: 220,
      margin: 1,
      color: { dark: '#0a0e18', light: '#ffffff' },
    }).catch(err => {
      // Si el QR falla, el user todavía puede usar el secret manual.
      // eslint-disable-next-line no-console
      console.error('QR render failed:', err);
    });
  }, [setupData]);

  async function handleEnable(e) {
    e?.preventDefault?.();
    setError('');
    if (!/^\d{6}$/.test(code.trim())) {
      setError('El código debe tener exactamente 6 dígitos.');
      return;
    }
    setStep('verifying');
    try {
      await twoFa.enable(code.trim());
      setStep('done');
      toast.success('2FA activado correctamente.');
      // Pequeño delay para que el user vea el "✓ Activado" antes del refresh.
      setTimeout(() => onDone?.(), 800);
    } catch (err) {
      setStep('scan');
      setError(err.message || 'Código incorrecto. Verificá que el reloj del cel esté sincronizado.');
      setCode('');
    }
  }

  async function copyToClipboard(text, which) {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'secret') {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 2000);
      } else {
        setCopiedRecovery(true);
        setTimeout(() => setCopiedRecovery(false), 2000);
      }
    } catch {
      toast.error('No se pudo copiar al portapapeles. Copialo a mano.');
    }
  }

  if (step === 'loading' || !setupData) {
    return <div className="empty">Generando código de seguridad…</div>;
  }

  if (step === 'done') {
    return (
      <div className="card card-tight" style={{ textAlign: 'center', padding: 40 }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 64, height: 64, borderRadius: '50%',
          border: '3px solid var(--pos)', color: 'var(--pos)',
          marginBottom: 16,
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h3 className="u-m-0-0-8">2FA activado</h3>
        <div className="muted tiny">Desde ahora vas a necesitar tu código al loguearte.</div>
      </div>
    );
  }

  return (
    <div className="card card-tight" style={{ padding: 20 }}>
      <h3 style={{ marginTop: 0 }}>Activar autenticación de dos factores</h3>
      <div className="muted tiny u-mb-18">
        Necesitás una app autenticadora en tu cel: Google Authenticator,
        Authy, 1Password o cualquier otra compatible con TOTP.
      </div>

      {/* ── 1) QR + secret manual ── */}
      <div style={{ marginBottom: 24 }}>
        <div className="field-label">Paso 1 — Escaneá el QR con tu app autenticadora</div>
        <div style={{
          display: 'flex', gap: 20, alignItems: 'flex-start',
          padding: 16, background: 'var(--surface-2)', borderRadius: 8, marginTop: 8,
        }}>
          {/* U6 auditoría 2026-06: aria-label + role para screen readers.
              El canvas es invisible para AT por default — sin el label, un user
              con discapacidad visual no sabe que tiene la opción de escanear. */}
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Código QR de activación 2FA. Si no podés escanearlo, usá el código manual de abajo."
            style={{ flexShrink: 0, borderRadius: 4, background: '#fff' }}
          />
          <div className="u-flex-1-minw-0">
            <div className="muted tiny" style={{ marginBottom: 6 }}>
              ¿No podés escanear? Ingresá este código manualmente:
            </div>
            {/* data-testid agregado para E2E (TANDA 5 activar 2FA UI) — el
                spec lo lee para generar el TOTP que verifica el setup. */}
            <div
              data-testid="twofa-secret"
              className="mono"
              style={{
                fontSize: 13, wordBreak: 'break-all', padding: '8px 10px',
                background: 'var(--surface)', borderRadius: 4, marginBottom: 6,
              }}
            >
              {setupData.secret}
            </div>
            {/* aria-live para anunciar al lector de pantalla cuando el feedback
                "✓ Copiado" aparece (sin esto, el texto cambia sin aviso). */}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => copyToClipboard(setupData.secret, 'secret')}
              aria-live="polite"
            >
              {copiedSecret ? '✓ Copiado' : 'Copiar código'}
            </button>
          </div>
        </div>
      </div>

      {/* ── 2) Recovery codes ── */}
      <div style={{ marginBottom: 24 }}>
        <div className="field-label">Paso 2 — Guardá estos recovery codes ⚠️</div>
        <div style={{
          padding: 14, background: 'rgba(234, 179, 8, 0.08)',
          border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 8, marginTop: 8,
        }}>
          <div className="tiny" style={{ marginBottom: 10, lineHeight: 1.5 }}>
            Si perdés tu cel, podés usar uno de estos códigos (una sola vez cada uno)
            para entrar al portal. <strong>Guardalos en un lugar seguro</strong> —
            password manager, papel impreso, etc. No se vuelven a mostrar.
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6,
            fontFamily: 'monospace', fontSize: 13, marginBottom: 10,
          }}>
            {setupData.recovery_codes.map((c, i) => (
              <div key={i} style={{
                padding: '6px 10px', background: 'var(--surface)', borderRadius: 4,
              }}>{c}</div>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => copyToClipboard(setupData.recovery_codes.join('\n'), 'recovery')}
            aria-live="polite"
          >
            {copiedRecovery ? '✓ Copiados' : 'Copiar los 8 codes'}
          </button>
        </div>
      </div>

      {/* ── 3) Verificación ── */}
      <form onSubmit={handleEnable}>
        <div className="field">
          <label className="field-label" htmlFor="twofa-verify-code">
            Paso 3 — Ingresá el código de 6 dígitos de tu app
          </label>
          <input
            id="twofa-verify-code"
            className="input mono"
            type="text"
            inputMode="numeric"
            placeholder="123456"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            style={{ fontSize: 18, letterSpacing: 2, textAlign: 'center', maxWidth: 200 }}
            disabled={step === 'verifying'}
          />
        </div>
        {error && (
          <div role="alert" style={{
            color: 'var(--neg)', fontSize: 13, marginBottom: 10,
          }}>{error}</div>
        )}
        <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={step === 'verifying'}
          >Cancelar</button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={step === 'verifying' || code.length !== 6}
          >
            {step === 'verifying' ? 'Verificando…' : 'Activar 2FA'}
          </button>
        </div>
      </form>
    </div>
  );
}
