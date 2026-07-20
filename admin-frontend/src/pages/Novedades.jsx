// Pantalla Novedades — CMS de release notes (task #142, 2026-07-16).
//
// Contexto: en 48h se mergearon 13 PRs con features y fixes visibles al
// usuario, pero el cliente no se entera → dudas por WhatsApp. Este CMS
// permite comunicar oficialmente los cambios.
//
// Diseño:
//   · GLOBAL cross-tenant — las notas se muestran a TODOS los clientes.
//     No confundir con CMS Landing (también global) ni config (per-tenant).
//   · Tabla izquierda: lista publicada ordenada DESC por publicado_en.
//   · Panel derecho sticky: form crear/editar con contador de chars,
//     segmented control de tipo, y vista previa live del cliente.
//   · Botón "＋ Nueva nota" en el header abre el form vacío (o cierra si
//     ya estaba abierto). Editar una nota carga sus datos en el form.
//
// Backend: adminApi.releaseNotes.{list, create, update, remove} →
//   /api/super-admin/release-notes (super-admin only, sin RLS).
//
// Portal cliente: la lista se lee desde /api/release-notes (público, con
// requireAuth). El badge del sidebar consume /count-unseen y se limpia
// con POST /mark-seen cuando el user abre /novedades allá.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, PageHead, Seg } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import { fmtDateTime } from '../lib/format.js';

const TIPOS = [
  { value: 'feature', label: '🚀 Feature', desc: 'Feature nueva' },
  { value: 'mejora',  label: '✨ Mejora',  desc: 'Mejora sobre algo existente' },
  { value: 'fix',     label: '🐛 Fix',     desc: 'Corrección de bug' },
];

// Límites duplicados del backend (CHECK constraints en la migration).
// Los enforceamos client-side para el contador + UX inmediato.
const MAX_TITULO = 60;
const MAX_DESCRIPCION = 280;

// Emoji + label del tipo para la vista previa. Coincide con el render del
// portal cliente (frontend/src/screens/Novedades.jsx) — mantener sincronizado.
const TIPO_META = {
  feature: { emoji: '🚀', label: 'Feature', tone: 'info'  },
  mejora:  { emoji: '✨', label: 'Mejora',  tone: 'pos'   },
  fix:     { emoji: '🐛', label: 'Fix',     tone: 'warn'  },
};

const EMPTY_FORM = { titulo: '', descripcion: '', tipo: 'feature', publicado_en: '' };

