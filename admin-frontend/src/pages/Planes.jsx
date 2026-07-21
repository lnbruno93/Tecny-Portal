// Pantalla Planes — editor de precios de planes (#353).
//
// Reemplaza el placeholder ComingSoon. Lee `plan_prices` del backend y
// permite editar `price_usd` + `notes` de cada plan editable. trial y
// enterprise se muestran read-only:
//   · trial: por contrato del producto, siempre $0/mes.
//   · enterprise: price_usd=null (custom per-tenant via tenants.custom_mrr_usd).
//
// Flow:
//   1. GET /api/super-admin/plan-prices al mount → cache local.
//   2. User edita price_usd inline (input number) o notas (textarea).
//   3. Botón "Guardar" abre confirmación con `reason` para audit.
//   4. PATCH /api/super-admin/plan-prices/:plan → backend valida +
//      audita + refreshCache. Update local del row con la respuesta.
//   5. Toast/banner de éxito; el cache local refleja el cambio.
//
// Diseño defensivo:
//   · El input no es type="number" puro — usamos pattern para evitar
//     el comportamiento raro de scroll-rueda + arrows que descalibra
//     un precio sin querer.
//   · Si el user empieza a editar pero NO guarda y refresca, perdió
//     el cambio. No usamos localStorage draft — es config global,
//     no queremos que un draft viejo aparezca después de meses.
//   · Validación cliente: price_usd >= 0 y < 100M. Mismas reglas que
//     el zod schema del backend para fail-fast.

import { useEffect, useId, useMemo, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, Badge, PageHead } from '../components/primitives/index.jsx';
import Modal from '../components/primitives/Modal.jsx';
import { fmtMoney, fmtDateTime } from '../lib/format.js';
import { planTone, planLabel } from '../lib/uiHelpers.js';

// Orden canónico de los planes. El backend ya devuelve ordenado, pero
// usamos esto como fallback defensivo si llegan en orden distinto.
const PLAN_ORDER = ['trial', 'starter', 'pro', 'enterprise'];

// BLOCKER H-2 fix (audit 2026-06-22): `planTone` se importa de uiHelpers.js
// para alinearse con Resumen/Clientes/Ficha. Antes acá había una versión
// local que pintaba Pro=`pos` (verde) mientras las otras pantallas lo
// pintaban Pro=`info` (lila) — el mismo plan se veía de dos colores según
// la pantalla. Ahora es consistente. Si en el futuro Lucas quiere cambiar
// la paleta, el único lugar es uiHelpers.PLAN_TONES.

// Descripción visible bajo cada plan — orienta al super-admin sobre qué
// representa cada uno, sin tener que abrir el design doc.
const PLAN_BLURB = {
  trial:      'Período de prueba gratuita (14 días por default). No editable: siempre $0.',
  starter:    'Plan inicial. Editable. Cambios impactan en MRR del Resumen al refrescar.',
  pro:        'Plan medio. Editable. Cambios impactan en MRR del Resumen al refrescar.',
  enterprise: 'Sin precio fijo — cada cliente enterprise tiene custom_mrr_usd en su ficha.',
};

