// Pantalla TC defaults por país — editor de tipos de cambio por defecto (#470).
//
// Multi-país F4 (#470): expone GET/PATCH /api/super-admin/tc-defaults-pais en
// el back-office para que Lucas (super-admin) pueda actualizar el TC por defecto
// que se pre-rellena en cotizador + forms de venta/pago, sin tener que tocar SQL.
//
// El endpoint backend ya existe (F2 #471). Esta pantalla:
//   1. GET al mount → lista 2 filas (AR ARS/USD, UY UYU/USD).
//   2. User edita el valor inline (input numérico).
//   3. Botón "Guardar" dispara PATCH → backend valida cross-check pais↔par +
//      audita en tenant_admin_actions con action='tc_default_pais_updated'.
//   4. La response trae la fila actualizada; refrescamos el cache local.
//
// Decisiones de diseño:
//   · Sin modal de confirmación (a diferencia de Planes): el TC se actualiza
//     periódicamente (cuasi-diariamente para AR por inflación), un click + save
//     es el flow esperado. Si en el futuro queremos audit narrative se puede
//     agregar input `reason` inline opcional.
//   · 2 filas máximo hoy → no paginamos, no virtualizamos. Tabla simple.
//   · Estado dirty + botón Guardar solo se habilita si el valor cambió.
//   · Estado saving por row (no global) — si una falla la otra sigue editable.
//
// Patrón mimic de Planes.jsx (la pantalla más cercana en función). Reusa
// primitives Btn/Card/Badge/PageHead + fmtDateTime de format.js.

import { useEffect, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, Badge, PageHead } from '../components/primitives/index.jsx';
import { fmtDateTime } from '../lib/format.js';

// Helper de display: emoji bandera + nombre país.
function paisLabel(pais) {
  if (pais === 'UY') return '🇺🇾 Uruguay';
  if (pais === 'AR') return '🇦🇷 Argentina';
  return pais;
}

// Helper: key estable para el draft/saving state (combo pais+par).
function rowKey(pais, par) {
  return `${pais}_${par}`;
}

