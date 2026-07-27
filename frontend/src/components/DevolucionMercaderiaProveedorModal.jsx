/**
 * Modal "Devolver mercadería" al proveedor — task #236 (2026-07-27).
 *
 * Backend: `POST /api/proveedores/:id/devoluciones` (PR #910).
 *
 * Diseño UX (validado con Lucas, 4 decisiones "recomendadas"):
 *   - Monto AUTO desde el costo original USD de cada producto (no editable v1).
 *   - Motivo ENUM obligatorio (5 valores) + detalle opcional en texto libre.
 *   - Constraint: solo productos disponibles + owned por ESTE proveedor
 *     + costo USD. La lista viene pre-filtrada del backend
 *     (`GET /productos-devolvibles`), así que el operador solo ve elegibles.
 *   - Selector múltiple con checkboxes + búsqueda por nombre/IMEI.
 *
 * Efectos (server-side, atómicos):
 *   1. Reduce deuda del proveedor por el total USD.
 *   2. Elimina los productos del Inventario (soft-delete + oculto).
 *   3. Audit log.
 *
 * Idempotency-Key: UUID generado al abrir. Doble-click de "Confirmar" usa el
 * MISMO key → replay backend sin duplicar la devolución.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { proveedores as provApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { useDebouncedValue } from '../lib/useDebouncedValue';

const fmtUSD = (n) =>
  `USD ${Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function todayISO() { return new Date().toLocaleDateString('sv'); }

// Motivos (mismo enum que el backend). Label human-readable + hint corto.
const MOTIVOS = [
  { value: 'error_proveedor', label: 'Error del proveedor',  hint: 'Mandó lo que no era, mal armado, etc.' },
  { value: 'defecto',         label: 'Defecto',              hint: 'Producto llegó fallado o con desperfecto.' },
  { value: 'arrepentimiento', label: 'Arrepentimiento',      hint: 'No lo queremos por decisión comercial.' },
  { value: 'cambio_modelo',   label: 'Cambio de modelo',     hint: 'Se cambia por otro modelo/config.' },
  { value: 'otro',            label: 'Otro',                 hint: 'Especificá en el detalle.' },
];

export default function DevolucionMercaderiaProveedorModal({ proveedor, onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [fecha, setFecha]         = useState(todayISO());
  const [motivo, setMotivo]       = useState('defecto');
  const [detalle, setDetalle]     = useState('');
  const [search, setSearch]       = useState('');
  const dSearch = useDebouncedValue(search, 250);

  // Fetch pre-filtrado del backend (productos owned + disponibles + USD).
  const [productos, setProductos] = useState([]);
  const [loadingProd, setLoadingProd] = useState(true);
  const [fetchError, setFetchError]   = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [saving, setSaving]           = useState(false);

  // Pattern G — Idempotency-Key regenerado al abrir. Se mantiene mientras el
  // modal está vivo (doble-click / retry usan el MISMO key → replay backend).
  const [idemKey] = useState(() => crypto.randomUUID());

  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });

  useEffect(() => {
    if (!proveedor?.id) return;
    let alive = true;
    setLoadingProd(true);
    setFetchError(null);
    provApi.productosDevolvibles(proveedor.id)
      .then((r) => { if (alive) setProductos(r?.data || []); })
      .catch((e) => { if (alive) setFetchError(e.message || 'No se pudo cargar la lista de productos'); })
      .finally(() => { if (alive) setLoadingProd(false); });
    return () => { alive = false; };
  }, [proveedor?.id]);

  // Filtro local por búsqueda (nombre o IMEI). El backend soporta `?buscar`
  // pero acá filtramos client-side sobre el fetch inicial — es más rápido y la
  // lista siempre es <= 500 productos (cap del endpoint).
  const filtered = useMemo(() => {
    if (!dSearch.trim()) return productos;
    const q = dSearch.trim().toLowerCase();
    return productos.filter((p) =>
      (p.nombre || '').toLowerCase().includes(q) ||
      (p.imei   || '').toLowerCase().includes(q)
    );
  }, [productos, dSearch]);

  const selected = useMemo(
    () => productos.filter((p) => selectedIds.has(p.id)),
    [productos, selectedIds]
  );
  const totalUsd = useMemo(
    () => selected.reduce((s, p) => s + Number(p.costo || 0), 0),
    [selected]
  );

  function toggleOne(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = filtered.every((p) => next.has(p.id));
      if (allSelected) {
        filtered.forEach((p) => next.delete(p.id));
      } else {
        filtered.forEach((p) => next.add(p.id));
      }
      return next;
    });
  }
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));

  async function handleSave() {
    if (selectedIds.size === 0) {
      toast.error('Seleccioná al menos 1 producto para devolver');
      return;
    }
    if (!motivo) {
      toast.error('Seleccioná el motivo de la devolución');
      return;
    }
    if (detalle.length > 500) {
      toast.error('El detalle no puede superar 500 caracteres');
      return;
    }

    const ok = await confirm({
      title: 'Confirmar devolución',
      message:
        `Vas a devolver ${selectedIds.size} producto(s) al proveedor ` +
        `"${proveedor.nombre}" por ${fmtUSD(totalUsd)}. ` +
        `Esto reduce la deuda y elimina los productos del Inventario. ¿Continuar?`,
      confirmLabel: 'Devolver',
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await provApi.createDevolucion(
        proveedor.id,
        {
          fecha,
          motivo,
          motivo_detalle: detalle.trim() || null,
          producto_ids: [...selectedIds],
        },
        idemKey
      );
      toast.success(
        `Devolución registrada · ${res.productos_devueltos} producto(s) · ${fmtUSD(res.monto_total_usd)}`
      );
      onSaved?.(res);
      onClose();
    } catch (e) {
      // Errores del backend vienen con `error` + `reason` (ej. productos_no_elegibles).
      toast.error(e?.message || 'No se pudo registrar la devolución');
    } finally {
      setSaving(false);
    }
  }

  const motivoActual = MOTIVOS.find((m) => m.value === motivo);

  return (
    <div ref={overlayRef} className="modal-overlay"
         onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal u-mw-720">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="modal-hd">
          <div>
            <h3>Devolver mercadería a {proveedor?.nombre}</h3>
            <div className="page-sub">
              Seleccioná los productos a devolver. El costo original se descuenta de la deuda.
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={saving}
                  aria-label="Cerrar" title="Cerrar">
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* ── Cabecera: fecha + motivo + detalle ────────────────── */}
          <div className="form-grid u-mb-12">
            <label className="form-field">
              <span className="form-label">Fecha</span>
              <input
                type="date"
                className="input"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                disabled={saving}
              />
            </label>
            <label className="form-field">
              <span className="form-label">Motivo</span>
              <select
                className="input"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                disabled={saving}
              >
                {MOTIVOS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              {motivoActual?.hint && (
                <span className="muted tiny">{motivoActual.hint}</span>
              )}
            </label>
          </div>

          <label className="form-field u-mb-12">
            <span className="form-label">
              Detalle <span className="muted">(opcional, máx. 500 chars)</span>
            </span>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              placeholder="Ej: 3 unidades llegaron con pantalla rota, batería <70%..."
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              disabled={saving}
            />
          </label>

          {/* ── Selector de productos ───────────────────────────── */}
          <div className="u-mb-8">
            <div className="flex-row u-flex-gap-8-mt-10-end u-mb-6">
              <input
                type="search"
                className="input u-flex-1"
                placeholder="Buscar por nombre o IMEI…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={saving || loadingProd}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={toggleAllFiltered}
                disabled={saving || loadingProd || filtered.length === 0}
              >
                {allFilteredSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}
              </button>
            </div>

            {loadingProd && (
              <div className="u-empty-p-24-16">Cargando productos…</div>
            )}

            {!loadingProd && fetchError && (
              <div className="u-empty-p-24-16 u-color-neg">
                {fetchError}
              </div>
            )}

            {!loadingProd && !fetchError && productos.length === 0 && (
              <div className="u-empty-p-24-16">
                Este proveedor no tiene productos disponibles para devolver.
                <div className="muted tiny u-mt-6">
                  Solo aparecen los productos comprados a este proveedor, disponibles en Inventario y con costo en USD.
                </div>
              </div>
            )}

            {!loadingProd && !fetchError && productos.length > 0 && (
              <div className="u-flex-1-overflow-mh-0" style={{ maxHeight: 360 }}>
                <table className="u-provs-table">
                  <colgroup>
                    <col className="u-w-30" />{/* checkbox */}
                    <col />                     {/* nombre */}
                    <col className="u-w-130px" />{/* imei */}
                    <col className="u-w-76" />  {/* color */}
                    <col className="u-w-66" />  {/* gb */}
                    <col className="u-w-94" />  {/* costo */}
                  </colgroup>
                  <thead>
                    <tr className="u-sticky-header-bar">
                      <th className="u-provs-th u-text-center">✓</th>
                      <th className="u-provs-th u-text-left">Producto</th>
                      <th className="u-provs-th u-text-left">IMEI</th>
                      <th className="u-provs-th u-text-left">Color</th>
                      <th className="u-provs-th u-text-left">Cap.</th>
                      <th className="u-provs-th u-text-right">Costo USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p) => {
                      const on = selectedIds.has(p.id);
                      return (
                        <tr key={p.id}
                            className="u-provs-row"
                            onClick={() => !saving && toggleOne(p.id)}
                            style={{ cursor: saving ? 'default' : 'pointer' }}>
                          <td className="cell u-text-center">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleOne(p.id)}
                              disabled={saving}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Seleccionar ${p.nombre}`}
                            />
                          </td>
                          <td className="cell">{p.nombre || <span className="dim">—</span>}</td>
                          <td className="cell u-mono u-fs-12">
                            {p.imei || <span className="dim">—</span>}
                          </td>
                          <td className="cell u-color-text-2">
                            {p.color || <span className="dim">—</span>}
                          </td>
                          <td className="cell u-color-text-2">
                            {p.gb || <span className="dim">—</span>}
                          </td>
                          <td className="cell u-td-right-fw-700 mono">
                            {fmtUSD(p.costo)}
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={6} className="u-empty-p-24-16">
                          Sin coincidencias para "{dSearch}".
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer: total + acciones ───────────────────────────── */}
        <div className="modal-ft">
          <div className="flex-row u-flex-gap-8-mt-10-end" style={{ justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="muted tiny">Seleccionados</div>
              <div className="mono u-fs-14-fw-600-lh-11">
                {selectedIds.size} producto(s) · <span className="pos">{fmtUSD(totalUsd)}</span>
              </div>
            </div>
            <div className="flex-row u-flex-gap-8-mt-10-end">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || loadingProd || selectedIds.size === 0}
              >
                {saving ? 'Guardando…' : `Devolver ${selectedIds.size || ''}`.trim()}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
