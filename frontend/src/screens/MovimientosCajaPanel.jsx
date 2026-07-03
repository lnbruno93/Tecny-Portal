// Panel Movimientos de Caja — historial + alta de transferencias entre cajas
// propias del negocio. Feature #505. Vive como segundo tab de la pantalla
// Egresos (ver Egresos.jsx). Backend: /api/caja-transferencias.
//
// Reglas de negocio:
//   - Solo transfiere entre cajas de la MISMA moneda. Cambio de moneda va por
//     "Cambios de Divisa" (financiera externa).
//   - `costo` opcional: comisión bancaria que sale de la caja origen ADEMÁS del
//     monto que llega al destino.
//   - No es editable — solo crear + eliminar (patrón consistente con Egresos y
//     Cambios).
//   - Al eliminar: reversa los 2 asientos del ledger. Si eso dejaría alguna
//     caja negativa, el backend responde 409 y no borra.

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { cajas as cajasApi, cajaTransferencias } from '../lib/api';
import { fmt, fmtFecha, fmtMoney } from '../lib/format';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { Icons } from '../components/Icons';
import { blockInvalidNumberKeys } from '../lib/inputUtils';
import useModal from '../lib/useModal';

const HOY = new Date().toISOString().split('T')[0];

// Grupo de moneda: USD/USDT son 1:1 (mismo grupo); ARS y UYU son grupos
// separados. Sirve para filtrar el select de caja destino según la caja origen
// elegida (evita error 400 en el submit).
function grupoMoneda(m) {
  if (m === 'ARS')  return 'ARS';
  if (m === 'UYU')  return 'UYU';
  return 'USD'; // USD y USDT
}