export default function TcDefaults() {
  // `rows`: snapshot del backend (read-only, base de comparación para dirty).
  // `drafts`: valor del input por row { 'AR_ARS/USD': '1400', 'UY_UYU/USD': '40' }.
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // `savingByRow`: { rowKey: true } durante el PATCH de esa row específica.
  // No usamos un global porque queremos que si una falla, la otra siga editable.
  const [savingByRow, setSavingByRow] = useState({});

  // Carga inicial. Extraemos a función para reusar post-PATCH si quisiéramos
  // refrescar (por ahora hacemos update in-place desde la response del PATCH).
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await adminApi.getTcDefaultsPais();
      const list = Array.isArray(data?.tc_defaults) ? data.tc_defaults : [];
      setRows(list);
      // Sembrar drafts con los valores actuales — sin esto el input arranca
      // vacío y "Guardar" se habilita inmediatamente sin haber cambiado nada.
      const initialDrafts = {};
      for (const r of list) {
        initialDrafts[rowKey(r.pais, r.par)] = r.valor != null ? String(r.valor) : '';
      }
      setDrafts(initialDrafts);
    } catch (err) {
      setError(err?.message || 'No pudimos cargar los TC defaults.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDraftChange = (pais, par, newValue) => {
    setDrafts((prev) => ({ ...prev, [rowKey(pais, par)]: newValue }));
    setSuccess('');
    setError('');
  };

  const isDirty = (row) => {
    const draft = drafts[rowKey(row.pais, row.par)];
    if (draft == null || draft === '') return false;
    const draftNum = Number(draft);
    if (!Number.isFinite(draftNum)) return false;
    return Math.abs(draftNum - Number(row.valor)) > 1e-9;
  };

  const handleSave = async (row) => {
    const key = rowKey(row.pais, row.par);
    const draft = drafts[key];
    const valor = Number(draft);

    // Validación cliente — mirror del Zod backend (positivo + cap 1M).
    if (!Number.isFinite(valor) || valor <= 0) {
      setError(`Valor inválido para ${paisLabel(row.pais)}. Debe ser un número > 0.`);
      return;
    }
    if (valor > 1_000_000) {
      setError(`Valor excede el máximo permitido (1.000.000).`);
      return;
    }

    setSavingByRow((s) => ({ ...s, [key]: true }));
    setError('');
    setSuccess('');
    try {
      const updated = await adminApi.updateTcDefaultPais({
        pais: row.pais,
        par: row.par,
        valor,
      });
      // Update in-place — la response trae { pais, par, valor, updated_at,
      // updated_by, noop }. Reemplazamos la row preservando el username
      // (que NO viene en PATCH, solo en GET). Si nos importa el username
      // actualizado podemos `await load()` en su lugar; por ahora optimizamos
      // el round-trip y mantenemos el username del cache local.
      setRows((arr) =>
        arr.map((r) =>
          r.pais === row.pais && r.par === row.par
            ? {
                ...r,
                valor: Number(updated.valor),
                updated_at: updated.updated_at,
                updated_by: updated.updated_by,
                // updated_by_username queda con el valor previo — el username
                // del usuario actual sería más correcto pero requeriría
                // pasarlo desde el AuthContext. Trade-off menor.
              }
            : r
        )
      );
      // Refrescamos draft al valor canonical del backend (puede haber sido
      // redondeado).
      setDrafts((s) => ({ ...s, [key]: String(updated.valor) }));
      setSuccess(
        updated.noop
          ? `Sin cambios para ${paisLabel(row.pais)}: el valor era idéntico.`
          : `${paisLabel(row.pais)} ${row.par} actualizado a ${updated.valor}.`
      );
    } catch (err) {
      setError(err?.message || 'No pudimos guardar el cambio.');
    } finally {
      setSavingByRow((s) => ({ ...s, [key]: false }));
    }
  };

  return (
    <>
      <PageHead
        label="TC defaults"
        title="TC defaults por país"
        subtitle="Valor del tipo de cambio pre-rellenado en cotizador y forms de venta/pago para tenants de cada país. Editable solo por super-admin."
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
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          {[0, 1].map((i) => (
            <div key={i} className="card" style={{ minHeight: 120 }}>
              <span className="skeleton" style={{ display: 'inline-block', width: 120, height: 16, marginBottom: 12 }} />
              <span className="skeleton" style={{ display: 'block', width: '100%', height: 38 }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        // Empty state defensivo — no debería ocurrir si la migration F1 corrió
        // (seedea 2 filas), pero protege la pantalla contra un backend roto.
        <Card>
          <p className="muted">No hay TC defaults configurados. Verificá que la migration 20260629100003 haya corrido.</p>
        </Card>
      ) : (
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          {rows.map((row) => {
            const key = rowKey(row.pais, row.par);
            const draftValue = drafts[key] ?? '';
            const dirty = isDirty(row);
            const saving = !!savingByRow[key];
            const inputId = `tc-input-${key}`;
            return (
              <Card key={key} flush>
                <header className="card-hd">
                  <div className="flex-row" style={{ gap: 10, alignItems: 'center' }}>
                    <Badge tone={row.pais === 'UY' ? 'info' : 'default'}>
                      {paisLabel(row.pais)}
                    </Badge>
                    <span className="muted tiny">par {row.par}</span>
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
                  <div className="stack" style={{ gap: 12 }}>
                    <div>
                      <label className="form-label" htmlFor={inputId}>
                        Valor ({row.par})
                      </label>
                      <input
                        id={inputId}
                        className="input"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        max="1000000"
                        value={draftValue}
                        onChange={(e) => handleDraftChange(row.pais, row.par, e.target.value)}
                        disabled={saving}
                        aria-label={`Valor TC default ${row.pais} ${row.par}`}
                      />
                      <div className="muted tiny" style={{ marginTop: 4 }}>
                        Pre-rellenado en cotizador, ventas y pagos de tenants {row.pais}.
                      </div>
                    </div>

                    <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <Btn
                        kind="primary"
                        sm
                        disabled={!dirty || saving}
                        onClick={() => handleSave(row)}
                      >
                        {saving ? 'Guardando…' : 'Guardar'}
                      </Btn>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
