// MergeClasesModal — POST /api/super-admin/tenants/:id/clases-merge (2026-07-14).
//
// Fusiona dos categorías de producto (clases_producto) casi-duplicadas dentro
// de un tenant. La duplicada queda soft-deleted; sus productos se re-linkean
// a la canónica.
//
// UX: mostramos ambas clases con su count de productos, y una flecha visual
//   Duplicada → Canónica. Permite invertir (swap) el par por si la sugerencia
//   automática del backend no es la deseada — pattern importante porque el
//   ranking usa heurísticas (base > más productos > más viejo > alfabético)
//   pero el operador conoce el contexto real del tenant.
//
// Anti-clic-accidental: botón habilitado por default (sin typing gate). El
//   merge es reversible en cascada (los productos se pueden re-linkear a mano
//   post-hoc) — no aplica el gate del delete-tenant o change-pais que son
//   catastróficos. Pero la acción sigue debajo de banners contextuales y el
//   caller enseña "N productos se moverán".
//
// Backend errors mapeados:
//   - 400 base_as_duplicada / sin_categoria_as_duplicada → mensaje claro
//   - 404 clase_not_found → clase probablemente ya se mergeó de otro lado
//   - 409 alias del business rule check
//   - genérico → error.message

import { useEffect, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';

export default function MergeClasesModal({
  tenantId,
  pair,        // { a, b, canonica_suggested_id, duplicada_suggested_id, ... }
  open,
  onClose,
  onMerged,    // (result) => void — result = { productos_movidos, canonica_nombre, duplicada_nombre }
}) {
  // El par viene con canonica/duplicada sugeridos por el backend. Guardamos
  // qué side es cual localmente para permitir swap sin remontar el modal.
  const [canonicaId, setCanonicaId] = useState(null);
  const [duplicadaId, setDuplicadaId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && pair) {
      setCanonicaId(pair.canonica_suggested_id);
      setDuplicadaId(pair.duplicada_suggested_id);
      setError('');
      setSubmitting(false);
    }
  }, [open, pair]);

  if (!pair) return null;

  const canonica = pair.a.id === canonicaId ? pair.a : pair.b;
  const duplicada = pair.a.id === duplicadaId ? pair.a : pair.b;

  // Swap: intercambia cual lado es canónica vs duplicada. Solo permitido si
  // ni A ni B son es_base/es_sin_categoria — esas clases especiales NO pueden
  // ser duplicada (el backend las rechaza), entonces la sugerencia del backend
  // ya es la única válida y el swap generaría un 409 seguro.
  const someIsSpecial =
    pair.a.es_base || pair.a.es_sin_categoria ||
    pair.b.es_base || pair.b.es_sin_categoria;
  const canSwap = !someIsSpecial;

  const handleSwap = () => {
    if (!canSwap) return;
    setCanonicaId(duplicadaId);
    setDuplicadaId(canonicaId);
    setError('');
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await adminApi.mergeClasesProducto(tenantId, {
        duplicada_id: duplicadaId,
        canonica_id:  canonicaId,
      });
      onMerged?.(result);
    } catch (err) {
      const code = err?.responseBody?.code || err?.code;
      let msg = err?.message || 'No pudimos fusionar las categorías.';
      // Backend error codes (POST /clases-merge):
      //   - 409 duplicada_es_base            → la duplicada es una categoría base
      //   - 409 duplicada_es_sin_categoria   → la duplicada es "Sin categoría"
      //   - 404 (sin code): alguna clase no existe / cross-tenant / borrada
      if (code === 'duplicada_es_base') {
        msg = 'La categoría base no puede ser la duplicada. Invertí el par.';
      } else if (code === 'duplicada_es_sin_categoria') {
        msg = 'La categoría "Sin categoría" no puede ser la duplicada (protegida).';
      } else if (err?.status === 404) {
        msg = 'Alguna de las clases ya no existe. Refrescá la lista de duplicados.';
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Fusionar categorías duplicadas"
      size="md"
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={submitting || !canonicaId || !duplicadaId}
          >
            {submitting ? 'Fusionando…' : `Fusionar (${duplicada?.count_productos || 0} producto${duplicada?.count_productos === 1 ? '' : 's'})`}
          </Btn>
        </>
      }
    >
      <div className="banner banner-info u-mb-14">
        <div>
          <strong>¿Qué hace la fusión?</strong>
          <ul className="u-m-8-0-0-18-p-0">
            <li>
              Los <strong>{duplicada?.count_productos || 0} producto{duplicada?.count_productos === 1 ? '' : 's'}</strong>
              {' '}de <code>{duplicada?.nombre}</code> pasan a apuntar a{' '}
              <code>{canonica?.nombre}</code>.
            </li>
            <li>
              <code>{duplicada?.nombre}</code> queda soft-deleted (no aparece más
              en filtros ni pickers).
            </li>
            <li>
              Queda registrado en el audit trail con <code>clases_merge</code>.
            </li>
            <li>
              <strong>No es reversible desde acá</strong> — para revertir hay
              que re-crear la clase y mover productos a mano.
            </li>
          </ul>
        </div>
      </div>

      <div className="split-2" style={{ gap: 12, marginBottom: 14 }}>
        <div
          style={{
            border: '2px solid var(--pos)',
            borderRadius: 8,
            padding: 12,
            background: 'color-mix(in srgb, var(--pos) 8%, transparent)',
          }}
        >
          <div className="muted tiny u-mb-4">
            SE QUEDA (canónica)
          </div>
          <div className="u-fs-16-fw-600">
            {canonica?.nombre}
          </div>
          <div className="muted tiny u-mt-4">
            {canonica?.count_productos} producto{canonica?.count_productos === 1 ? '' : 's'}
            {canonica?.es_base && ' · base'}
            {canonica?.es_sin_categoria && ' · sin_categoría'}
          </div>
        </div>

        <div
          style={{
            border: '2px solid var(--neg)',
            borderRadius: 8,
            padding: 12,
            background: 'color-mix(in srgb, var(--neg) 8%, transparent)',
          }}
        >
          <div className="muted tiny u-mb-4">
            SE BORRA (duplicada)
          </div>
          <div style={{ fontWeight: 600, fontSize: 16, textDecoration: 'line-through', opacity: 0.85 }}>
            {duplicada?.nombre}
          </div>
          <div className="muted tiny u-mt-4">
            {duplicada?.count_productos} producto{duplicada?.count_productos === 1 ? '' : 's'} → se mueven
          </div>
        </div>
      </div>

      {canSwap && (
        <div className="u-mb-14-text-center">
          <Btn kind="ghost" sm icon="Refresh" onClick={handleSwap} disabled={submitting}>
            Invertir (usar {duplicada?.nombre} como canónica)
          </Btn>
        </div>
      )}
      {!canSwap && (
        <div className="muted tiny u-mb-14-text-center">
          Una de las clases es <strong>base</strong> o <strong>sin_categoría</strong> —
          debe quedar como canónica.
        </div>
      )}

      <div className="muted tiny">
        Similitud: <strong>{Math.round((pair.similarity || 0) * 100)}%</strong>
        {pair.contain_kind && pair.contain_kind !== 'NONE' && (
          <> · Uno contiene al otro (<code>{pair.contain_kind}</code>)</>
        )}
        {' · Confianza: '}
        <strong>{pair.confidence}</strong>
      </div>

      {error && (
        <div className="banner banner-neg u-mt-12" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
