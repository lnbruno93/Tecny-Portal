// TwoFaSetup — flujo guiado para activar 2FA (task #498).
//
// Portado de frontend/src/components/TwoFaSetup.jsx con adaptaciones al
// design system del back office (Btn/Card primitives, sin useToast — usa
// callbacks onError / onDone, y feedback inline).
//
// Flujo (3 pasos visibles al usuario):
//   1. POST /2fa/setup → devuelve secret + otpauth_uri + 8 recovery codes.
//   2. Muestra QR (client-side lib qrcode) + secret manual + recovery codes.
//   3. User escanea con Google Authenticator / Authy y tipea código 6 dígitos.
//   4. POST /2fa/enable con ese código → marca enabled_at = NOW().
//
// IMPORTANTE: los recovery codes SE MUESTRAN UNA SOLA VEZ. Si el user
// cierra la pantalla sin copiarlos, no se vuelven a mostrar — tiene que
// pedir /regenerate-recovery después.

import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { twoFa } from '../lib/api.js';
import { Btn } from './primitives/index.jsx';

export default function TwoFaSetup({ onDone, onCancel, onError }) {
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
      .then((data) => {
        setSetupData(data);
        setStep('scan');
      })
      .catch((err) => {
        onError?.(err.message || 'No se pudo iniciar el setup de 2FA.');
        onCancel?.();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Renderizar el QR cuando setupData esté listo.
  useEffect(() => {
    if (!setupData || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, setupData.otpauth_uri, {
      width: 220,
      margin: 1,
      color: { dark: '#0a0e18', light: '#ffffff' },
    }).catch((err) => {
      // Si el QR falla el user todavía puede usar el secret manual.
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
      // Delay corto para que el user vea el check verde antes del refresh.
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
      onError?.('No se pudo copiar al portapapeles. Copialo a mano.');
    }
  }

  if (step === 'loading' || !setupData) {
    return (
      <div className="card u-p-40-text-center">
        <div className="muted">Generando código de seguridad…</div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="card u-p-40-text-center">
        <div className="u-checkmark-circle-pos">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h3 className="u-m-0-0-8">2FA activado</h3>
        <div className="muted u-fs-13">
          Desde ahora vas a necesitar tu código al loguearte.
        </div>
      </div>
    );
  }

  return (
    <div className="card u-p-20">
      <h3 className="u-mt-0">Activar autenticación de dos factores</h3>
      <div className="muted u-mb-18-fs-13">
        Necesitás una app autenticadora en tu cel: Google Authenticator,
        Authy, 1Password o cualquier otra compatible con TOTP.
      </div>

      {/* ── Paso 1: QR + secret manual ── */}
      <div className="u-mb-24">
        <div className="u-fs-12-fw-600-color-text-mb-8">
          Paso 1 — Escaneá el QR con tu app autenticadora
        </div>
        <div className="u-qr-panel">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Código QR de activación 2FA. Si no podés escanearlo, usá el código manual de abajo."
            className="u-flex-shrink-0-r-4-bg-white"
          />
          <div className="u-flex-1-minw-0">
            <div className="muted u-mb-6-fs-12">
              ¿No podés escanear? Ingresá este código manualmente:
            </div>
            <div
              data-testid="twofa-secret"
              className="u-secret-display"
            >
              {setupData.secret}
            </div>
            <Btn
              kind="ghost"
              onClick={() => copyToClipboard(setupData.secret, 'secret')}
              aria-live="polite"
            >
              {copiedSecret ? '✓ Copiado' : 'Copiar código'}
            </Btn>
          </div>
        </div>
      </div>

      {/* ── Paso 2: Recovery codes ── */}
      <div className="u-mb-24">
        <div className="u-fs-12-fw-600-color-text-mb-8">
          Paso 2 — Guardá estos recovery codes ⚠️
        </div>
        <div className="u-warn-box">
          <div className="u-fs-12-mb-10-lh-15">
            Si perdés tu cel, podés usar uno de estos códigos (una sola vez cada uno)
            para entrar al portal. <strong>Guardalos en un lugar seguro</strong> —
            password manager, papel impreso, etc. No se vuelven a mostrar.
          </div>
          <div className="u-recovery-grid">
            {setupData.recovery_codes.map((c, i) => (
              <div key={i} className="u-recovery-code">{c}</div>
            ))}
          </div>
          <Btn
            kind="ghost"
            onClick={() => copyToClipboard(setupData.recovery_codes.join('\n'), 'recovery')}
            aria-live="polite"
          >
            {copiedRecovery ? '✓ Copiados' : 'Copiar los 8 codes'}
          </Btn>
        </div>
      </div>

      {/* ── Paso 3: Verificación ── */}
      <form onSubmit={handleEnable}>
        <div className="u-mb-12">
          <label
            htmlFor="twofa-verify-code"
            className="u-form-label-strong"
          >
            Paso 3 — Ingresá el código de 6 dígitos de tu app
          </label>
          <input
            id="twofa-verify-code"
            type="text"
            inputMode="numeric"
            placeholder="123456"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="u-totp-input"
            disabled={step === 'verifying'}
          />
        </div>
        {error && (
          <div role="alert" className="u-error-inline">{error}</div>
        )}
        <div className="flex u-gap-8-mt-14-end">
          <Btn kind="ghost" onClick={onCancel} disabled={step === 'verifying'}>
            Cancelar
          </Btn>
          <Btn
            type="submit"
            variant="primary"
            disabled={step === 'verifying' || code.length !== 6}
          >
            {step === 'verifying' ? 'Verificando…' : 'Activar 2FA'}
          </Btn>
        </div>
      </form>
    </div>
  );
}
