// ShareLinkPanel.jsx — Panel del operador para gestionar el share link
// público de Equipos Usados (2026-07-11).
//
// Se renderiza como card dentro del tab "Equipos usados" (arriba de los
// KPIs). Encapsula el flow completo:
//   - Fetch inicial de la config + stats.
//   - Copiar link al clipboard.
//   - Compartir por WhatsApp Web (link con texto pre-armado).
//   - Editar WhatsApp de contacto, mensaje extra, toggles (batería/precio).
//   - Rotar token (confirm dialog).
//   - Activar/Desactivar (toggle rápido).
//   - Mostrar stats (vistas último mes, únicos hoy, último acceso).

import { useEffect, useState, useCallback } from 'react';
import { Icons } from '../components/Icons';
import { inventario } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// Construye la URL pública absoluta a partir del token. Usa el origin
// actual (funciona en dev, staging y prod sin config extra).
function buildPublicUrl(token) {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/publico/usados/${token}`;
}

// Formato humano de "último acceso" para el card de stats.
function fmtUltimoAcceso(iso) {
  if (!iso) return 'sin visitas aún';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const dias = Math.floor(diff / 86400000);
  if (dias >= 1) return `hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
  if (hrs >= 1)  return `hace ${hrs} ${hrs === 1 ? 'hora' : 'horas'}`;
  if (mins >= 1) return `hace ${mins} min`;
  return 'recién';
}

