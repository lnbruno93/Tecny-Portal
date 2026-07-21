// Panel Movimientos de Caja — historial + alta de transferencias entre cajas
// propias del negocio. Feature #505. Vive como segundo tab de la pantalla
// Egresos (ver Egresos.jsx). Backend: /api/caja-transferencias.
//
// Reglas de negocio:
//   - Same-currency: transferencia entre 2 cajas del mismo grupo (ARS↔ARS,
//     UYU↔UYU, USD↔USD/USDT). Un solo monto, sin TC.
//   - Cross-currency (2026-07-13): transferencia entre 2 cajas de grupos
//     distintos con TC tipeado por el operador. Ejemplo canónico:
//       Banco Pesos ARS baja $1.500.000
//       Banco Dólar USD sube USD 1.500
//       TC = 1000
//     El monto destino se auto-calcula del TC pero es editable (por
//     redondeo de la financiera).
//   - `costo` opcional: comisión bancaria que sale de la caja origen ADEMÁS del
//     monto que llega al destino. Se aplica en ambos modos, en moneda origen.
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
  // Bug pre-live (Sentry, jul-2026): `const toast = useToast()` capturaba el
  // objeto contexto entero `{ toast }`, no el helper con `.error`/`.success`.
  // Cualquier click en "Registrar transferencia" o "Eliminar" crasheaba con
  // "Cannot read properties of undefined (reading 'error')". Todo el resto
  // del portal destructura `const { toast } = useToast()` — este era el
  // único caller con el patrón roto. Ver ToastContext.jsx:81-85.
  const { toast } = useToast();
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
      // 2026-07-13 (cross-currency): campos opcionales. El operador los
      // completa cuando origen/destino son de grupos distintos. `montoDestinoManual`
      // es un flag: si true, el operador editó el monto destino manualmente
      // y NO auto-recalculamos al cambiar TC/monto (respeta redondeo).
      tc: '',
      monto_destino: '',
      montoDestinoManual: false,
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

  // Cajas origen/destino resueltas del state actual.
  const cajaOrigen  = form ? cajasList.find(c => String(c.id) === String(form.caja_origen_id))  : null;
  const cajaDestino = form ? cajasList.find(c => String(c.id) === String(form.caja_destino_id)) : null;
  const monedaOrigen  = cajaOrigen?.moneda  || null;
  const monedaDestino = cajaDestino?.moneda || null;
  // 2026-07-13: el select destino AHORA muestra TODAS las cajas (menos la de
  // origen). Antes filtrábamos solo mismo grupo; ahora que soportamos cross-
  // currency el operador puede elegir cualquier caja y aparece el campo TC.
  const destinoOpts = useMemo(() => {
    if (!form?.caja_origen_id) return [];
    return cajasList.filter(c => String(c.id) !== String(form.caja_origen_id));
  }, [cajasList, form]);

  // Cross-currency: cajas de grupos distintos → aparece la sección TC.
  const isCross = monedaOrigen && monedaDestino && grupoMoneda(monedaOrigen) !== grupoMoneda(monedaDestino);

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function setOrigen(id) {
    setForm(f => {
      const destinoActual = cajasList.find(c => String(c.id) === String(f.caja_destino_id));
      // Si el nuevo origen es igual al destino actual, limpiar destino.
      const conflicto = destinoActual && String(destinoActual.id) === String(id);
      return {
        ...f,
        caja_origen_id: id,
        caja_destino_id: conflicto ? '' : f.caja_destino_id,
        // Al cambiar origen invalidamos monto_destino manual (moneda destino
        // puede cambiar y el número ya no aplica).
        montoDestinoManual: false,
      };
    });
  }

  // 2026-07-13: al cambiar TC o monto, auto-calcular monto_destino (a menos
  // que el operador lo haya editado a mano — flag montoDestinoManual).
  // Fórmula: USD siempre es la base. Si origen es USD y destino es fiat →
  // monto_destino = monto * tc. Si origen es fiat y destino USD → monto/tc.
  // ARS↔UYU cross no está soportado (edge case raro, requiere 2 TCs).
  function calcularMontoDestino(monto, tc, mOrigen, mDestino) {
    const m = Number(monto), t = Number(tc);
    if (!m || !t || t <= 0 || !mOrigen || !mDestino) return '';
    const gO = grupoMoneda(mOrigen);
    const gD = grupoMoneda(mDestino);
    if (gO === 'USD' && gD !== 'USD') return String(Math.round(m * t * 100) / 100); // USD→ARS/UYU
    if (gO !== 'USD' && gD === 'USD') return String(Math.round((m / t) * 100) / 100); // ARS/UYU→USD
    return ''; // ARS↔UYU no soportado
  }
  function setMontoOrTc(k, v) {
    setForm(f => {
      const next = { ...f, [k]: v };
      if (!next.montoDestinoManual && isCross) {
        const nuevo = calcularMontoDestino(
          k === 'monto' ? v : next.monto,
          k === 'tc' ? v : next.tc,
          monedaOrigen, monedaDestino,
        );
        next.monto_destino = nuevo;
      }
      return next;
    });
  }
  function setMontoDestinoManual(v) {
    setForm(f => ({ ...f, monto_destino: v, montoDestinoManual: true }));
  }

  async function guardar() {
    if (!form.caja_origen_id)  return toast.error('Elegí la caja de origen.');
    if (!form.caja_destino_id) return toast.error('Elegí la caja de destino.');
    if (!(Number(form.monto) > 0)) return toast.error('El monto debe ser mayor a 0.');
    if (form.costo && Number(form.costo) < 0) return toast.error('El costo no puede ser negativo.');

    // 2026-07-13 cross-currency: validaciones adicionales cuando origen/destino
    // son de grupos distintos.
    if (isCross) {
      if (!(Number(form.tc) > 0)) return toast.error('El TC debe ser mayor a 0 para cambio de moneda.');
      if (!(Number(form.monto_destino) > 0)) return toast.error('El monto destino debe ser mayor a 0.');
      // Bloqueo: ARS↔UYU sin USD de por medio no está soportado (requiere 2 TCs).
      const gO = grupoMoneda(monedaOrigen), gD = grupoMoneda(monedaDestino);
      if (gO !== 'USD' && gD !== 'USD') {
        return toast.error(`Cambio ${monedaOrigen}↔${monedaDestino} directo no soportado. Hacé 2 pasos: ${monedaOrigen}→USD y luego USD→${monedaDestino}.`);
      }
    }

    const payload = {
      fecha: form.fecha,
      caja_origen_id: Number(form.caja_origen_id),
      caja_destino_id: Number(form.caja_destino_id),
      moneda: cajaOrigen.moneda,
      monto: Number(form.monto),
      costo: form.costo ? Number(form.costo) : 0,
      descripcion: form.descripcion.trim() || null,
    };
    // Cross-currency: incluir los 3 campos nuevos.
    if (isCross) {
      payload.moneda_destino = cajaDestino.moneda;
      payload.monto_destino  = Number(form.monto_destino);
      payload.tc             = Number(form.tc);
    }
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
          Traslados internos entre <strong>2 cajas propias</strong>. Si son de la misma
          moneda, un solo monto. Si son de distinta moneda (ej. Banco Pesos → Banco Dólar),
          agregás el TC y el monto que efectivamente entra en la caja destino.
        </p>
        <button className="btn btn-primary" onClick={abrirModal}>
          <Icons.Plus size={14} /> Nueva transferencia
        </button>
      </div>

      {/* Tabla / historial */}
      {loading ? (
        <div className="muted u-p-20-text-center">Cargando…</div>
      ) : transferencias.length === 0 ? (
        <div className="empty-state" style={{ padding: 32, textAlign: 'center', border: '1px dashed var(--hairline)', borderRadius: 8 }}>
          <div className="muted u-fs-14">Todavía no hay transferencias.</div>
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
                <th className="u-text-right">Monto</th>
                <th className="u-text-right">Costo</th>
                <th>Descripción</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {transferencias.map(t => {
                // 2026-07-13: si es cross-currency, mostrar los 2 montos con
                // → separador. Sino, el monto simple como siempre.
                const isCross = t.moneda_destino && t.monto_destino;
                return (
                  <tr key={t.id}>
                    <td className="mono">{fmtFecha(t.fecha)}</td>
                    <td>{t.caja_origen_nombre || '—'}</td>
                    <td>{t.caja_destino_nombre || '—'}</td>
                    <td className="mono u-td-right-fw-600">
                      {isCross ? (
                        <span>
                          {fmtMoney(t.monto, t.moneda)}
                          <span className="muted" style={{ fontWeight: 400, margin: '0 4px' }}>→</span>
                          {fmtMoney(t.monto_destino, t.moneda_destino)}
                        </span>
                      ) : (
                        fmtMoney(t.monto, t.moneda)
                      )}
                      {isCross && (
                        <div className="muted" style={{ fontSize: 10, fontWeight: 400 }}>TC {fmt(t.tc)}</div>
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: Number(t.costo) > 0 ? 'var(--neg)' : 'var(--text-muted)' }}>
                      {Number(t.costo) > 0 ? fmtMoney(t.costo, t.moneda) : '—'}
                    </td>
                    <td className="muted u-fs-12">{t.descripcion || '—'}</td>
                    <td className="u-text-right">
                      <button className="icon-btn" onClick={() => eliminar(t)} title="Eliminar transferencia">
                        <Icons.Trash size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
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
            className="modal u-mw-520"
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
                  {isCross && (
                    <span style={{ fontSize: 11, marginLeft: 8, color: 'var(--accent)', fontWeight: 600 }}>
                      · Cambio de moneda {monedaOrigen} → {monedaDestino}
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
              </div>

              <div className="u-grid-1fr-1fr-gap-12">
                <div className="field">
                  <label className="field-label">Monto {monedaOrigen ? `(${monedaOrigen})` : ''}</label>
                  <input
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                    className="input mono" placeholder="0"
                    value={form.monto} onChange={e => setMontoOrTc('monto', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">
                    Costo <span className="muted u-fs-11">(opcional)</span>
                  </label>
                  <input
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                    className="input mono" placeholder="0"
                    value={form.costo} onChange={e => setF('costo', e.target.value)}
                  />
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: -6 }}>
                El costo (ej. comisión bancaria) sale de la caja de origen además del monto.
                El destino recibe solo el monto.
              </div>

              {/* 2026-07-13: sección cross-currency con TC + monto destino
                  editable. Solo aparece cuando origen/destino son de grupos
                  distintos. El monto_destino se auto-calcula del TC pero el
                  operador puede sobrescribirlo (por redondeo del banco). */}
              {isCross && (
                <div style={{
                  padding: 12, borderRadius: 6,
                  background: 'rgba(59, 130, 246, 0.08)',
                  border: '1px solid rgba(59, 130, 246, 0.28)',
                  display: 'grid', gap: 10,
                }}>
                  <div className="u-fw-600-fs-12">
                    Cambio de moneda · {monedaOrigen} → {monedaDestino}
                  </div>
                  <div className="u-grid-1fr-1fr-gap-12">
                    <div className="field">
                      <label className="field-label">TC {grupoMoneda(monedaOrigen) === 'USD' || grupoMoneda(monedaDestino) === 'USD' ? '(1 USD = X)' : ''}</label>
                      <input
                        type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                        className="input mono" placeholder="Ej. 1000"
                        value={form.tc} onChange={e => setMontoOrTc('tc', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label">
                        Monto destino ({monedaDestino})
                        {form.montoDestinoManual && (
                          <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>· editado</span>
                        )}
                      </label>
                      <input
                        type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                        className="input mono" placeholder="Auto"
                        value={form.monto_destino}
                        onChange={e => setMontoDestinoManual(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="muted u-fs-11">
                    El monto destino se calcula del TC. Si el banco redondea (ej. tocan USD 1499.98), tipealo a mano acá.
                  </div>
                </div>
              )}

              <div className="field">
                <label className="field-label">Descripción <span className="muted u-fs-11">(opcional)</span></label>
                <input
                  className="input"
                  placeholder="Ej. Retiro banco → efectivo del día"
                  value={form.descripcion}
                  onChange={e => setF('descripcion', e.target.value)}
                  maxLength={1000}
                />
              </div>

              {/* Resumen del impacto para que el operador sepa qué va a pasar.
                  Same-currency: monto entra en misma moneda. Cross-currency:
                  ambos lados en su moneda propia con TC. */}
              {form.caja_origen_id && form.caja_destino_id && form.monto && (
                <div style={{
                  padding: 10, borderRadius: 6, fontSize: 12,
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.28)',
                }}>
                  <div><strong>Sale de origen:</strong> {fmt(Number(form.monto) + Number(form.costo || 0))} {monedaOrigen}</div>
                  <div>
                    <strong>Entra al destino:</strong>{' '}
                    {isCross
                      ? (form.monto_destino ? `${fmt(form.monto_destino)} ${monedaDestino}` : '— (falta TC/monto destino)')
                      : `${fmt(form.monto)} ${monedaOrigen}`}
                  </div>
                  {Number(form.costo) > 0 && <div className="muted">Costo (comisión): {fmt(form.costo)} {monedaOrigen}</div>}
                  {isCross && form.tc && <div className="muted">TC aplicado: {fmt(form.tc)}</div>}
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
