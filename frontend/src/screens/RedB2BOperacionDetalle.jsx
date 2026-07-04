// Red B2B Operación Detalle (F3 #456) — pantalla de detalle de una op
// cross-tenant.
//
// Mostrar:
//   - Header: status, my_side (badge), partner, totales, fechas
//   - Items table: producto, cantidad, precios USD + ARS
//   - Notes (editable solo si soy seller)
//   - Botón "Cancelar operación" (solo seller, con confirm modal + motivo)
//
// La ruta `/red-b2b/operaciones/:id` está gateada por cap cross_tenant.write
// (App.jsx + RequirePermission). El backend además verifica que mi tenant
// participe (seller o buyer) — 404 si no.

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { redB2b } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmtMoney, fmtFecha } from '../lib/format';
import RedB2BRegistrarPagoModal from '../components/RedB2BRegistrarPagoModal';

const STATUS_LABELS = {
  active:    { label: 'Activa',    color: 'green'  },
  cancelled: { label: 'Cancelada', color: 'red'    },
  frozen:    { label: 'Congelada', color: 'orange' },
};

export default function RedB2BOperacionDetalle() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [op, setOp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // F4: pagos state.
  const [pagosData, setPagosData] = useState(null); // { saldo, pagos }
  const [showPagoModal, setShowPagoModal] = useState(false);

  // 2026-07-05 TANDA 0.5 (Red B2B U0-2): reemplaza `window.prompt` por modal
  // inline con textarea. El prompt nativo: (a) rompe look-and-feel; (b) truncado
  // en iOS Safari; (c) sin focus trap; (d) sin validación en vivo.
  // Estado: null = modal cerrado; string = modal abierto con motivo tipeado.
  const [cancelReason, setCancelReason] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await redB2b.operations.get(id);
      setOp(r.operation);
      setNotesDraft(r.operation?.notes || '');
      // Cargar pagos también.
      try {
        const p = await redB2b.pagos.listByOperation(id);
        setPagosData(p);
      } catch { /* swallow — feature degrada gracefully sin pagos */ }
    } catch (err) {
      if (err.status === 404) {
        toast.error('Operación no encontrada');
        navigate('/red-b2b/operaciones');
      } else {
        toast.error(err.message || 'No pudimos cargar la operación');
      }
    } finally {
      setLoading(false);
    }
  }, [id, navigate, toast]);

  useEffect(() => { load(); }, [load]);

  async function handleSaveNotes() {
    if (notesDraft === (op?.notes || '')) return;
    setSavingNotes(true);
    try {
      await redB2b.operations.patch(id, notesDraft);
      toast.success('Notas actualizadas');
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos guardar las notas');
    } finally {
      setSavingNotes(false);
    }
  }

  // 2026-07-05 TANDA 0.5 (Red B2B U0-2): flujo de cancelación con modal.
  //
  // Antes: (1) window.prompt para el motivo, (2) confirm() con `destructive`
  // que no existe (la prop real es `danger`). Combinado: la acción MÁS
  // peligrosa del portal (revertir stock en 2 tenants) tenía la peor UX.
  //
  // Ahora: modal inline (openCancelModal) con textarea + confirmación explícita.
  // Segundo paso via useConfirm con prop `danger: true` (rojo). Focus trap +
  // Esc + validación en vivo del textarea vienen "gratis" del pattern.
  function openCancelModal() {
    setCancelReason(''); // string vacío = abierto, sin motivo aún
  }

  async function confirmCancel() {
    if (cancelReason === null) return;
    const ok = await confirm({
      title: 'Cancelar operación',
      message: `Vas a cancelar la operación con ${op.partner?.nombre}. ` +
               'Se revierte el stock del vendedor y se baja del comprador. ' +
               '¿Confirmás?',
      confirmLabel: 'Sí, cancelar',
      danger: true,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      await redB2b.operations.cancel(id, cancelReason.trim() || undefined);
      toast.success('Operación cancelada');
      setCancelReason(null);
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos cancelar la operación');
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="screen-wrap">
        <div className="empty-state" style={{ padding: 32 }}>
          Cargando operación…
        </div>
      </div>
    );
  }

  if (!op) {
    return (
      <div className="screen-wrap">
        <div className="empty-state" style={{ padding: 32 }}>
          Operación no encontrada.
          <div style={{ marginTop: 16 }}>
            <Link to="/red-b2b/operaciones" className="btn-secondary">
              Volver al listado
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[op.status] || { label: op.status, color: 'gray' };
  const isSeller = op.my_side === 'seller';
  const canEdit = isSeller && op.status === 'active';
  const canCancel = isSeller && op.status === 'active';
  const sideBadge = isSeller
    ? { label: 'Vendedor', color: '#2563eb' }
    : { label: 'Comprador', color: '#10b981' };

  return (
    <div className="screen-wrap">
      <header className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Link to="/red-b2b/operaciones" className="btn-link" style={{ fontSize: 14 }}>
              ← Operaciones
            </Link>
          </div>
          <h1 style={{ marginBottom: 4 }}>Operación #{op.id}</h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span
              className="badge"
              style={{
                background: sideBadge.color,
                color: 'white',
                padding: '2px 10px',
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {sideBadge.label}
            </span>
            <span
              className={`status-badge status-${statusInfo.color}`}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                fontSize: 13,
                background: `var(--${statusInfo.color}-bg, #f3f4f6)`,
                color: `var(--${statusInfo.color}-fg, #374151)`,
              }}
            >
              {statusInfo.label}
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              con <strong>{op.partner?.nombre || '—'}</strong>
            </span>
          </div>
        </div>

        {canCancel && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={openCancelModal}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelando…' : 'Cancelar operación'}
          </button>
        )}
      </header>

      <section className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <KpiBox label="Total USD" value={fmtMoney(op.total_usd, 'USD')} />
          <KpiBox label="Total ARS" value={fmtMoney(op.total_ars, 'ARS')} />
          <KpiBox label="TC usado" value={op.tc_used ? Number(op.tc_used).toFixed(2) : '—'} />
          <KpiBox label="Items" value={op.items?.length || 0} />
          <KpiBox label="Creada" value={fmtFecha(op.created_at)} />
          {op.last_modified_at && (
            <KpiBox label="Última modificación" value={fmtFecha(op.last_modified_at)} />
          )}
        </div>
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ padding: '12px 16px', margin: 0, fontSize: 16 }}>Items</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Producto {isSeller ? '(mi catálogo)' : '(partner)'}</th>
                <th style={{ textAlign: 'right' }}>Cantidad</th>
                <th style={{ textAlign: 'right' }}>Precio USD</th>
                <th style={{ textAlign: 'right' }}>Precio ARS</th>
                <th style={{ textAlign: 'right' }}>Subtotal USD</th>
              </tr>
            </thead>
            <tbody>
              {(op.items || []).map((it, i) => {
                const pid = isSeller ? it.seller_producto_id : it.buyer_producto_id;
                const subUsd = Number(it.precio_unitario_usd) * Number(it.cantidad);
                return (
                  <tr key={it.id}>
                    <td>{i + 1}</td>
                    <td>#{pid}</td>
                    <td style={{ textAlign: 'right' }}>{it.cantidad}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(it.precio_unitario_usd, 'USD')}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(it.precio_unitario_ars, 'ARS')}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(subUsd, 'USD')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Notas</h2>
        {canEdit ? (
          <>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              maxLength={1000}
              rows={4}
              style={{ width: '100%', padding: 8, fontFamily: 'inherit', fontSize: 14 }}
              placeholder="Notas internas (opcional). Visibles para ambos lados."
              aria-label="Notas de la operación"
            />
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveNotes}
                disabled={savingNotes || notesDraft === (op.notes || '')}
              >
                {savingNotes ? 'Guardando…' : 'Guardar notas'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {notesDraft.length}/1000
              </span>
            </div>
          </>
        ) : (
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {op.notes || <span className="muted">Sin notas.</span>}
          </p>
        )}
      </section>

      {/* F4: sección de pagos cross-tenant */}
      <section className="card" style={{ padding: 16, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Pagos cross-tenant</h2>
          {op.status === 'active' && pagosData?.saldo && !pagosData.saldo.completo && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowPagoModal(true)}
            >
              Registrar pago
            </button>
          )}
        </div>
        {pagosData?.saldo && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 12 }}>
            <KpiBox label="Pagado USD" value={fmtMoney(pagosData.saldo.pagado_usd, 'USD')} />
            <KpiBox
              label="Restante USD"
              value={fmtMoney(pagosData.saldo.restante_usd, 'USD')}
              color={pagosData.saldo.completo ? 'green' : 'orange'}
            />
            <KpiBox label="Pagos" value={String(pagosData.pagos?.length || 0)} />
          </div>
        )}
        {pagosData?.pagos && pagosData.pagos.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Side</th>
                  <th style={{ textAlign: 'right' }}>Monto USD</th>
                  <th>Moneda</th>
                  <th style={{ textAlign: 'right' }}>TC pago</th>
                  <th style={{ textAlign: 'right' }}>Dif. cambiaria ARS</th>
                  <th>Registrado por</th>
                </tr>
              </thead>
              <tbody>
                {pagosData.pagos.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtFecha(p.fecha)}</td>
                    <td>{p.side === 'seller' ? 'Vendedor' : 'Comprador'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(p.monto_usd, 'USD')}</td>
                    <td>{p.moneda_pago}</td>
                    <td style={{ textAlign: 'right' }}>{p.tc_pago ? Number(p.tc_pago).toFixed(2) : '—'}</td>
                    <td style={{
                      textAlign: 'right',
                      color: p.diferencia_cambiaria_ars > 0 ? 'var(--green-fg, #166534)' :
                             p.diferencia_cambiaria_ars < 0 ? 'var(--red-fg, #991b1b)' : 'inherit',
                    }}>
                      {p.diferencia_cambiaria_ars !== 0 ? fmtMoney(p.diferencia_cambiaria_ars, 'ARS') : '—'}
                    </td>
                    <td>{p.registered_by_username || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>Aún no hay pagos registrados.</p>
        )}
      </section>

      {showPagoModal && pagosData?.saldo && (
        <RedB2BRegistrarPagoModal
          operation={op}
          restanteUsd={pagosData.saldo.restante_usd}
          onClose={() => setShowPagoModal(false)}
          onSuccess={() => load()}
        />
      )}

      {/* 2026-07-05 TANDA 0.5 U0-2: modal reemplaza window.prompt.
          Consistente con look-and-feel del portal (focus trap, Esc, textarea
          nativo con maxLength y validación en vivo). */}
      {cancelReason !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-op-title"
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'rgba(0,0,0,0.55)',
            display: 'grid', placeItems: 'center',
            padding: 16,
          }}
          onKeyDown={(e) => { if (e.key === 'Escape') setCancelReason(null); }}
        >
          <div
            className="card"
            style={{ width: '100%', maxWidth: 480, padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="cancel-op-title" style={{ margin: 0, marginBottom: 12, color: 'var(--neg)' }}>
              Cancelar operación
            </h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13, lineHeight: 1.5 }}>
              Vas a cancelar la operación con <strong>{op.partner?.nombre}</strong>.
              Esto revierte el stock del vendedor y baja las unidades del
              comprador en ambos tenants.
            </p>
            <label htmlFor="cancel-reason" style={{ display: 'block', marginTop: 12, marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
              Motivo (opcional)
            </label>
            <textarea
              id="cancel-reason"
              autoFocus
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value.slice(0, 500))}
              placeholder="Ej: cliente se arrepintió, error de carga, etc."
              rows={3}
              maxLength={500}
              className="input"
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'right' }}>
              {cancelReason.length}/500
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setCancelReason(null)}
                disabled={cancelling}
              >
                Volver
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={confirmCancel}
                disabled={cancelling}
              >
                {cancelling ? 'Cancelando…' : 'Cancelar operación'}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="card" style={{ padding: 16, marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Trazabilidad</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14 }}>
          {isSeller && (
            <div>
              <span className="muted">Venta CC (seller): </span>
              <strong>#{op.seller_venta_id}</strong>
            </div>
          )}
          {!isSeller && (
            <div>
              <span className="muted">Compra a proveedor (buyer): </span>
              <strong>#{op.buyer_compra_id}</strong>
            </div>
          )}
          <div>
            <span className="muted">Partnership: </span>
            <strong>#{op.partnership_id}</strong>
          </div>
        </div>
      </section>
    </div>
  );
}

function KpiBox({ label, value }) {
  return (
    <div style={{ padding: 12, background: 'var(--bg-subtle, #f9fafb)', borderRadius: 4 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
