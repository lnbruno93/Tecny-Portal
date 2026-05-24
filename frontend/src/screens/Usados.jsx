import { useState, useEffect } from 'react';
import { Icons } from '../components/Icons';
import { usados as usadosApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { exportCsv } from '../lib/exportCsv';
import { useToast } from '../contexts/ToastContext';

// ─── Formatter ───────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return Math.round(v).toLocaleString('es-AR');
}

function relDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

const EMPTY_FORM = { equipo: '', capacidad: '', pct_bateria: '', precio_usd: '', comentarios: '' };

export default function Usados() {
  const { toast } = useToast();
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({});   // { id: { field: value } }
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // ── Register global + action ──────────────────────────────────────────────
  const { setPrimaryAction } = usePageActions();
  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo equipo', onClick: () => { setShowCreate(true); setFormError(''); } });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  // ── Create modal ──────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.equipo.trim()) { setFormError('El modelo es obligatorio.'); return; }
    if (form.precio_usd === '' || isNaN(Number(form.precio_usd))) {
      setFormError('Ingresá un precio USD válido.');
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      const nuevo = await usadosApi.create({
        equipo:      form.equipo.trim(),
        capacidad:   form.capacidad.trim() || undefined,
        pct_bateria: form.pct_bateria.trim() || undefined,
        precio_usd:  Number(form.precio_usd),
        comentarios: form.comentarios.trim() || undefined,
      });
      setRows(prev => [...prev, nuevo].sort((a, b) => a.equipo.localeCompare(b.equipo)));
      setShowCreate(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    usadosApi.list()
      .then(data => setRows(Array.isArray(data) ? data : []))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const editCount = Object.keys(edits).length;

  const filtered = rows.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (r.equipo || '').toLowerCase().includes(q) ||
      (r.capacidad || '').toLowerCase().includes(q) ||
      (r.pct_bateria || '').toLowerCase().includes(q)
    );
  });

  const avgPrecio =
    rows.length > 0
      ? rows.reduce((s, r) => s + (Number(r.precio_usd) || 0), 0) / rows.length
      : 0;

  const lastUpdated = rows.reduce((latest, r) => {
    const d = r.created_at ? new Date(r.created_at) : null;
    if (!d) return latest;
    return latest && latest > d ? latest : d;
  }, null);

  // ── Save handler ─────────────────────────────────────────────────────────────
  const editedItems = Object.entries(edits).map(([id, changes]) => ({
    id: Number(id),
    ...changes,
  }));

  async function handleSave() {
    if (editCount === 0) return;
    setSaving(true);
    try {
      await usadosApi.bulkUpdate(editedItems);
      setRows(prev =>
        prev.map(r => edits[r.id] ? { ...r, ...edits[r.id] } : r)
      );
      setEdits({});
      toast.success('Cambios guardados correctamente.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Edit helpers ──────────────────────────────────────────────────────────────
  function setField(id, field, value) {
    setEdits(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }));
  }

  function fieldStyle(id, field) {
    return edits[id]?.[field] !== undefined
      ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
      : {};
  }

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <div className="page-title">Usados | Cotizador</div>
          <div className="page-sub">Catálogo editable · precios en USD · texto libre de batería</div>
        </div>
        <div className="page-actions">
          {editCount > 0 && (
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              <Icons.Check size={15} />
              {saving ? 'Guardando…' : `Guardar ${editCount} cambio${editCount !== 1 ? 's' : ''}`}
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => exportCsv(
              'usados-' + new Date().toLocaleDateString('sv') + '.csv',
              rows,
              [
                { key: 'equipo',      label: 'Equipo'      },
                { key: 'capacidad',   label: 'Capacidad'   },
                { key: 'pct_bateria', label: 'Batería'     },
                { key: 'precio_usd',  label: 'Precio USD'  },
                { key: 'comentarios', label: 'Comentarios' },
              ]
            )}
          >
            <Icons.Download size={15} />
            Exportar
          </button>
          <button className="btn" onClick={() => { setShowCreate(true); setFormError(''); }}>
            <Icons.Plus size={15} />
            Nuevo equipo
          </button>
        </div>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Equipos en catálogo</div>
          <div className="kpi-value mono">{rows.length}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Último registro</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>
            {lastUpdated ? relDate(lastUpdated.toISOString()) : '—'}
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Precio promedio</div>
          <div className="kpi-value">
            <span className="muted" style={{ fontSize: 13 }}>USD </span>
            <span className="mono">{fmt(avgPrecio)}</span>
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Cambios sin guardar</div>
          <div className="kpi-value mono">
            <span className={editCount > 0 ? 'neg' : 'muted'}>{editCount}</span>
          </div>
          <div className="muted tiny" style={{ marginTop: 2 }}>
            {editCount > 0 ? 'Presioná Guardar para aplicar' : 'Todo al día'}
          </div>
        </div>
      </div>

      {/* ── Table card ────────────────────────────────────────────────────── */}
      <div className="card card-flush">
        <div className="card-hd flex-between">
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Catálogo — {filtered.length} equipo{filtered.length !== 1 ? 's' : ''}
          </div>
          <div className="input-group" style={{ width: 240 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input
              className="input"
              placeholder="Buscar equipo o capacidad…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="empty">Cargando catálogo…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">Sin resultados para "{search}"</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Equipo</th>
                <th>Capacidad</th>
                <th>Batería</th>
                <th>Comentarios</th>
                <th className="num">Precio USD</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.equipo}</td>
                  <td className="mono">{r.capacidad || <span className="dim">—</span>}</td>
                  <td>
                    <input
                      type="text"
                      className="input"
                      style={fieldStyle(r.id, 'pct_bateria')}
                      value={edits[r.id]?.pct_bateria ?? r.pct_bateria ?? ''}
                      onChange={e => setField(r.id, 'pct_bateria', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="input"
                      style={fieldStyle(r.id, 'comentarios')}
                      value={edits[r.id]?.comentarios ?? r.comentarios ?? ''}
                      onChange={e => setField(r.id, 'comentarios', e.target.value)}
                      placeholder="—"
                    />
                  </td>
                  <td className="num" style={{ width: 150 }}>
                    <div className="input-group" style={{ width: 130, marginLeft: 'auto' }}>
                      <span className="addon addon-l muted tiny" style={{ padding: '0 8px' }}>USD</span>
                      <input
                        type="number"
                        className="input mono"
                        style={{
                          textAlign: 'right',
                          fontWeight: 600,
                          ...fieldStyle(r.id, 'precio_usd'),
                        }}
                        value={edits[r.id]?.precio_usd ?? r.precio_usd ?? ''}
                        onChange={e => setField(r.id, 'precio_usd', e.target.value)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Create modal ────────────────────────────────────────────────── */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nuevo equipo</h3>
              <button className="icon-btn" onClick={() => setShowCreate(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 2 }}>
                      <label className="field-label">Modelo <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input
                        className="input"
                        placeholder="ej. iPhone 14"
                        value={form.equipo}
                        onChange={e => setForm(f => ({ ...f, equipo: e.target.value }))}
                        autoFocus
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Capacidad</label>
                      <input
                        className="input"
                        placeholder="ej. 128GB"
                        value={form.capacidad}
                        onChange={e => setForm(f => ({ ...f, capacidad: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Batería</label>
                      <input
                        className="input"
                        placeholder="ej. 89%"
                        value={form.pct_bateria}
                        onChange={e => setForm(f => ({ ...f, pct_bateria: e.target.value }))}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Precio USD <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <div className="input-group">
                        <span className="addon addon-l muted tiny" style={{ padding: '0 8px' }}>USD</span>
                        <input
                          type="number"
                          className="input mono"
                          placeholder="0"
                          value={form.precio_usd}
                          onChange={e => setForm(f => ({ ...f, precio_usd: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Comentarios</label>
                    <input
                      className="input"
                      placeholder="Estado, detalles adicionales…"
                      value={form.comentarios}
                      onChange={e => setForm(f => ({ ...f, comentarios: e.target.value }))}
                    />
                  </div>
                  {formError && (
                    <div style={{ color: 'var(--neg)', fontSize: 13 }}>{formError}</div>
                  )}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Guardando…' : 'Crear equipo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