export default function Novedades() {
  const [notas, setNotas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Form state. `editingId` distingue create vs update. Cuando es null y
  // form no está dirty, el panel muestra "Nueva nota". Cuando editingId
  // apunta a un id, el panel muestra "Editando nota".
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);

  // Confirmación de delete inline (no modal). Guarda el id de la nota
  // pendiente de confirmación — al segundo click se hace el delete.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.releaseNotes.list();
      setNotas(res.release_notes || []);
    } catch (e) {
      setError(e.message || 'No se pudo cargar la lista.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormError(null);
  };

  const startEdit = (nota) => {
    setEditingId(nota.id);
    setForm({
      titulo:       nota.titulo || '',
      descripcion:  nota.descripcion || '',
      tipo:         nota.tipo || 'feature',
      publicado_en: nota.publicado_en || '',
    });
    setFieldErrors({});
    setFormError(null);
    setConfirmDeleteId(null);
  };

  const setField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    // Limpiar error del field al empezar a tipear — feedback inmediato.
    if (fieldErrors[key]) {
      setFieldErrors((e) => { const n = { ...e }; delete n[key]; return n; });
    }
  };

  // Validación local espejo del backend. Devuelve object con field errors
  // o null si todo OK. Mantiene UX rápida (sin roundtrip para errores obvios).
  const validate = () => {
    const errs = {};
    const t = form.titulo.trim();
    const d = form.descripcion.trim();
    if (!t) errs.titulo = 'Requerido.';
    else if (t.length > MAX_TITULO) errs.titulo = `Máx. ${MAX_TITULO} caracteres.`;
    if (!d) errs.descripcion = 'Requerido.';
    else if (d.length > MAX_DESCRIPCION) errs.descripcion = `Máx. ${MAX_DESCRIPCION} caracteres.`;
    if (!TIPO_META[form.tipo]) errs.tipo = 'Tipo inválido.';
    return Object.keys(errs).length ? errs : null;
  };

  const submit = async () => {
    const errs = validate();
    if (errs) { setFieldErrors(errs); return; }

    setSaving(true);
    setFormError(null);
    try {
      const body = {
        titulo:       form.titulo.trim(),
        descripcion:  form.descripcion.trim(),
        tipo:         form.tipo,
        // publicado_en vacío → backend usa NOW(). Solo mandamos si el user
        // metió algo — pero por ahora no exponemos input custom (siempre
        // NOW en la práctica). El editingId flow SÍ preserva el valor
        // original si el user no lo tocó.
        ...(form.publicado_en ? { publicado_en: form.publicado_en } : {}),
      };

      if (editingId) {
        await adminApi.releaseNotes.update(editingId, body);
      } else {
        await adminApi.releaseNotes.create(body);
      }

      await load();
      startNew();
    } catch (e) {
      // Backend devuelve { error, fields } en 400. Mostramos los fields
      // en línea (los mismos keys que nuestro validate local) + un msg
      // general por si es otro error (401, 500).
      if (e.status === 400 && e.body?.fields) {
        setFieldErrors(e.body.fields);
      } else {
        setFormError(e.message || 'No se pudo guardar la nota.');
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    setSaving(true);
    setFormError(null);
    try {
      await adminApi.releaseNotes.remove(id);
      setConfirmDeleteId(null);
      // Si estábamos editando la nota borrada, resetear el form.
      if (editingId === id) startNew();
      await load();
    } catch (e) {
      setFormError(e.message || 'No se pudo borrar la nota.');
    } finally {
      setSaving(false);
    }
  };

  const titleCount = form.titulo.length;
  const descCount = form.descripcion.length;
  const titleWarn = titleCount > MAX_TITULO;
  const descWarn = descCount > MAX_DESCRIPCION;

  return (
    <div>
      <PageHead
        label="Contenido"
        title="Novedades"
        subtitle="Publicá cambios y features que los clientes verán en su portal (badge en el sidebar + pantalla /novedades)."
        actions={
          <Btn kind="primary" icon="Plus" onClick={startNew}>
            Nueva nota
          </Btn>
        }
      />

      {/* Callout informativo: recordar que es cross-tenant. Ayuda a evitar
          que Lucas escriba una nota pensando "esto es para X cliente" — no
          hay per-tenant en release notes por diseño. */}
      <div
        className="callout"
        role="note"
        style={{
          padding: '10px 14px',
          background: 'var(--accent-soft)',
          border: '1px solid rgba(14,165,233,0.28)',
          borderRadius: 8,
          fontSize: 13,
          color: 'var(--text-2)',
          marginBottom: 16,
          display: 'flex',
          gap: 10,
        }}
      >
        <span aria-hidden="true">ℹ️</span>
        <span>
          Las notas son <strong>globales cross-tenant</strong> — se muestran a
          todos los clientes del portal. Es tu comunicación oficial de producto.
        </span>
      </div>

      <div
        className="grid-2col"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 400px',
          gap: 20,
          alignItems: 'start',
        }}
      >
        {/* ── LISTADO ─────────────────────────────────────────────── */}
        <Card
          flush
          title={`Notas publicadas${notas.length ? ` (${notas.length})` : ''}`}
          subtitle={notas.length ? `Última: ${fmtDateTime(notas[0].publicado_en)}` : null}
        >
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Cargando…
            </div>
          ) : error ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--neg)', fontSize: 13 }}>
              {error}
              <div style={{ marginTop: 12 }}>
                <Btn sm onClick={load}>Reintentar</Btn>
              </div>
            </div>
          ) : notas.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No hay notas publicadas todavía.
              <div style={{ marginTop: 12 }}>
                <Btn sm kind="primary" icon="Plus" onClick={startNew}>
                  Crear la primera
                </Btn>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="tbl" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 92 }} />
                  <col />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 150 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Título / Descripción</th>
                    <th>Publicada</th>
                    <th style={{ textAlign: 'right' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map((n) => (
                    <tr
                      key={n.id}
                      style={{
                        background: editingId === n.id ? 'var(--accent-soft)' : undefined,
                      }}
                    >
                      <td>
                        <TipoPill tipo={n.tipo} />
                      </td>
                      <td style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>
                          {n.titulo}
                        </div>
                        <div
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: 12,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: '-webkit-box',
                            WebkitLineClamp: 1,
                            WebkitBoxOrient: 'vertical',
                          }}
                        >
                          {n.descripcion}
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {fmtDateTime(n.publicado_en)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          <Btn sm kind="ghost" onClick={() => startEdit(n)}>
                            Editar
                          </Btn>
                          {confirmDeleteId === n.id ? (
                            <>
                              <Btn sm kind="danger" onClick={() => remove(n.id)} disabled={saving}>
                                Confirmar
                              </Btn>
                              <Btn sm kind="ghost" onClick={() => setConfirmDeleteId(null)}>
                                No
                              </Btn>
                            </>
                          ) : (
                            <Btn sm kind="ghost" onClick={() => setConfirmDeleteId(n.id)}>
                              Borrar
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ── FORM PANEL ──────────────────────────────────────────── */}
        <div style={{ position: 'sticky', top: 16 }}>
          <Card
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--accent)', display: 'inline-block',
                  }}
                />
                {editingId ? 'Editar nota' : 'Nueva nota'}
              </span>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Tipo */}
              <Field label="Tipo" error={fieldErrors.tipo}>
                <Seg
                  value={form.tipo}
                  options={TIPOS.map((t) => ({ value: t.value, label: t.label }))}
                  onChange={(v) => setField('tipo', v)}
                />
              </Field>

              {/* Título */}
              <Field
                label="Título"
                error={fieldErrors.titulo}
                counter={<Counter n={titleCount} max={MAX_TITULO} warn={titleWarn} />}
              >
                <input
                  type="text"
                  className={fieldErrors.titulo ? 'input error' : 'input'}
                  placeholder="Ej: Filtro por vendedor en Dashboard"
                  value={form.titulo}
                  onChange={(e) => setField('titulo', e.target.value)}
                  maxLength={MAX_TITULO + 20 /* dejamos algo de margen para que el warn se vea */}
                  autoFocus
                />
              </Field>

              {/* Descripción */}
              <Field
                label="Descripción"
                error={fieldErrors.descripcion}
                counter={<Counter n={descCount} max={MAX_DESCRIPCION} warn={descWarn} />}
                hint="Explicá qué cambió, con qué frase la va a entender el cliente."
              >
                <textarea
                  className={fieldErrors.descripcion ? 'input error' : 'input'}
                  rows={4}
                  value={form.descripcion}
                  onChange={(e) => setField('descripcion', e.target.value)}
                  style={{ resize: 'vertical', minHeight: 80 }}
                />
              </Field>

              {/* Vista previa */}
              <Preview form={form} />

              {formError && (
                <div
                  role="alert"
                  style={{
                    padding: '8px 10px',
                    background: 'var(--neg-soft)',
                    color: 'var(--neg)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  {formError}
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                }}
              >
                {editingId && (
                  <Btn kind="ghost" onClick={startNew} disabled={saving}>
                    Cancelar
                  </Btn>
                )}
                <Btn
                  kind="primary"
                  onClick={submit}
                  disabled={saving}
                  className="grow u-flex-1"
                >
                  {saving ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Publicar nota'}
                </Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────

function TipoPill({ tipo }) {
  const meta = TIPO_META[tipo] || TIPO_META.feature;
  const tone = meta.tone; // 'info' | 'pos' | 'warn'
  const bg = `var(--${tone}-soft)`;
  const fg = `var(--${tone})`;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        background: bg,
        color: fg,
      }}
    >
      {meta.label}
    </span>
  );
}

function Field({ label, error, counter, hint, children }) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
      {counter}
      {hint && !error && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          {hint}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 11, color: 'var(--neg)', marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

function Counter({ n, max, warn }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: warn ? 'var(--neg)' : 'var(--text-dim)',
        textAlign: 'right',
        marginTop: 4,
      }}
    >
      {n} / {max}
    </div>
  );
}

function Preview({ form }) {
  const meta = TIPO_META[form.tipo] || TIPO_META.feature;
  const titulo = form.titulo.trim() || <span style={{ color: 'var(--text-dim)' }}>(sin título)</span>;
  const desc = form.descripcion.trim() || <span style={{ color: 'var(--text-dim)' }}>(sin descripción)</span>;
  return (
    <div
      style={{
        padding: 12,
        background: 'var(--surface-2)',
        border: '1px dashed var(--border)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-dim)',
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        Vista previa en el portal cliente
      </div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
        <span aria-hidden="true">{meta.emoji}</span> {titulo}
      </div>
      <div style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.5 }}>
        {desc}
      </div>
    </div>
  );
}