export default function MovimientosCajaPanel() {
  const toast   = useToast();
  const confirm = useConfirm();

  const [transferencias, setTransferencias] = useState([]);
  const [cajasList, setCajasList] = useState([]);
  const [loading, setLoading]     = useState(true);

  // Modal Nueva Transferencia. `form` es la fuente de verdad de "está abierto"
  // (null = cerrado). useModal recibe el flag y agrega Esc, scroll-lock,
  // focus-trap y restore-focus — es un hook side-effect, NO devuelve state.
  const [form, setForm] = useState(null);
  const overlayRef = useRef(null);
  const cerrarModal = useCallback(() => setForm(null), []);
  useModal({ open: form != null, onClose: cerrarModal, overlayRef });
  const abrirModal = () => {
    setForm({
      fecha: HOY,
      caja_origen_id: '',
      caja_destino_id: '',
      monto: '',
      costo: '',
      descripcion: '',
    });
  };

  // useCallback: necesario para que el useEffect pueda depender de `cargar`
  // sin recrear el efecto en cada render (React Compiler rule
  // react-hooks/exhaustive-deps + react-hooks/set-state-in-effect).
  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const [tr, cs] = await Promise.all([
        cajaTransferencias.list({ limit: 100 }),
        cajasApi.listCajas(),
      ]);
      setTransferencias(tr.data || []);
      setCajasList((cs || []).filter(c => !c.deleted_at));
    } catch (e) {
      toast.error(e.message || 'Error al cargar movimientos');
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { cargar(); }, [cargar]);

  // Origen y destino disponibles según la moneda. Cuando cambia origen, si
  // destino ya no es válido (grupo distinto) lo limpiamos para evitar submit
  // inválido.
  const cajaOrigen = form ? cajasList.find(c => String(c.id) === String(form.caja_origen_id)) : null;
  const monedaOrigen = cajaOrigen?.moneda || null;
  // El compilador React infiere `form.caja_origen_id` como dep — usamos `form`
  // completo para evitar mismatch entre inferred vs source deps
  // (react-hooks/preserve-manual-memoization). El early-return de `monedaOrigen`
  // ya garantiza que dentro del filter form nunca sea null.
  const destinoOpts = useMemo(() => {
    if (!monedaOrigen) return [];
    const g = grupoMoneda(monedaOrigen);
    return cajasList.filter(c =>
      String(c.id) !== String(form.caja_origen_id) && grupoMoneda(c.moneda) === g
    );
  }, [cajasList, form, monedaOrigen]);

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function setOrigen(id) {
    setForm(f => {
      const nuevoOrigen = cajasList.find(c => String(c.id) === String(id));
      const g = nuevoOrigen ? grupoMoneda(nuevoOrigen.moneda) : null;
      const destinoActual = cajasList.find(c => String(c.id) === String(f.caja_destino_id));
      const destinoValido = destinoActual && grupoMoneda(destinoActual.moneda) === g && String(destinoActual.id) !== String(id);
      return { ...f, caja_origen_id: id, caja_destino_id: destinoValido ? f.caja_destino_id : '' };
    });
  }

  async function guardar() {
    if (!form.caja_origen_id)  return toast.error('Elegí la caja de origen.');
    if (!form.caja_destino_id) return toast.error('Elegí la caja de destino.');
    if (!(Number(form.monto) > 0)) return toast.error('El monto debe ser mayor a 0.');
    if (form.costo && Number(form.costo) < 0) return toast.error('El costo no puede ser negativo.');

    // La moneda del movimiento se toma de la caja origen — el backend valida
    // que ambas cajas coincidan en grupo.
    const payload = {
      fecha: form.fecha,
      caja_origen_id: Number(form.caja_origen_id),
      caja_destino_id: Number(form.caja_destino_id),
      moneda: cajaOrigen.moneda,
      monto: Number(form.monto),
      costo: form.costo ? Number(form.costo) : 0,
      descripcion: form.descripcion.trim() || null,
    };
    try {
      await cajaTransferencias.create(payload);
      toast.success('Transferencia registrada.');
      cerrarModal();
      cargar();
    } catch (e) {
      toast.error(e.message || 'No se pudo registrar la transferencia.');
    }
  }

  async function eliminar(t) {
    const ok = await confirm({
      title: 'Eliminar transferencia',
      message: `¿Eliminar la transferencia del ${fmtFecha(t.fecha)} de ${t.caja_origen_nombre} a ${t.caja_destino_nombre} por ${fmtMoney(t.monto, t.moneda)}? Se reversan los movimientos en las 2 cajas.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await cajaTransferencias.delete(t.id);
      toast.success('Transferencia eliminada.');
      cargar();
    } catch (e) {
      toast.error(e.message || 'No se pudo eliminar.');
    }
  }

  return (
    <div>
      {/* Toolbar del tab */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13, maxWidth: 620 }}>
          Traslados internos entre <strong>2 cajas propias</strong> de la misma moneda
          (ej. retiro banco USD → efectivo USD). No modifica tu patrimonio total.
          Para cambios de moneda usá <strong>Cambios de Divisa</strong>.
        </p>
        <button className="btn btn-primary" onClick={abrirModal}>
          <Icons.Plus size={14} /> Nueva transferencia
        </button>
      </div>

      {/* Tabla / historial */}
      {loading ? (
        <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Cargando…</div>
      ) : transferencias.length === 0 ? (
        <div className="empty-state" style={{ padding: 32, textAlign: 'center', border: '1px dashed var(--hairline)', borderRadius: 8 }}>
          <div className="muted" style={{ fontSize: 14 }}>Todavía no hay transferencias.</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Cuando muevas plata entre 2 cajas propias, van a quedar registradas acá.
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Origen</th>
                <th>Destino</th>
                <th style={{ textAlign: 'right' }}>Monto</th>
                <th style={{ textAlign: 'right' }}>Costo</th>
                <th>Descripción</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {transferencias.map(t => (
                <tr key={t.id}>
                  <td className="mono">{fmtFecha(t.fecha)}</td>
                  <td>{t.caja_origen_nombre || '—'}</td>
                  <td>{t.caja_destino_nombre || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                    {fmtMoney(t.monto, t.moneda)}
                  </td>
                  <td className="mono" style={{ textAlign: 'right', color: Number(t.costo) > 0 ? 'var(--neg)' : 'var(--text-muted)' }}>
                    {Number(t.costo) > 0 ? fmtMoney(t.costo, t.moneda) : '—'}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{t.descripcion || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="icon-btn" onClick={() => eliminar(t)} title="Eliminar transferencia">
                      <Icons.Trash size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Nueva Transferencia.
          Clases del portal: modal-overlay + modal-hd + modal-ft (no
          "backdrop/head/foot" — el CSS solo define las primeras). Header
          usa <h3> con id + aria-labelledby para lector de pantalla, y el
          click-outside chequea currentTarget para que clicks dentro del
          modal no lo cierren. Mismo patrón que EgresosPanel / Inventario /
          Ventas. */}
      {form && (
        <div
          ref={overlayRef}
          className="modal-overlay"
          onClick={e => e.target === e.currentTarget && cerrarModal()}
        >
          <div
            className="modal"
            style={{ maxWidth: 520 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mov-caja-modal-title"
          >
            <div className="modal-hd">
              <h3 id="mov-caja-modal-title">Nueva transferencia</h3>
              <button type="button" className="icon-btn" onClick={cerrarModal} aria-label="Cerrar" title="Cerrar">
                <Icons.X size={16} />
              </button>
            </div>

            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div className="field">
                <label className="field-label">Fecha</label>
                <input type="date" className="input" value={form.fecha} onChange={e => setF('fecha', e.target.value)} />
              </div>

              <div className="field">
                <label className="field-label">Caja de origen</label>
                <select className="input" value={form.caja_origen_id} onChange={e => setOrigen(e.target.value)}>
                  <option value="">— Elegí caja —</option>
                  {cajasList.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.nombre} · {c.moneda}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="field-label">
                  Caja de destino
                  {monedaOrigen && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                      (solo cajas {grupoMoneda(monedaOrigen)})
                    </span>
                  )}
                </label>
                <select
                  className="input"
                  value={form.caja_destino_id}
                  onChange={e => setF('caja_destino_id', e.target.value)}
                  disabled={!form.caja_origen_id}
                >
                  <option value="">— Elegí caja —</option>
                  {destinoOpts.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.nombre} · {c.moneda}
                    </option>
                  ))}
                </select>
                {form.caja_origen_id && destinoOpts.length === 0 && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    No hay otra caja de la misma moneda. Necesitás crear una en Cajas → Config.
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field">
                  <label className="field-label">Monto {monedaOrigen ? `(${monedaOrigen})` : ''}</label>
                  <input
                    type="number" onKeyDown={blockInvalidNumberKeys}
                    className="input mono" placeholder="0"
                    value={form.monto} onChange={e => setF('monto', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">
                    Costo <span className="muted" style={{ fontSize: 11 }}>(opcional)</span>
                  </label>
                  <input
                    type="number" onKeyDown={blockInvalidNumberKeys}
                    className="input mono" placeholder="0"
                    value={form.costo} onChange={e => setF('costo', e.target.value)}
                  />
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: -6 }}>
                El costo (ej. comisión bancaria) sale de la caja de origen además del monto.
                El destino recibe solo el monto.
              </div>

              <div className="field">
                <label className="field-label">Descripción <span className="muted" style={{ fontSize: 11 }}>(opcional)</span></label>
                <input
                  className="input"
                  placeholder="Ej. Retiro banco → efectivo del día"
                  value={form.descripcion}
                  onChange={e => setF('descripcion', e.target.value)}
                  maxLength={1000}
                />
              </div>

              {/* Resumen del impacto para que el operador sepa qué va a pasar */}
              {form.caja_origen_id && form.caja_destino_id && form.monto && (
                <div style={{
                  padding: 10, borderRadius: 6, fontSize: 12,
                  background: 'rgba(59, 130, 246, 0.08)',
                  border: '1px solid rgba(59, 130, 246, 0.28)',
                }}>
                  <div><strong>Sale de origen:</strong> {fmt(Number(form.monto) + Number(form.costo || 0))} {monedaOrigen}</div>
                  <div><strong>Entra al destino:</strong> {fmt(form.monto)} {monedaOrigen}</div>
                  {Number(form.costo) > 0 && <div className="muted">Costo (comisión): {fmt(form.costo)} {monedaOrigen}</div>}
                </div>
              )}
            </div>

            <div className="modal-ft">
              <button type="button" className="btn btn-ghost" onClick={cerrarModal}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={guardar}>Registrar transferencia</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
