// CategoriasProductoModal.jsx — 2026-07-08 F3.b
//
// UI de gestión de las Categorías (tabla `clases_producto`) del tenant.
// Endpoints backend mergeados en el PR #528 (F3.a).
//
// Ver design doc: `docs/design/categorias-crud-tenant-f3.md`.
//
// Estructura del modal:
//   1. Modal principal con lista draggable de categorías.
//      Cada fila muestra: emoji (opcional) + nombre + badges + botones Editar/Borrar.
//      La fila `es_sin_categoria=true` (fallback del import XLSX) es SISTEMA:
//      no editable, no borrable, no arrastrable — badge "Sistema".
//      Filas `es_base=true` son las 9 categorías default seeded al crear tenant —
//      badge "Base" pero SON editables (política del design doc).
//   2. Botón "Agregar categoría" abre modal secundario con inputs
//      nombre + emoji + toggle activa.
//   3. Delete con productos → guard con confirm específico.
//   4. Reorder drag&drop nativo HTML5 (sin librería adicional). Post-drop
//      llama /reorder batch. Optimistic UI + rollback si el server falla.
//
// El backend ya bloquea con 409 al borrar una categoría con productos
// activos; acá lo pre-flighteamos con `count_productos` en la respuesta
// del GET para dar mensaje más claro al operador.

import { useState, useEffect, useRef } from 'react';
import { inventario } from '../lib/api';
import { useModal } from '../lib/useModal';
import { useConfirm } from './ConfirmModal';
import { Icons } from './Icons';

