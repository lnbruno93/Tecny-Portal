// Mi cuenta — pantalla de gestión de la cuenta del super-admin (task #498).
//
// Cierra el gap que arrastraba el back office: el super-admin tenía que
// salir de admin.tecnyapp.com y entrar al portal principal
// (app.tecnyapp.com/config) para activar 2FA o cambiar su password. Los
// endpoints backend /api/auth/2fa/* y /api/auth/change-password ya estaban
// hechos para ser shared (no exigen super-admin) — sólo faltaba la UI acá.
//
// Estructura:
//   · PageHead con label "Cuenta"
//   · Segmented control con 2 tabs: Seguridad · Perfil
//   · Tab Seguridad: TwoFaSection + card "Cambiar contraseña"
//   · Tab Perfil: read-only con username, email (si viene) y flag super-admin
//
// URL state: el tab activo se preserva en el query string (?tab=seguridad|perfil).
// Esto permite que Resumen.jsx linkee directo a /mi-cuenta?tab=seguridad
// cuando muestra el banner "necesitás activar 2FA".

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { PageHead, Card, Badge, Btn, Seg } from '../components/primitives/index.jsx';
import TwoFaSection from '../components/TwoFaSection.jsx';
import ChangePasswordModal from '../components/ChangePasswordModal.jsx';

const TAB_OPTIONS = [
  { value: 'seguridad', label: 'Seguridad' },
  { value: 'perfil',    label: 'Perfil' },
];

export default function MiCuenta() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Tab activo desde URL. Default: seguridad (el caso más frecuente:
  // Lucas viene de Resumen queriendo activar 2FA). Validamos contra el
  // set conocido — si viene un valor raro (?tab=lolo) caemos al default
  // en lugar de dejar el UI en un estado inconsistente.
  const rawTab = searchParams.get('tab');
  const tab = TAB_OPTIONS.some((t) => t.value === rawTab) ? rawTab : 'seguridad';

  const [message, setMessage] = useState(null); // { type: 'success'|'error', text }
  const [changePwOpen, setChangePwOpen] = useState(false);

  function changeTab(next) {
    // Preservamos otros query params por si en el futuro sumamos más
    // (ej. ?tab=perfil&highlight=email). Hoy sólo cambia tab.
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
    // Limpiar mensaje al cambiar de tab — evita que un banner de éxito
    // de 2FA quede visible cuando el user pasa a Perfil.
    setMessage(null);
  }

  const displayName = user?.username || user?.email || 'Admin';

  return (
    <>
      <PageHead
        label="Cuenta"
        title="Mi cuenta"
        subtitle="Gestioná tu contraseña, 2FA y datos personales."
      />

      <div className="u-mb-var-gap">
        <Seg
          value={tab}
          options={TAB_OPTIONS}
          onChange={changeTab}
        />
      </div>

      {/* Banner global de mensajes que emiten los sub-componentes
          (TwoFaSection). Se muestra siempre encima del tab activo. */}
      {message && (
        <div
          role={message.type === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`u-mc-msg ${message.type === 'error' ? 'u-mc-msg-error' : 'u-mc-msg-success'}`}
        >
          <span>{message.text}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            aria-label="Cerrar mensaje"
            className="u-mc-msg-close"
          >
            ×
          </button>
        </div>
      )}

      {tab === 'seguridad' && (
        <div className="u-flex-col-gap-var">
          <TwoFaSection onMessage={setMessage} />

          <Card
            title="Contraseña"
            subtitle="Cambiala periódicamente. Vamos a cerrar tu sesión después del cambio."
          >
            <div className="muted u-mc-policy">
              La política requiere mínimo 8 caracteres con letra y número.
              Si tenés 2FA activo te vamos a pedir el código al cambiar.
            </div>
            <Btn kind="primary" onClick={() => setChangePwOpen(true)}>
              Cambiar contraseña
            </Btn>
          </Card>
        </div>
      )}

      {tab === 'perfil' && (
        <Card
          title="Datos personales"
          subtitle="Read-only por ahora — ver nota abajo."
        >
          <div className="u-mc-datos-grid">
            <div className="muted">Usuario</div>
            <div className="u-fw-600">{displayName}</div>

            {user?.email && (
              <>
                <div className="muted">Email</div>
                <div>{user.email}</div>
              </>
            )}

            <div className="muted">Rol</div>
            <div>
              {user?.is_super_admin
                ? <Badge tone="pos">Super-admin</Badge>
                : <Badge>Sin permisos</Badge>}
            </div>
          </div>

          <div className="muted u-mc-info-box">
            Para cambiar tu email o username, contactá al equipo técnico —
            el back office no expone esas mutations al super-admin porque
            impactan en JWT/tokens ya emitidos. Password y 2FA sí los
            gestionás desde acá.
          </div>
        </Card>
      )}

      <ChangePasswordModal
        open={changePwOpen}
        onClose={() => setChangePwOpen(false)}
        onSuccess={() => {
          // El modal ya dispara logout post-éxito con delay; acá no hay
          // cleanup adicional que hacer.
        }}
      />
    </>
  );
}
