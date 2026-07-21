// Card admin para gestionar los logos de empresas que confiaron en Tecny
// (CMS Landing Fase 4, 2026-07-18).
//
// A diferencia del resto de secciones de SitioPublico.jsx (que usan un
// diff-tracking + PATCH atómico sobre `site_landing_config`), este feature
// tiene endpoints CRUD granulares — una fila por row. Cada acción (agregar,
// renombrar, reordenar, eliminar) hace un API call inmediato al backend.
// Motivo: los logos son binarios (base64), no queremos re-enviar todo el
// array en cada save.
//
// Backend endpoints:
//   GET    /api/super-admin/trusted-companies       → lista
//   POST   /api/super-admin/trusted-companies       → { nombre, logo_data, logo_mime, logo_nombre? }
//   PATCH  /api/super-admin/trusted-companies/:id   → { nombre?, position? }
//   DELETE /api/super-admin/trusted-companies/:id
//
// Preview del logo: <img src="/api/public/trusted-companies/:id/logo"> —
// el endpoint público sirve el blob con Cache-Control 24h immutable, así
// que el browser cachea agresivamente y no re-baja en cada render.

import { useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, resolveApiBase } from '../lib/api.js';
import { Btn, Card } from './primitives/index.jsx';
import { Icons } from './Icons.jsx';

// 2026-07-19 hotfix: los <img src="..."> del preview del logo necesitan el
// URL completo del backend (admin.tecnyapp.com es SPA estático — un path
// relativo tipo `/api/public/...` resolvería contra admin.tecnyapp.com/api
// que no existe, resultando en 404 y "?" en la card). Reutilizamos el
// mismo helper que api.js usa para todos los fetch — mismo VITE_API_URL,
// mismo fallback a prod si la env var falta.
const BACKEND_BASE = resolveApiBase(import.meta.env.VITE_API_URL);

const MIME_ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
// Cap defensivo en el cliente (matchea el schema Zod del backend: ~4MB decoded).
// El backend rechaza igual, pero avisar antes del upload ahorra un round-trip.
const MAX_FILE_SIZE = 4 * 1024 * 1024;

// Convierte un File a base64 sin el prefix `data:*/*;base64,`. El backend
// espera el string base64 pelado (fileStore lo materializa a Buffer al put).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const idx = typeof result === 'string' ? result.indexOf(',') : -1;
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