export default function CategoriasProductoModal({
  open,
  onClose,
  toast,
  // 2026-07-11: sección Colecciones (tabla legacy `categorias`) migrada
  // desde el modal "Depósitos" (renombrado). Los handlers viven en
  // Inventario.jsx porque comparten el state con otros usos (dropdown
  // categoria_id en el form de producto, etc.) — este modal solo los
  // consume. Props opcionales: si no se pasan, la sección Colecciones
  // NO se muestra (backwards compat).
  colecciones,
  nuevaColeccion,
  setNuevaColeccion,
  onAddColeccion,
  onDelColeccion,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | {} (nuevo) | { id, ... } (editar)
  const overlayRef = useRef(null);
  const { confirm } = useConfirm();

  useModal({ open, onClose, overlayRef });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const rows = await inventario.clases();
      setItems(rows);
    } catch (e) {
      setError(e?.data?.error || e.message || 'Error cargando categorías');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (open) load(); }, [open]);

  async function handleDelete(row) {
    const ok = await confirm({
      title: `¿Borrar "${row.nombre}"?`,
      message: row.count_productos > 0
        ? `Esta categoría tiene ${row.count_productos} producto${row.count_productos === 1 ? '' : 's'}. Reasignalos primero antes de borrar — el backend rechaza el borrado con productos activos.`
        : 'La categoría queda inactiva. Podés recrear una con el mismo nombre después.',
      confirmLabel: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    try {
      await inventario.deleteClase(row.id);
      await load();
      toast.success(`"${row.nombre}" borrada`);
    } catch (e) {
      const msg = e?.data?.error || e.message || 'Error borrando categoría';
      toast.error(msg);
    }
  }

  async function handleReorder(sourceId, targetId) {
    if (sourceId === targetId) return;
    // Optimistic reorder: mover source justo antes de target
    const current = [...items];
    const si = current.findIndex(x => x.id === sourceId);
    const ti = current.findIndex(x => x.id === targetId);
    if (si < 0 || ti < 0) return;
    const [moved] = current.splice(si, 1);
    // Ajustar índice destino tras el splice si es necesario
    const insertAt = si < ti ? ti - 1 : ti;
    current.splice(insertAt, 0, moved);

    // Nuevo orden secuencial 10, 20, 30... (mismo que el seed inicial)
    const updates = current.map((x, i) => ({ id: x.id, orden: (i + 1) * 10 }));
    const optimistic = current.map((x, i) => ({ ...x, orden: (i + 1) * 10 }));
    setItems(optimistic);

    try {
      await inventario.reorderClases(updates);
    } catch (e) {
      toast.error('No se pudo guardar el nuevo orden. Refrescando...');
      await load(); // rollback
    }
  }

  async function handleSave(payload) {
    try {
      if (editing.id) {
        await inventario.updateClase(editing.id, payload);
      } else {
        await inventario.createClase(payload);
      }
      setEditing(null);
      await load();
      toast.success(editing.id ? 'Categoría actualizada' : 'Categoría creada');
    } catch (e) {
      // Error se muestra en el modal secundario — re-lanzar para que ese
      // stack lo maneje.
      const msg = e?.data?.error || e.message || 'Error guardando';
      throw new Error(msg);
    }
  }

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-labelledby="cats-modal-title"
        aria-modal="true"
        style={{ maxWidth: 560, width: '92vw' }}
      >
        <div className="modal-hd">
          <h3 id="cats-modal-title">Categorías</h3>
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

        <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <p className="muted tiny u-mb-12">
            Tipo de producto que aparece en el dropdown del alta de Inventario y en los chips del Dashboard.
            Arrastrá filas para reordenar. La categoría <strong>"Sin categoría"</strong> es del sistema
            (fallback del import) — no se puede editar ni borrar.
          </p>

          <div className="u-mb-12">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEditing({})}
            >
              <Icons.Plus size={13} /> Agregar categoría
            </button>
          </div>

          {loading ? (
            <p className="muted">Cargando...</p>
          ) : error ? (
            <p className="u-color-neg">{error}</p>
          ) : items.length === 0 ? (
            <p className="muted">No hay categorías todavía.</p>
          ) : (
            <CatList items={items} onEdit={setEditing} onDelete={handleDelete} onReorder={handleReorder} />
          )}

          {/* Sección Colecciones (categorias legacy) — 2026-07-11.
              Solo se muestra si el parent (Inventario.jsx) pasa las props.
              Cross-purpose "agrupación libre" — el operador puede tener
              hasta N colecciones tipo "iPhones 2024", "Rebajados", etc.
              Complementaria a Categorías (tipo de producto). */}
          {colecciones !== undefined && (
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Colecciones</div>
              <p className="muted tiny u-mb-12">
                Agrupación libre auxiliar, independiente del tipo de producto. Útil para separar
                "iPhones Nuevos", "Rebajados", "Promoción", etc. Un producto puede pertenecer a una
                colección además de tener su categoría.
              </p>
              <div className="flex-row u-gap-6-mb-12">
                <input
                  className="input"
                  placeholder="Nueva colección"
                  value={nuevaColeccion || ''}
                  onChange={e => setNuevaColeccion(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAddColeccion?.(); } }}
                />
                <button type="button" className="btn btn-sm" onClick={onAddColeccion}>
                  <Icons.Plus size={13} /> Agregar
                </button>
              </div>
              <div className="stack u-gap-4">
                {colecciones.length === 0 && <div className="muted tiny">Sin colecciones</div>}
                {colecciones.map(c => {
                  const count = Number(c.productos_count ?? 0);
                  const stock = Number(c.stock_disponible ?? 0);
                  return (
                    <div key={c.id} className="flex-between" style={{ fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--hairline)' }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.nombre}>
                        {c.nombre}
                      </span>
                      <span className="muted tiny" style={{ marginRight: 8, whiteSpace: 'nowrap' }} title={`${count} producto${count === 1 ? '' : 's'} cargado${count === 1 ? '' : 's'} · ${stock} unidad${stock === 1 ? '' : 'es'} en stock`}>
                        {count} prod · {stock} u
                      </span>
                      <button type="button" className="icon-btn u-color-neg" onClick={() => onDelColeccion?.(c)}>
                        <Icons.Trash size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="modal-ft">
          <button type="button" className="btn" onClick={onClose}>Cerrar</button>
        </div>
      </div>

      {editing && (
        <EditModal
          row={editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ── Lista draggable ─────────────────────────────────────────────────────────
function CatList({ items, onEdit, onDelete, onReorder }) {
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(row => {
        const isDragging = dragId === row.id;
        const isDropTarget = dropTarget === row.id && dragId && dragId !== row.id;
        return (
          <div
            key={row.id}
            draggable={!row.es_sin_categoria}
            onDragStart={(e) => {
              if (row.es_sin_categoria) { e.preventDefault(); return; }
              setDragId(row.id);
              e.dataTransfer.effectAllowed = 'move';
              // Firefox exige setData para que el drag arranque.
              e.dataTransfer.setData('text/plain', row.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragId && dragId !== row.id) setDropTarget(row.id);
            }}
            onDragLeave={() => setDropTarget(prev => prev === row.id ? null : prev)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== row.id) onReorder(dragId, row.id);
              setDragId(null);
              setDropTarget(null);
            }}
            onDragEnd={() => { setDragId(null); setDropTarget(null); }}
            className="card card-tight"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              cursor: row.es_sin_categoria ? 'default' : 'grab',
              opacity: isDragging ? 0.4 : 1,
              // Hint visual del drop target: borde superior más grueso.
              borderTop: isDropTarget ? '2px solid var(--accent)' : undefined,
              transition: 'border-top 0.1s',
            }}
          >
            {!row.es_sin_categoria ? (
              <Icons.Menu size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
            ) : (
              <div style={{ width: 14, flexShrink: 0 }} />
            )}

            <span style={{ minWidth: 26, textAlign: 'center', fontSize: 18, flexShrink: 0 }}>
              {row.emoji || ''}
            </span>

            <div className="u-flex-1-minw-0">
              <div style={{ fontWeight: 500, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{row.nombre}</span>
                {row.es_sin_categoria && (
                  <span className="chip tiny" title="Categoría del sistema, no editable ni borrable">Sistema</span>
                )}
                {row.es_base && !row.es_sin_categoria && (
                  <span className="chip tiny" title="Categoría base (creada al arrancar el tenant)">Base</span>
                )}
                {!row.activa && (
                  <span className="chip tiny u-color-warn">Inactiva</span>
                )}
              </div>
              <div className="muted tiny">
                {row.count_productos} producto{row.count_productos === 1 ? '' : 's'}
              </div>
            </div>

            {!row.es_sin_categoria && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onEdit(row)}
                  aria-label="Editar"
                  title="Editar"
                >
                  <Icons.Edit size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onDelete(row)}
                  aria-label="Borrar"
                  title="Borrar"
                  className="u-color-neg"
                >
                  <Icons.Trash size={14} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Modal secundario: nueva/editar ──────────────────────────────────────────
function EditModal({ row, onSave, onCancel }) {
  const isEdit = !!row.id;
  const [draft, setDraft] = useState({
    nombre: row.nombre || '',
    emoji: row.emoji || '',
    activa: row.activa !== undefined ? row.activa : true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const overlayRef = useRef(null);

  useModal({ open: true, onClose: onCancel, overlayRef });

  async function submit() {
    setError('');
    const nombre = draft.nombre.trim();
    if (!nombre) {
      setError('El nombre es requerido');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        nombre,
        emoji: draft.emoji.trim() || null,
        activa: draft.activa,
      };
      await onSave(payload);
      // onSave cierra el modal desde el parent (via setEditing(null))
    } catch (e) {
      setError(e.message || 'Error guardando');
      setSaving(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      style={{ zIndex: 100 }}
      onClick={e => e.target === e.currentTarget && !saving && onCancel()}
    >
      <div
        className="modal"
        style={{ maxWidth: 420, width: '92vw' }}
        role="dialog"
        aria-labelledby="cat-edit-title"
        aria-modal="true"
      >
        <div className="modal-hd">
          <h3 id="cat-edit-title">{isEdit ? 'Editar categoría' : 'Nueva categoría'}</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onCancel}
            aria-label="Cerrar"
            title="Cerrar"
            disabled={saving}
          >
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <label className="field-label" htmlFor="cat-nombre">
            Nombre <span className="u-color-neg">*</span>
          </label>
          <input
            id="cat-nombre"
            className="input"
            value={draft.nombre}
            onChange={e => setDraft({ ...draft, nombre: e.target.value })}
            maxLength={80}
            autoFocus
            placeholder="Ej: Fundas, Repuestos, Camisetas..."
            disabled={saving}
          />

          <label className="field-label u-mt-12" htmlFor="cat-emoji">
            Emoji <span className="muted tiny">(opcional)</span>
          </label>
          <input
            id="cat-emoji"
            className="input"
            value={draft.emoji}
            onChange={e => setDraft({ ...draft, emoji: e.target.value })}
            maxLength={8}
            placeholder="🔧 🎽 📦..."
            disabled={saving}
          />
          <p className="muted tiny u-mt-4">
            En Mac: <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Espacio</kbd> abre el picker del sistema.
          </p>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.activa}
              onChange={e => setDraft({ ...draft, activa: e.target.checked })}
              disabled={saving}
            />
            <span>Activa</span>
            <span className="muted tiny u-ml-6">
              (las inactivas se ocultan en el dropdown de alta)
            </span>
          </label>

          {error && (
            <p style={{ color: 'var(--neg)', marginTop: 12, fontSize: 13 }}>{error}</p>
          )}
        </div>

        <div className="modal-ft">
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancelar</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={saving}
          >
            {saving ? 'Guardando...' : (isEdit ? 'Guardar' : 'Crear')}
          </button>
        </div>
      </div>
    </div>
  );
}
