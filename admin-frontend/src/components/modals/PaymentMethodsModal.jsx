// PaymentMethodsModal — CRUD de la lista maestra de métodos de pago.
//
// task #132 (2026-07-15). Se abre desde el header de la pantalla Facturación
// vía el botón "Métodos de pago". Permite:
//   · Agregar un método (input inline + Enter)
//   · Renombrar (click en el nombre → input editable)
//   · Toggle activo/inactivo (soft-delete que oculta del dropdown de
//     asignación pero mantiene tenants ya asignados)
//   · Eliminar (hard-delete solo si nadie lo usa)
//
// La lista maestra es global — no per-tenant. Cuando el modal se cierra con
// `onSaved`, la pantalla padre refetchea /facturacion para propagar cambios
// al dropdown inline y a los nombres visibles en las filas.

import { useEffect, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn, Badge } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';
import { Icons } from '../Icons.jsx';

export default function PaymentMethodsModal({ open, onClose, onSaved }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [creating, setCreating] = useState(false);
  // Estado del inline-edit: { id, nombre } cuando alguna fila está en modo edición.
  const [editing, setEditing] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listPaymentMethods();
      setItems(res?.payment_methods || []);
    } catch (err) {
      setError(err?.message || 'No pudimos cargar los métodos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setError('');
      setNuevoNombre('');
      setEditing(null);
      setDirty(false);
      load();
    }
  }, [open]);

  const handleCreate = async () => {
    const nombre = nuevoNombre.trim();
    if (!nombre) return;
    setCreating(true);
    setError('');
    try {
      await adminApi.createPaymentMethod(nombre);
      setNuevoNombre('');
      setDirty(true);
      await load();
    } catch (err) {
      setError(err?.message || 'No pudimos crear el método.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActivo = async (item) => {
    setSavingId(item.id);
    setError('');
    try {
      await adminApi.updatePaymentMethod(item.id, { activo: !item.activo });
      setDirty(true);
      await load();
    } catch (err) {
      setError(err?.message || 'No pudimos actualizar el método.');
    } finally {
      setSavingId(null);
    }
  };

  const handleRename = async () => {
    if (!editing) return;
    const nombre = editing.nombre.trim();
    if (!nombre) {
      setEditing(null);
      return;
    }
    setSavingId(editing.id);
    setError('');
    try {
      await adminApi.updatePaymentMethod(editing.id, { nombre });
      setEditing(null);
      setDirty(true);
      await load();
    } catch (err) {
      setError(err?.message || 'No pudimos renombrar el método.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (item) => {
    if (item.en_uso > 0) {
      setError(
        `${item.nombre} está asignado a ${item.en_uso} cliente(s). ` +
        `Reasignalos primero o desactivá el método.`
      );
      return;
    }
    if (!confirm(`¿Eliminar "${item.nombre}"? Esta acción es irreversible.`)) return;
    setSavingId(item.id);
    setError('');
    try {
      await adminApi.deletePaymentMethod(item.id);
      setDirty(true);
      await load();
    } catch (err) {
      setError(err?.message || 'No pudimos eliminar el método.');
    } finally {
      setSavingId(null);
    }
  };

  const handleClose = () => {
    // Si hubo cambios, avisamos al padre para refetchear /facturacion.
    if (dirty) onSaved?.();
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Métodos de pago"
      size="md"
      actions={
        <Btn kind="primary" onClick={handleClose}>
          Listo
        </Btn>
      }
    >
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Lista global editable. Los métodos <strong>activos</strong> aparecen en el dropdown
        de cada cliente. Los <strong>inactivos</strong> se ocultan pero se mantienen
        visibles en los clientes que ya los tenían asignados.
      </div>

      {/* Formulario para agregar */}
      <div className="flex-row" style={{ gap: 8, marginBottom: 14 }}>
        <input
          className="input"
          type="text"
          value={nuevoNombre}
          onChange={(e) => setNuevoNombre(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleCreate(); }
          }}
          placeholder="Ej: Transferencia, MercadoPago, Efectivo…"
          maxLength={50}
          disabled={creating}
          className="u-flex-1"
        />
        <Btn
          kind="primary"
          icon="Plus"
          onClick={handleCreate}
          disabled={!nuevoNombre.trim() || creating}
        >
          {creating ? 'Agregando…' : 'Agregar'}
        </Btn>
      </div>

      {error && (
        <div
          className="banner banner-neg u-mb-12"
          role="alert"
        >
          {error}
        </div>
      )}

      {loading && (
        <div className="empty-state">
          <div className="empty-title">Cargando…</div>
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="empty-state">
          <div className="empty-title">Sin métodos configurados todavía.</div>
          Agregá el primero desde el input de arriba.
        </div>
      )}

      {!loading && items.length > 0 && (
        <table className="tbl">
          <caption className="sr-only">Métodos de pago configurados.</caption>
          <thead>
            <tr>
              <th scope="col">Nombre</th>
              <th scope="col" className="num">Uso</th>
              <th scope="col">Estado</th>
              <th scope="col" className="u-w-60px" aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isEditing = editing?.id === item.id;
              const isSaving = savingId === item.id;
              return (
                <tr key={item.id}>
                  <td className="u-fw-600">
                    {isEditing ? (
                      <input
                        className="input"
                        type="text"
                        value={editing.nombre}
                        onChange={(e) => setEditing({ ...editing, nombre: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleRename(); }
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        onBlur={handleRename}
                        autoFocus
                        maxLength={50}
                        disabled={isSaving}
                      />
                    ) : (
                      <span
                        onClick={() => setEditing({ id: item.id, nombre: item.nombre })}
                        className="u-cursor-pointer"
                        title="Click para editar"
                      >
                        {item.nombre}
                      </span>
                    )}
                  </td>
                  <td className="num muted tiny">
                    {item.en_uso === 0 ? '—' : `${item.en_uso} cliente${item.en_uso === 1 ? '' : 's'}`}
                  </td>
                  <td>
                    <Badge tone={item.activo ? 'pos' : 'muted'}>
                      {item.activo ? 'Activo' : 'Inactivo'}
                    </Badge>
                  </td>
                  <td>
                    <div className="flex-row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => handleToggleActivo(item)}
                        disabled={isSaving}
                        title={item.activo ? 'Desactivar' : 'Reactivar'}
                        aria-label={item.activo ? 'Desactivar método' : 'Reactivar método'}
                      >
                        <Icons.Refresh size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => handleDelete(item)}
                        disabled={isSaving || item.en_uso > 0}
                        title={item.en_uso > 0
                          ? `En uso por ${item.en_uso} cliente(s)`
                          : 'Eliminar definitivamente'}
                        aria-label="Eliminar método"
                        style={{ color: item.en_uso === 0 ? 'var(--neg)' : undefined }}
                      >
                        <Icons.Trash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
