// TwoFaSection — sección de seguridad para el screen Config.
//
// Estados visibles:
//   · Cargando: spinner hasta tener el status.
//   · NO configurado: hint + botón "Activar 2FA" → muestra TwoFaSetup.
//   · Activado: status con check + 2 acciones (Desactivar, Regenerar recovery codes).
//
// Las acciones de "Desactivar" y "Regenerar" piden código TOTP/recovery via
// prompt simple (no modal completo) — son flows cortos. Si en el futuro
// se vuelve más complejo, extraer a modal.

import { useState, useEffect } from 'react';
import { twoFa } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { fmtFecha } from '../lib/format';
import TwoFaSetup from './TwoFaSetup';

export default function TwoFaSection() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState(null);

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
      message: 'Vas a desactivar la autenticación de dos factores. Ingresá tu código actual de 6 dígitos para confirmar.',
      confirmLabel: 'Continuar',
    });
    if (!ok) return;
    const code = prompt('Ingresá tu código actual (6 dígitos) o un recovery code:');
    if (!code) return;
    try {
      await twoFa.disable(code.trim());
      toast.success('2FA desactivado.');
      refresh();
    } catch (err) {
      toast.error(err.message || 'No se pudo desactivar 2FA');
    }
  }

  async function handleRegenerateRecovery() {
    const ok = await confirm({
      title: 'Regenerar recovery codes',
      message: 'Vas a generar 8 nuevos recovery codes. Los anteriores quedarán invalidados. Ingresá tu código actual para confirmar.',
      confirmLabel: 'Continuar',
    });
    if (!ok) return;
    const code = prompt('Ingresá tu código actual (6 dígitos) o un recovery code:');
    if (!code) return;
    try {
      const { recovery_codes } = await twoFa.regenerateRecovery(code.trim());
      setNewRecoveryCodes(recovery_codes);
      toast.success('Nuevos recovery codes generados. Guardalos.');
      refresh();
    } catch (err) {
      toast.error(err.message || 'No se pudo regenerar recovery codes');
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
                  <span style={{ color: 'var(--warn)' }}>{' '}⚠️ Te quedan pocos. Considerá regenerarlos.</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex-row" style={{ gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={handleRegenerateRecovery}>
              Regenerar recovery codes
            </button>
            <button className="btn btn-sm" style={{ color: 'var(--neg)' }} onClick={handleDisable}>
              Desactivar 2FA
            </button>
          </div>
        </div>

        {newRecoveryCodes && (
          <div className="card card-tight" style={{
            padding: 14, background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
          }}>
            <div className="field-label" style={{ marginBottom: 8 }}>
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
            <div className="flex-row" style={{ gap: 8 }}>
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
      </div>
    );
  }

  // ── Estado NO configurado ──
  return (
    <div className="card card-tight" style={{ padding: 18 }}>
      <div className="flex-row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span className="badge badge-default">No activado</span>
        <strong>Autenticación de dos factores</strong>
      </div>
      <div className="muted tiny" style={{ lineHeight: 1.5, marginBottom: 14 }}>
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