export default function ShareLinkPanel() {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [link, setLink] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form fields — inicializados desde `link` cuando llega.
  const [whatsapp, setWhatsapp] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [mostrarBateria, setMostrarBateria] = useState(true);
  const [mostrarPrecio, setMostrarPrecio] = useState(true);

  // Estado UI: expandir/colapsar el panel. Por default arrancamos colapsado
  // para no ocupar espacio en el tab si el operador no lo usa.
  const [abierto, setAbierto] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await inventario.shareLink.get();
      setLink(r);
      setWhatsapp(r.whatsapp || '');
      setMensaje(r.mensaje_extra || '');
      setMostrarBateria(r.mostrar_bateria);
      setMostrarPrecio(r.mostrar_precio);
    } catch (e) {
      toast.error(`No se pudo cargar el link público: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const publicUrl = link ? buildPublicUrl(link.token) : '';

  const onCopy = useCallback(async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Link copiado al portapapeles');
    } catch {
      toast.error('No se pudo copiar. Copialo manualmente.');
    }
  }, [publicUrl, toast]);

  const onShareWA = useCallback(() => {
    if (!publicUrl) return;
    const msg = `Mirá el listado de usados disponibles: ${publicUrl}`;
    const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [publicUrl]);

  const onSave = useCallback(async () => {
    setSaving(true);
    try {
      const updated = await inventario.shareLink.update({
        whatsapp:        whatsapp,
        mensaje_extra:   mensaje,
        mostrar_bateria: mostrarBateria,
        mostrar_precio:  mostrarPrecio,
      });
      setLink(prev => ({ ...prev, ...updated }));
      toast.success('Cambios guardados');
    } catch (e) {
      toast.error(`No se pudo guardar: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [whatsapp, mensaje, mostrarBateria, mostrarPrecio, toast]);

  const onToggleActivo = useCallback(async () => {
    if (!link) return;
    const nuevo = !link.activo;
    const ok = await confirm({
      title:   nuevo ? 'Reactivar link público' : 'Desactivar link público',
      body:    nuevo
        ? 'El link vuelve a estar disponible para clientes que lo tengan guardado.'
        : 'Los clientes que abran el link van a ver "Este listado ya no está disponible". Podés reactivarlo cuando quieras.',
      danger:  !nuevo,
      confirm: nuevo ? 'Reactivar' : 'Desactivar',
    });
    if (!ok) return;
    try {
      const updated = await inventario.shareLink.update({ activo: nuevo });
      setLink(prev => ({ ...prev, ...updated }));
      toast.success(nuevo ? 'Link reactivado' : 'Link desactivado');
    } catch (e) {
      toast.error(`No se pudo actualizar: ${e?.message || e}`);
    }
  }, [link, confirm, toast]);

  const onRotate = useCallback(async () => {
    const ok = await confirm({
      title:   'Rotar token del link',
      body:    'Se genera un nuevo link. Los clientes que tengan guardado el link viejo van a ver "Listado no encontrado". Vas a tener que enviar el link nuevo. ¿Continuar?',
      danger:  true,
      confirm: 'Rotar token',
    });
    if (!ok) return;
    try {
      const updated = await inventario.shareLink.rotate();
      setLink(prev => ({ ...prev, ...updated }));
      toast.success('Token nuevo generado. Link viejo invalidado.');
    } catch (e) {
      toast.error(`No se pudo rotar: ${e?.message || e}`);
    }
  }, [confirm, toast]);

  if (loading) {
    return (
      <div className="card card-tight u-mb-16">
        <div className="muted tiny">Cargando link público…</div>
      </div>
    );
  }
  if (!link) return null;

  const stats = link.stats || {};

  return (
    <div className="card" style={{ marginBottom: 16, padding: '14px 16px' }}>
      {/* Header colapsable */}
      <button
        type="button"
        onClick={() => setAbierto(v => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'inherit',
          textAlign: 'left',
        }}
        aria-expanded={abierto}
      >
        <span style={{ fontSize: 18 }}>🔗</span>
        <div className="u-flex-1">
          <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            Link público de equipos usados
            <span
              className={`badge ${link.activo ? 'badge-pos' : ''}`}
              style={{ fontSize: 11, fontWeight: 500 }}
            >
              {link.activo ? 'Activo' : 'Desactivado'}
            </span>
          </div>
          <div className="muted tiny u-mt-2">
            Compartilo por WhatsApp — se actualiza en tiempo real desde tu inventario.
          </div>
        </div>
        <Icons.ChevronDown
          size={16}
          style={{
            transition: 'transform 0.2s',
            transform: abierto ? 'rotate(180deg)' : 'rotate(0)',
            opacity: 0.6,
          }}
        />
      </button>

      {abierto && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          {/* URL box con acciones */}
          <div className="flex-row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              className="input mono"
              value={publicUrl}
              readOnly
              onClick={e => e.target.select()}
              style={{ flex: 1, minWidth: 240, fontSize: 12 }}
            />
            <button className="btn btn-sm btn-primary" onClick={onCopy}>
              <Icons.Copy size={13} /> Copiar
            </button>
            <button className="btn btn-sm" onClick={onShareWA}>
              💬 Compartir
            </button>
          </div>

          {/* Config: whatsapp + mensaje */}
          <div className="row u-mb-14">
            <div className="field u-flex-1">
              <label className="field-label">WhatsApp de contacto (opcional)</label>
              <input
                className="input"
                placeholder="+54 9 11 4567-8901"
                value={whatsapp}
                onChange={e => setWhatsapp(e.target.value)}
                maxLength={40}
              />
              <span className="muted tiny">
                Aparece en el pie del listado. Si lo dejás vacío no se muestra botón WhatsApp.
              </span>
            </div>
            <div className="field u-flex-1">
              <label className="field-label">Mensaje adicional (opcional)</label>
              <input
                className="input"
                placeholder="Consultá por financiación"
                value={mensaje}
                onChange={e => setMensaje(e.target.value)}
                maxLength={200}
              />
              <span className="muted tiny">
                Se muestra debajo del título. Máximo 200 caracteres.
              </span>
            </div>
          </div>

          {/* Toggles */}
          <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="flex-row" style={{ gap: 10, cursor: 'pointer', padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
              <input
                type="checkbox"
                checked={mostrarBateria}
                onChange={e => setMostrarBateria(e.target.checked)}
              />
              <div className="u-flex-1">
                <div style={{ fontSize: 13, fontWeight: 500 }}>Mostrar batería del equipo</div>
                <div className="muted tiny">Si preferís no mostrarla al público, apagalo.</div>
              </div>
            </label>
            <label className="flex-row" style={{ gap: 10, cursor: 'pointer', padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
              <input
                type="checkbox"
                checked={mostrarPrecio}
                onChange={e => setMostrarPrecio(e.target.checked)}
              />
              <div className="u-flex-1">
                <div style={{ fontSize: 13, fontWeight: 500 }}>Mostrar precio de venta</div>
                <div className="muted tiny">Apagalo si preferís que consulten por WhatsApp. El equipo sale igual pero sin monto.</div>
              </div>
            </label>
          </div>

          {/* Stats */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 10,
              padding: 10,
              background: 'var(--surface-2)',
              borderRadius: 8,
              marginBottom: 14,
            }}
          >
            <div className="u-text-center">
              <div style={{ fontSize: 20, fontWeight: 700 }}>{stats.vistas_ult_mes ?? 0}</div>
              <div className="muted tiny">Vistas último mes</div>
            </div>
            <div className="u-text-center">
              <div style={{ fontSize: 20, fontWeight: 700 }}>{stats.unicos_hoy ?? 0}</div>
              <div className="muted tiny">Únicos hoy</div>
            </div>
            <div className="u-text-center">
              <div style={{ fontSize: 14, fontWeight: 600, paddingTop: 6 }}>
                {fmtUltimoAcceso(stats.ultimo_acceso)}
              </div>
              <div className="muted tiny">Último acceso</div>
            </div>
          </div>

          {/* Acciones */}
          <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div className="flex-row u-gap-8-flex-wrap">
              <button className="btn btn-sm btn-primary" onClick={onSave} disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar cambios'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={onRotate} title="Genera un token nuevo, el link viejo queda inválido">
                🔄 Rotar token
              </button>
            </div>
            <button
              className={`btn btn-sm btn-ghost`}
              style={link.activo ? { color: 'var(--neg)' } : {}}
              onClick={onToggleActivo}
              title={link.activo ? 'Desactivar el link — clientes ven mensaje "no disponible"' : 'Reactivar el link'}
            >
              {link.activo ? '⏸ Desactivar link' : '▶ Reactivar link'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