export default function TrustedCompaniesCard() {
  const [companies, setCompanies] = useState([]);
  const [limit, setLimit] = useState(40);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  // Modal "Agregar empresa"
  const [showAdd, setShowAdd] = useState(false);
  const [addNombre, setAddNombre] = useState('');
  const [addFile, setAddFile] = useState(null);
  const [addPreview, setAddPreview] = useState(null);
  const [adding, setAdding] = useState(false);
  const addFileInputRef = useRef(null);
  // Edit inline: id de la fila que está siendo renombrada + valor temporal
  const [editingId, setEditingId] = useState(null);
  const [editingNombre, setEditingNombre] = useState('');
  // Track de acciones en curso (reorder / delete) para deshabilitar botones.
  const [busyId, setBusyId] = useState(null);

  const canAdd = useMemo(() => companies.length < limit, [companies, limit]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const r = await adminApi.listTrustedCompanies();
        if (cancelled) return;
        setCompanies(r?.companies || []);
        setLimit(r?.limit || 40);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'No se pudo cargar el listado.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function showSuccess(msg) {
    setSavedMsg(msg);
    // Auto-dismiss en 3s para no dejar el flash de éxito colgado.
    setTimeout(() => setSavedMsg(''), 3000);
  }

  function resetAddModal() {
    setAddNombre('');
    setAddFile(null);
    setAddPreview(null);
    setError('');
  }
  function openAdd() { resetAddModal(); setShowAdd(true); }
  function closeAdd() { resetAddModal(); setShowAdd(false); }

  async function handleFileChange(e) {
    setError('');
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setError(`El archivo pesa ${(file.size / 1024 / 1024).toFixed(1)}MB. Máximo ${MAX_FILE_SIZE / 1024 / 1024}MB — optimizá antes de subir.`);
      e.target.value = '';
      return;
    }
    setAddFile(file);
    // Preview local via ObjectURL — se libera cuando cerramos el modal
    // (browser lo garbage-collectea con la ref).
    const url = URL.createObjectURL(file);
    setAddPreview(url);
  }

  async function submitAdd(e) {
    e?.preventDefault();
    if (!addNombre.trim()) { setError('Ingresá el nombre de la empresa.'); return; }
    if (!addFile) { setError('Elegí un archivo de logo.'); return; }
    setAdding(true);
    setError('');
    try {
      const base64 = await fileToBase64(addFile);
      const created = await adminApi.createTrustedCompany({
        nombre: addNombre.trim(),
        logo_data: base64,
        logo_mime: addFile.type,
        logo_nombre: addFile.name,
      });
      setCompanies(prev => [...prev, created]);
      showSuccess(`Empresa "${created.nombre}" agregada.`);
      closeAdd();
    } catch (err) {
      setError(err?.message || 'No se pudo crear la empresa.');
    } finally {
      setAdding(false);
    }
  }

  async function handleRename(id) {
    const trimmed = editingNombre.trim();
    if (!trimmed) { setError('El nombre no puede estar vacío.'); return; }
    const original = companies.find(c => c.id === id);
    if (!original) return;
    if (original.nombre === trimmed) { setEditingId(null); return; }
    setBusyId(id);
    setError('');
    try {
      const updated = await adminApi.updateTrustedCompany(id, { nombre: trimmed });
      setCompanies(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
      setEditingId(null);
      showSuccess('Nombre actualizado.');
    } catch (err) {
      setError(err?.message || 'No se pudo renombrar.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleMove(idx, direction) {
    // Swap con el vecino: A ↔ B → intercambiar `position` de ambas rows.
    // Dos PATCH (uno por row) — no atómico, pero el peor caso (crash entre
    // ambas) deja el orden con un gap que se auto-corrige al próximo reorder.
    const other = idx + direction;
    if (other < 0 || other >= companies.length) return;
    const a = companies[idx];
    const b = companies[other];
    setBusyId(a.id);
    setError('');
    try {
      const [ua, ub] = await Promise.all([
        adminApi.updateTrustedCompany(a.id, { position: b.position }),
        adminApi.updateTrustedCompany(b.id, { position: a.position }),
      ]);
      setCompanies(prev => {
        const next = prev.slice();
        next[idx] = { ...a, ...ua };
        next[other] = { ...b, ...ub };
        // Reordenar el array por position después del swap.
        return next.sort((x, y) => x.position - y.position);
      });
    } catch (err) {
      setError(err?.message || 'No se pudo reordenar.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id, nombre) {
    // Confirm nativo — no queremos meter un ConfirmModal solo para esto.
    if (!confirm(`¿Eliminar "${nombre}"? Se borra el logo del bucket y no aparece más en la landing.`)) return;
    setBusyId(id);
    setError('');
    try {
      await adminApi.deleteTrustedCompany(id);
      setCompanies(prev => prev.filter(c => c.id !== id));
      showSuccess(`Empresa "${nombre}" eliminada.`);
    } catch (err) {
      setError(err?.message || 'No se pudo eliminar.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <div className="u-p-20-grid-gap-16">
        <div className="u-flex-between-start-16">
          <div>
            <h3 className="u-m-0-fs-16-fw-600">
              Empresas que confiaron en Tecny
            </h3>
            <p className="muted u-m-4-0-0-fs-13">
              Grid de logos que se muestra en la landing como carrusel infinito.
              Máximo {limit} empresas. Los logos ideales son PNG/SVG con fondo transparente
              (se aplica filter grayscale en la landing).
              {' '}
              {companies.length} / {limit} cargadas.
            </p>
          </div>
          <Btn variant="primary" onClick={openAdd} disabled={loading || !canAdd}>
            <Icons.Plus size={14} /> Agregar empresa
          </Btn>
        </div>

        {error && (
          <div role="alert" style={{
            padding: 10, borderRadius: 6, fontSize: 13,
            background: 'rgba(220, 38, 38, 0.08)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            color: 'var(--neg)',
          }}>{error}</div>
        )}
        {savedMsg && (
          <div role="status" style={{
            padding: 10, borderRadius: 6, fontSize: 13,
            background: 'rgba(16, 185, 129, 0.08)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            color: 'var(--pos)',
          }}>{savedMsg}</div>
        )}

        {loading ? (
          <div className="muted u-p-16-text-center">Cargando…</div>
        ) : companies.length === 0 ? (
          <div className="muted" style={{ padding: 16, textAlign: 'center',
               border: '1px dashed var(--hairline)', borderRadius: 8, fontSize: 13 }}>
            Todavía no cargaste ninguna empresa. Al no haber ninguna, la sección
            se oculta en la landing.
          </div>
        ) : (
          <div style={{
            display: 'grid', gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          }}>
            {companies.map((c, idx) => (
              <div key={c.id} style={{
                padding: 12, borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.02)',
                display: 'grid', gap: 10, alignContent: 'space-between',
                opacity: busyId === c.id ? 0.5 : 1,
              }}>
                {/* Preview del logo — 100% width, altura fija, contain para no deformar */}
                <div style={{
                  height: 64,
                  background: '#fff',
                  borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 8,
                }}>
                  <img
                    src={`${BACKEND_BASE}/api/public/trusted-companies/${c.id}/logo`}
                    alt={c.nombre}
                    className="u-img-contain-full"
                  />
                </div>

                {/* Nombre — editable inline con click */}
                {editingId === c.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); handleRename(c.id); }}
                        className="u-flex-gap-4">
                    <input
                      className="input"
                      autoFocus
                      value={editingNombre}
                      onChange={(e) => setEditingNombre(e.target.value)}
                      onBlur={() => handleRename(c.id)}
                      disabled={busyId === c.id}
                      maxLength={120}
                      className="u-fs-13"
                    />
                    <button type="submit" className="icon-btn" title="Guardar"
                            disabled={busyId === c.id}>✓</button>
                  </form>
                ) : (
                  <div
                    onClick={() => { setEditingId(c.id); setEditingNombre(c.nombre); }}
                    title="Click para renombrar"
                    style={{
                      fontSize: 13, fontWeight: 500,
                      cursor: 'pointer',
                      padding: '4px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    {c.nombre}
                  </div>
                )}

                {/* Acciones: reorder + delete */}
                <div className="u-flex-between-center-nogap">
                  <div className="muted tiny">#{idx + 1}</div>
                  <div className="u-flex-gap-4">
                    <button type="button" className="icon-btn"
                            onClick={() => handleMove(idx, -1)}
                            disabled={busyId !== null || idx === 0}
                            title="Subir">▲</button>
                    <button type="button" className="icon-btn"
                            onClick={() => handleMove(idx, 1)}
                            disabled={busyId !== null || idx === companies.length - 1}
                            title="Bajar">▼</button>
                    <button type="button" className="icon-btn"
                            onClick={() => handleDelete(c.id, c.nombre)}
                            disabled={busyId !== null}
                            title="Eliminar">
                      <Icons.Trash size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal "Agregar empresa" */}
      {showAdd && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <form onSubmit={submitAdd} style={{
            width: '100%', maxWidth: 480,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 20,
            display: 'grid', gap: 14,
          }}>
            <div className="u-flex-between-center-nogap">
              <h3 className="u-m-0-fs-16">Agregar empresa</h3>
              <button type="button" className="icon-btn" onClick={closeAdd} aria-label="Cerrar">
                <Icons.X size={16} />
              </button>
            </div>

            <div className="field">
              <label className="muted tiny u-mb-4-block">
                Nombre de la empresa
              </label>
              <input
                className="input"
                autoFocus
                value={addNombre}
                onChange={(e) => setAddNombre(e.target.value)}
                placeholder="Ej. ACME Corp"
                maxLength={120}
                disabled={adding}
              />
            </div>

            <div className="field">
              <label className="muted tiny u-mb-4-block">
                Logo (PNG, JPG, WebP, GIF o SVG — máx 4MB)
              </label>
              <input
                ref={addFileInputRef}
                type="file"
                accept={MIME_ACCEPTED}
                onChange={handleFileChange}
                disabled={adding}
              />
              {addPreview && (
                <div style={{
                  marginTop: 8,
                  height: 80,
                  background: '#fff',
                  borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 8,
                }}>
                  <img
                    src={addPreview}
                    alt="Preview"
                    className="u-img-contain-full"
                  />
                </div>
              )}
            </div>

            {error && (
              <div role="alert" style={{
                padding: 8, borderRadius: 6, fontSize: 12,
                background: 'rgba(220, 38, 38, 0.08)',
                border: '1px solid rgba(220, 38, 38, 0.3)',
                color: 'var(--neg)',
              }}>{error}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" onClick={closeAdd} disabled={adding} type="button">
                Cancelar
              </Btn>
              <Btn variant="primary" type="submit" disabled={adding || !addNombre.trim() || !addFile}>
                {adding ? 'Subiendo…' : 'Agregar'}
              </Btn>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}
