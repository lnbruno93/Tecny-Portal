/**
 * VendedoresCatalogModal — CRUD del catálogo de vendedores (equipo de ventas).
 *
 * 2026-07-01: reportado por cliente Uruguay. El catálogo se administraba
 * en el tab "Vendedores" de Transferencias (Financiera.jsx) pero se consume
 * en el modal de "Nueva venta" de Ventas.jsx. Conceptualmente los vendedores
 * pertenecen a Ventas, no a Financiera — un vendedor no cobra comisión de
 * transferencia, cierra una venta. Movimos la administración acá y este
 * modal se abre desde un botón en la toolbar principal de Ventas.
 *
 * Props:
 *  - open, onClose: standard modal.
 *  - onChange(newList): callback opcional, se dispara con la lista actualizada
 *    tras cada create/delete. Ventas.jsx la usa para refrescar el state local
 *    del dropdown de "Nueva venta" sin refetch redundante.
 *
 * Comportamiento:
 *  - Al abrir: fetch de vendedoresApi.list() (siempre — el modal puede quedarse
 *    abierto y el owner esperaría datos frescos).
 *  - Agregar: input + Enter/botón. Agrega optimistically? No — esperamos
 *    respuesta del backend porque necesitamos el id para la lista local
 *    (el backend genera BIGSERIAL). Loading state en el botón.
 *  - Eliminar: useConfirm con danger. Advierte que se pierden estadísticas
 *    (idéntico al mensaje original en Financiera.jsx).
 *  - NO muestra contador de comprobantes (era específico de Financiera y no
 *    aplica en Ventas — los comprobantes son transferencias, no ventas).
 *
 * Accesibilidad: useModal hook (Esc cierra, scroll lock, focus trap).
 */

import { useEffect, useRef, useState } from 'react';
import { vendedores as vendsApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { useModal } from '../lib/useModal';
import { Icons } from './Icons';

export default function VendedoresCatalogModal({ open, onClose, onChange }) {
  const { toast } = useToast();
  const confirm   = useConfirm();

  const [vendedores, setVendedores]     = useState([]);
  const [loading, setLoading]           = useState(false);
  const [newVend, setNewVend]           = useState('');
  const [savingVend, setSavingVend]     = useState(false);
  const [deletingId, setDeletingId]     = useState(null);

  const overlayRef = useRef(null);
  useModal({ open, onClose, overlayRef });

  // ── Load vendedores al abrir ────────────────────────────────────────────
  // Reset del input al cerrar para evitar arrastrar valor previo si el user
  // reabre el modal.
  useEffect(() => {
    if (!open) {
      setNewVend('');
      return;
    }
    let mounted = true;
    setLoading(true);
    vendsApi.list()
      .then(list => {
        if (!mounted) return;
        setVendedores(list || []);
      })
      .catch(err => {
        if (!mounted) return;
        toast.error(err?.message || 'No se pudieron cargar los vendedores.');
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── Handlers CRUD ──────────────────────────────────────────────────────
  async function handleAdd() {
    const nombre = newVend.trim();
    if (!nombre) return;
    setSavingVend(true);
    try {
      const v = await vendsApi.create({ nombre });
      const next = [...vendedores, v];
      setVendedores(next);
      onChange?.(next);
      setNewVend('');
      toast.success(`Vendedor "${v.nombre}" creado.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingVend(false);
    }
  }

  async function handleDelete(v) {
    const ok = await confirm({
      title: 'Eliminar vendedor',
      message: `Se eliminará "${v.nombre}" del catálogo. Las estadísticas históricas asociadas también se pierden.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    setDeletingId(v.id);
    try {
      await vendsApi.delete(v.id);
      const next = vendedores.filter(x => x.id !== v.id);
      setVendedores(next);
      onChange?.(next);
      toast.success('Vendedor eliminado.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeletingId(null);
    }
  }

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="vendedores-modal-title"
    >
      <div
        className="modal u-mw-480"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-hd">
          <div>
            <h3 id="vendedores-modal-title">Equipo de ventas</h3>
            <div className="muted tiny">
              Asignan ventas — no son usuarios del portal
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
          >
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body u-flex-col-gap-14">
          {/* Agregar vendedor */}
          <div className="input-group" style={{ maxWidth: '100%' }}>
            <input
              className="input"
              placeholder="Nombre del nuevo vendedor"
              value={newVend}
              onChange={e => setNewVend(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !savingVend && handleAdd()}
              disabled={savingVend}
              data-autofocus
              aria-label="Nombre del nuevo vendedor"
            />
            <button
              type="button"
              className="addon"
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-ink)',
                cursor: savingVend || !newVend.trim() ? 'not-allowed' : 'pointer',
                fontWeight: 700,
                padding: '0 14px',
                border: 'none',
                opacity: savingVend || !newVend.trim() ? 0.6 : 1,
              }}
              onClick={handleAdd}
              disabled={savingVend || !newVend.trim()}
            >
              {savingVend ? '…' : 'Agregar'}
            </button>
          </div>

          {/* Lista */}
          {loading ? (
            <div className="muted tiny" style={{ padding: 12 }}>Cargando…</div>
          ) : vendedores.length === 0 ? (
            <div className="empty">Sin vendedores registrados</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {vendedores.map(v => (
                <div
                  key={v.id}
                  className="flex-between"
                  style={{
                    padding: '12px 14px',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <div className="flex-row" style={{ gap: 12, alignItems: 'center' }}>
                    <div style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: 'var(--surface-3)',
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 700,
                      fontSize: 11,
                    }}>
                      {v.nombre.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                    </div>
                    <div className="u-fw-600">{v.nombre}</div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleDelete(v)}
                    disabled={deletingId === v.id}
                    aria-label={`Eliminar ${v.nombre}`}
                    title="Eliminar"
                  >
                    <Icons.Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-ft">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
