/**
 * LinkTerceroModal — vincula 1:1 un cliente_cc con un proveedor (task #302).
 *
 * Se abre desde 2 lugares:
 *   1. Ficha del cliente en CuentasCC.jsx (source='cliente'). Filtra por
 *      proveedores — el user busca "con qué proveedor lo vinculo".
 *   2. Ficha del proveedor en Proveedores.jsx (source='proveedor'). Filtra
 *      por clientes — el user busca "con qué cliente lo vinculo".
 *
 * Props:
 *   · source: 'cliente' | 'proveedor' — desde qué ficha se abrió.
 *   · currentId: number — id del cliente O proveedor de origen (según source).
 *   · currentNombre: string — nombre a mostrar en el header (contexto humano).
 *   · onClose(): cierra sin cambios.
 *   · onLinked(link): callback tras crear el link — la ficha padre puede
 *     refrescar el saldo neto.
 *
 * Diseño UX simple:
 *   · Input de búsqueda con debounce 250ms.
 *   · Lista scrolleable con matches (default: primeros 20).
 *   · Click en item → lo marca como seleccionado.
 *   · Textarea opcional "Notas".
 *   · Botón "Vincular" habilitado solo si hay selección.
 *
 * Nota: no usamos endpoint de búsqueda dedicado — reusamos `list({ buscar })`
 * del módulo correspondiente. Es una lista de máximo ~500 en la mayoría
 * de tenants, y el search es server-side (ILIKE) → suficiente para MVP.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import {
  proveedores as provApi,
  cuentas as cuentasApi,
  terceroLink as terceroLinkApi,
} from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';
import { silentReport } from '../lib/reportError';

export default function LinkTerceroModal({ source, currentId, currentNombre, onClose, onLinked }) {
  const { toast } = useToast();

  const [busqueda, setBusqueda] = useState('');
  const [dBusqueda, setDBusqueda] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [seleccionado, setSeleccionado] = useState(null);
  const [notas, setNotas] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });

  // Título dinámico según source.
  const title = source === 'cliente'
    ? 'Vincular cliente con proveedor'
    : 'Vincular proveedor con cliente';
  const inputPlaceholder = source === 'cliente'
    ? 'Buscar proveedor por nombre…'
    : 'Buscar cliente por nombre o apellido…';
  const listEmpty = source === 'cliente'
    ? (dBusqueda ? 'Sin proveedores que matcheen la búsqueda' : 'Escribí el nombre del proveedor a vincular')
    : (dBusqueda ? 'Sin clientes que matcheen la búsqueda' : 'Escribí el nombre del cliente a vincular');

  // Debounce búsqueda 250ms.
  useEffect(() => {
    const t = setTimeout(() => setDBusqueda(busqueda.trim()), 250);
    return () => clearTimeout(t);
  }, [busqueda]);

  // Fetch de matches según source. Reusamos endpoints existentes:
  //   - source='cliente' → buscamos PROVEEDORES → `provApi.list({ buscar })`.
  //   - source='proveedor' → buscamos CLIENTES → `cuentasApi.clientesSearch(q)`.
  useEffect(() => {
    let abort = false;
    setLoading(true);
    const fetch = source === 'cliente'
      ? provApi.list(dBusqueda ? { buscar: dBusqueda, limit: 20 } : { limit: 20 })
      : (dBusqueda ? cuentasApi.clientesSearch(dBusqueda) : cuentasApi.clientes({ limit: 20 }));
    fetch
      .then(res => {
        if (abort) return;
        setItems(res?.data || []);
      })
      .catch(err => {
        if (abort) return;
        silentReport(err);
        setItems([]);
      })
      .finally(() => { if (!abort) setLoading(false); });
    return () => { abort = true; };
  }, [source, dBusqueda]);

  // Render item name según source (para clientes, incluye apellido).
  const renderItemName = (it) => source === 'cliente'
    ? it.nombre
    : `${it.nombre}${it.apellido ? ' ' + it.apellido : ''}`;

  const listaFiltrada = useMemo(() => items || [], [items]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!seleccionado || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = source === 'cliente'
        ? { cliente_cc_id: currentId, proveedor_id: seleccionado.id, notas: notas.trim() || null }
        : { cliente_cc_id: seleccionado.id, proveedor_id: currentId, notas: notas.trim() || null };
      const link = await terceroLinkApi.create(body);
      toast({
        type: 'success',
        title: 'Vinculado',
        message: `${currentNombre} ↔ ${renderItemName(seleccionado)}`,
      });
      if (onLinked) onLinked(link);
      onClose();
    } catch (err) {
      setError(friendlyError(err));
      setSaving(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-tercero-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="link-tercero-modal-title" className="u-flex-center-gap-8">
            <Icons.Users size={16} /> {title}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar modal">
            <Icons.X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="u-mb-8">
              <div className="muted tiny u-mb-4">Vinculando</div>
              <div className="u-fw-600">{currentNombre}</div>
            </div>

            <label className="u-block u-mb-4 muted tiny">
              {source === 'cliente' ? 'Contraparte (proveedor)' : 'Contraparte (cliente)'}
            </label>
            <input
              type="text"
              className="input"
              placeholder={inputPlaceholder}
              value={busqueda}
              onChange={e => { setBusqueda(e.target.value); setSeleccionado(null); }}
              autoFocus
            />

            <div className="u-mt-8 u-link-tercero-list">
              {loading && (
                <div className="muted tiny u-p-8">Cargando…</div>
              )}
              {!loading && listaFiltrada.length === 0 && (
                <div className="muted tiny u-p-8">{listEmpty}</div>
              )}
              {!loading && listaFiltrada.map(it => (
                <button
                  key={it.id}
                  type="button"
                  className={
                    'u-link-tercero-item' + (seleccionado?.id === it.id ? ' u-link-tercero-item-selected' : '')
                  }
                  onClick={() => setSeleccionado(it)}
                >
                  <span>{renderItemName(it)}</span>
                  {seleccionado?.id === it.id && <Icons.Check size={14} />}
                </button>
              ))}
            </div>

            <label className="u-block u-mb-4 u-mt-12 muted tiny">
              Notas (opcional)
            </label>
            <textarea
              className="input"
              placeholder="Contexto interno del link (ej. mismo CUIT, empresa Fulano SA)…"
              value={notas}
              onChange={e => setNotas(e.target.value)}
              maxLength={500}
              rows={2}
            />

            {error && (
              <div className="u-mt-8 u-color-neg tiny">{error}</div>
            )}
          </div>

          <div className="modal-ft u-modal-ft-right">
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!seleccionado || saving}
            >
              {saving ? 'Vinculando…' : 'Vincular'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