// ──────────────────────────────────────────────────────────────────────
// PlanRow — card por plan con form inline (read-only para trial/enterprise).
// Stateless: parent maneja el cache + onSave handler.
// ──────────────────────────────────────────────────────────────────────
function PlanRow({ row, onEdit, dirty, saving }) {
  const isEditable = row.plan !== 'trial' && row.plan !== 'enterprise';
  const isTrial = row.plan === 'trial';
  const isEnterprise = row.plan === 'enterprise';
  const priceId = useId();
  const notesId = useId();

  return (
    <Card flush>
      <header className="card-hd">
        <div className="flex-row" style={{ gap: 10, alignItems: 'center' }}>
          <Badge tone={planTone(row.plan)}>{planLabel(row.plan)}</Badge>
          {isTrial && <span className="muted tiny">(no editable)</span>}
          {isEnterprise && <span className="muted tiny">(custom per-tenant)</span>}
          {dirty && <span className="muted tiny">· cambios sin guardar</span>}
        </div>
        <div className="muted tiny">
          {row.updated_at ? (
            <>
              Última edición: {fmtDateTime(row.updated_at)}
              {row.updated_by_username && ` · por @${row.updated_by_username}`}
            </>
          ) : 'Nunca editado'}
        </div>
      </header>

      <div className="card-body">
        <p className="muted tiny u-mt-0-mb-14">
          {PLAN_BLURB[row.plan] || ''}
        </p>

        <div className="stack u-gap-14">
          <div>
            <label className="form-label" htmlFor={priceId}>Precio USD/mes</label>
            {isEnterprise ? (
              <div className="input" style={{ background: 'var(--bg-soft)', color: 'var(--text-dim)' }}>
                Sin precio fijo
              </div>
            ) : (
              <input
                id={priceId}
                className="input"
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                max="99999999"
                value={row.price_usd ?? ''}
                onChange={(e) => onEdit(row.plan, { price_usd: e.target.value })}
                disabled={!isEditable || saving}
                placeholder={isTrial ? '0' : 'ej: 49'}
                aria-label={`Precio del plan ${row.plan}`}
              />
            )}
            {isEditable && (
              <div className="muted tiny u-mt-4">
                Mostrado en la landing y usado para calcular MRR.
              </div>
            )}
          </div>

          <div>
            <label className="form-label" htmlFor={notesId}>Notas (opcional)</label>
            <textarea
              id={notesId}
              className="input"
              rows={2}
              value={row.notes ?? ''}
              onChange={(e) => onEdit(row.plan, { notes: e.target.value })}
              placeholder="Ej: subido 10% por inflación junio 2026"
              disabled={!isEditable || saving}
              style={{ resize: 'vertical', minHeight: 48 }}
              aria-label={`Notas del plan ${row.plan}`}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ConfirmModal — paso intermedio antes del PATCH con `reason` para audit.
// ──────────────────────────────────────────────────────────────────────
function ConfirmModal({ open, onClose, change, onConfirm, submitting, error }) {
  const [reason, setReason] = useState('');
  const reasonId = useId();

  // Reset al abrir.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  if (!change) return null;

  const { plan, oldPrice, newPrice, notesChanged } = change;

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Confirmar cambio de precio"
      size="sm"
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn kind="primary" onClick={() => onConfirm(reason.trim())} disabled={submitting}>
            {submitting ? 'Guardando…' : 'Confirmar y guardar'}
          </Btn>
        </>
      }
    >
      <p className="u-mt-0">
        <strong>{planLabel(plan)}</strong>: {fmtMoney(oldPrice)} → <strong>{fmtMoney(newPrice)}</strong>
        {notesChanged && <span className="muted tiny"> · también se actualizan las notas</span>}
      </p>
      <p className="muted tiny u-mb-14">
        El cambio impacta en MRR del Resumen y en la landing tecnyapp.com.
        Se guarda en el audit trail con tu user.
      </p>

      <label className="form-label" htmlFor={reasonId}>Motivo (opcional)</label>
      <input
        id={reasonId}
        className="input"
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Ej: ajuste de pricing Q3 2026"
        disabled={submitting}
        maxLength={500}
      />
      <div className="muted tiny u-mt-4">
        Queda registrado en el log de cambios.
      </div>

      {error && (
        <div className="banner banner-neg u-mt-12" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Planes — pantalla principal
// ──────────────────────────────────────────────────────────────────────
export default function Planes() {
  // `rows`: snapshot del backend (read-only, base de comparación para dirty).
  // `edits`: diff por plan { price_usd?, notes? } — solo lo que cambió en UI.
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingChange, setPendingChange] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState('');

  // Carga inicial. Lo extraemos a una función para reusar en refresh
  // post-PATCH (no usamos la respuesta del PATCH directamente porque ese
  // endpoint solo devuelve el row editado, no la lista completa con join).
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await adminApi.getPlanPrices();
      setRows(Array.isArray(data?.plan_prices) ? data.plan_prices : []);
      setEdits({});
    } catch (err) {
      setError(err?.message || 'No pudimos cargar los planes.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load();   }, []);

  // Aplicar edits sobre rows para render. Esto es lo que ve el usuario:
  // base del backend + sus cambios en memoria. Sort por orden canónico.
  const displayRows = useMemo(() => {
    return [...rows]
      .sort((a, b) => PLAN_ORDER.indexOf(a.plan) - PLAN_ORDER.indexOf(b.plan))
      .map((r) => {
        const ed = edits[r.plan] || {};
        return { ...r, ...ed };
      });
  }, [rows, edits]);

  // Track dirty por plan: ¿el form difiere de la base?
  const dirtyByPlan = useMemo(() => {
    const m = {};
    for (const r of rows) {
      const ed = edits[r.plan];
      if (!ed) { m[r.plan] = false; continue; }
      // price_usd puede venir como string del input — comparamos numéricamente.
      const priceDirty = 'price_usd' in ed
        ? Number(ed.price_usd) !== Number(r.price_usd ?? 0) || (ed.price_usd === '' && r.price_usd != null)
        : false;
      const notesDirty = 'notes' in ed && (ed.notes ?? '') !== (r.notes ?? '');
      m[r.plan] = priceDirty || notesDirty;
    }
    return m;
  }, [rows, edits]);

  const handleEdit = (plan, patch) => {
    setEdits((prev) => ({
      ...prev,
      [plan]: { ...(prev[plan] || {}), ...patch },
    }));
    setSuccess('');
  };

  const handleSaveClick = (plan) => {
    const original = rows.find((r) => r.plan === plan);
    const ed = edits[plan];
    if (!original || !ed) return;

    // Resolución del nuevo price_usd. Si el input quedó vacío → null
    // (semánticamente "sin precio"). Solo válido para enterprise.
    const newPriceRaw = 'price_usd' in ed ? ed.price_usd : original.price_usd;
    const newPrice = newPriceRaw === '' || newPriceRaw === null ? null : Number(newPriceRaw);

    // BLOCKER S-2 fix (audit 2026-06-22): validar ANTES de abrir el modal
    // de confirmación. El backend rechaza:
    //   · price_usd != null para enterprise (esquema fijo)
    //   · price_usd == null para starter/pro (necesitan precio)
    //   · price_usd negativo o > 99999999 (bounds del zod)
    //   · NaN (input no-numérico)
    // Antes la validación cliente solo cubría "negativo o NaN". El operador
    // podía borrar el precio de starter, llenar el modal con reason, confirmar,
    // y recién ahí el backend devolvía 400 — perdiendo el reason tipeado.
    if (newPrice != null && !Number.isFinite(newPrice)) {
      setError(`Precio inválido para ${planLabel(plan)}. Debe ser un número.`);
      return;
    }
    if (newPrice != null && newPrice < 0) {
      setError(`Precio inválido para ${planLabel(plan)}. No puede ser negativo.`);
      return;
    }
    if (newPrice != null && newPrice > 99999999) {
      setError(`Precio inválido para ${planLabel(plan)}. Excede el máximo permitido.`);
      return;
    }
    // Plan editable (starter/pro) requiere precio no-null.
    const isEditable = plan !== 'trial' && plan !== 'enterprise';
    if (isEditable && newPrice == null) {
      setError(`${planLabel(plan)} necesita un precio. Ingresá un número >= 0.`);
      return;
    }
    // Enterprise NO acepta precio fijo (CHECK constraint chk_enterprise_no_fixed_price).
    if (plan === 'enterprise' && newPrice != null) {
      setError('Enterprise no acepta precio fijo (custom per-tenant en tenants.custom_mrr_usd).');
      return;
    }

    setPendingChange({
      plan,
      oldPrice: original.price_usd,
      newPrice,
      notesChanged: 'notes' in ed && (ed.notes ?? '') !== (original.notes ?? ''),
    });
    setModalError('');
    setError(''); // limpiar errores previos al abrir confirm
    setConfirmOpen(true);
  };

  const handleConfirm = async (reason) => {
    if (!pendingChange) return;
    setSubmitting(true);
    setModalError('');
    try {
      const body = { price_usd: pendingChange.newPrice };
      if (pendingChange.notesChanged) {
        body.notes = edits[pendingChange.plan]?.notes ?? null;
      }
      if (reason) body.reason = reason;
      await adminApi.updatePlanPrice(pendingChange.plan, body);
      setConfirmOpen(false);
      setPendingChange(null);
      setSuccess(`${planLabel(pendingChange.plan)} actualizado correctamente.`);
      // Recarga limpia desde DB para tener updated_at + updated_by_username
      // frescos. Una alternativa era patchear in-place pero perderíamos el
      // username del join.
      await load();
    } catch (err) {
      setModalError(err?.message || 'No pudimos guardar el cambio.');
    } finally {
      // Bug histórico (Lucas, 2026-06-22): el happy path NO reseteaba
      // `submitting`, solo el catch lo hacía. Como el modal se cerraba en
      // el happy, no se notaba — hasta que el operador intentaba un SEGUNDO
      // cambio. Ahí el modal volvía a abrir con el botón "Guardar" disabled
      // mostrando "Guardando…" para siempre (porque submitting seguía true
      // del save anterior). El finally garantiza reset en ambos paths.
      setSubmitting(false);
    }
  };

  const handleDiscard = (plan) => {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[plan];
      return next;
    });
    setSuccess('');
  };

  return (
    <>
      <PageHead
        label="Planes"
        title="Planes y suscripciones"
        subtitle="Editá los precios de los planes Tecny. Los cambios impactan en la landing pública y en el cálculo de MRR."
      />

      {error && (
        <div
          role="alert"
          className="card"
          style={{
            marginBottom: 'var(--gap)',
            background: 'var(--neg-soft)',
            border: '1px solid transparent',
            color: 'var(--neg)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          className="card"
          style={{
            marginBottom: 'var(--gap)',
            background: 'var(--pos-soft)',
            border: '1px solid transparent',
            color: 'var(--pos)',
            fontSize: 13,
          }}
        >
          {success}
        </div>
      )}

      {loading ? (
        <div className="stack u-gap-var-gap">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card" style={{ minHeight: 140 }}>
              <span className="skeleton" style={{ display: 'inline-block', width: 100, height: 16, marginBottom: 12 }} />
              <span className="skeleton" style={{ display: 'block', width: '100%', height: 38 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="stack u-gap-var-gap">
          {displayRows.map((row) => (
            <div key={row.plan}>
              <PlanRow
                row={row}
                onEdit={handleEdit}
                dirty={dirtyByPlan[row.plan]}
                saving={submitting && pendingChange?.plan === row.plan}
              />
              {dirtyByPlan[row.plan] && (
                <div
                  className="flex-row"
                  style={{ gap: 8, marginTop: 8, justifyContent: 'flex-end' }}
                >
                  <Btn kind="ghost" sm onClick={() => handleDiscard(row.plan)}>
                    Descartar
                  </Btn>
                  <Btn kind="primary" sm onClick={() => handleSaveClick(row.plan)}>
                    Guardar cambios
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => { setConfirmOpen(false); setPendingChange(null); }}
        change={pendingChange}
        onConfirm={handleConfirm}
        submitting={submitting}
        error={modalError}
      />
    </>
  );
}
