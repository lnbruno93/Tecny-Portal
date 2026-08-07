// Cards CMS Landing Fase 5 (2026-08-06) — 5 secciones adicionales editables
// desde admin.tecnyapp.com/sitio-publico:
//
//   1. Módulos      — array de cards "Los módulos" (max 12)
//   2. Cómo funciona — array de steps (max 6)
//   3. Tus datos     — array de pilares (max 6)
//   4. Canje         — objeto {steps, catalogo} (2 sub-arrays)
//   5. Cotizador     — objeto {productos, recargos}
//
// Por qué archivo aparte: SitioPublico.jsx ya tenía 774 líneas antes de este
// batch. Sumar 5 cards inline lo dejaba en ~1300 — arriba del threshold que
// el runbook del repo dice para split. Precedente: TrustedCompaniesCard.jsx
// (Fase 4) también se extrajo por razón análoga aunque el motivo ahí fue
// que tenía CRUD granular propio.
//
// Cada card es un componente controlado — recibe { value, original, onChange,
// saving } del parent. Padre mantiene el estado + diff-tracking + save
// atómico via PATCH. Consistencia con el patrón FAQ/testimonials del file
// principal (mismo diff → PATCH → refresh from response).
//
// Constantes de validación deben coincidir 1:1 con el schema Zod del backend
// (backend/src/schemas/superAdmin.js Fase 5). Cualquier cambio ahí requiere
// mirror aquí — no hay contract test cross-repo por ahora.

import { Btn, Card } from './primitives/index.jsx';
import { Icons } from './Icons.jsx';

// ═══════════════════════════════════════════════════════════════════════════
// Constantes espejo del schema Zod backend/src/schemas/superAdmin.js
// ═══════════════════════════════════════════════════════════════════════════

const TINT_OPTIONS = [
  { value: 'tint-blue',   label: 'Azul'    },
  { value: 'tint-amber',  label: 'Ámbar'   },
  { value: 'tint-green',  label: 'Verde'   },
  { value: 'tint-purple', label: 'Violeta' },
  { value: 'tint-cyan',   label: 'Cian'    },
  { value: 'tint-pink',   label: 'Rosa'    },
  { value: 'tint-orange', label: 'Naranja' },
];

const ICON_MODULOS_OPTIONS = [
  { value: 'inventario',   label: 'Inventario'        },
  { value: 'cotizador',    label: 'Cotizador'         },
  { value: 'cuentascc',    label: 'Cuentas corrientes' },
  { value: 'cajas',        label: 'Cajas'             },
  { value: 'usados',       label: 'Usados / Canje'    },
  { value: 'comprobantes', label: 'Comprobantes'      },
  { value: 'envios',       label: 'Envíos'            },
];

const ICON_COMO_OPTIONS = [
  { value: 'inventario', label: 'Inventario' },
  { value: 'venta',      label: 'Venta'      },
  { value: 'saldos',     label: 'Saldos'     },
  { value: 'metricas',   label: 'Métricas'   },
];

// Deep-equal por serialización para arrays chicos (patrón usado en el file
// principal para testimonials y faq — mismo tradeoff: sub-ms para nuestros
// tamaños, evita traer una dep de deep-equal).
export function sameJSON(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// _tempId helper — misma convención que emptyFaq/emptyTestimonial. Se strip
// antes de mandar al backend porque el server genera UUIDs para items sin id.
function tempId() {
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sanitizers para el payload PATCH — strip _tempId + campos vacíos opcionales
// ═══════════════════════════════════════════════════════════════════════════

// Ómite claves con undefined/null/'' para no mandar objects vacíos que Zod
// pueda rechazar. Mantiene 0 y false porque son valores válidos.
function omitEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

export function sanitizeModulos(arr) {
  return (arr || []).map(m => {
    const { _tempId, badges, link, ...rest } = m;
    const clean = omitEmpty(rest);
    // wide es booleano opcional — solo enviamos si true (Zod acepta undefined).
    if (m.wide === true) clean.wide = true;
    if (Array.isArray(badges) && badges.length > 0) {
      clean.badges = badges
        .filter(b => b && (b.text || '').trim() !== '')
        .map(b => {
          const { _tempId: _bt, ...rb } = b;
          const cb = { text: rb.text.trim() };
          if (rb.hi === true) cb.hi = true;
          return cb;
        });
      if (clean.badges.length === 0) delete clean.badges;
    }
    if (link && (link.text || '').trim() && (link.href || '').trim()) {
      clean.link = { text: link.text.trim(), href: link.href.trim() };
    }
    return clean;
  });
}

export function sanitizeComoFunciona(arr) {
  return (arr || []).map(x => {
    const { _tempId, ...rest } = x;
    return omitEmpty(rest);
  });
}

export function sanitizeTusDatos(arr) {
  return (arr || []).map(x => {
    const { _tempId, ...rest } = x;
    return omitEmpty(rest);
  });
}

export function sanitizeCanje(obj) {
  if (!obj || typeof obj !== 'object') return { steps: [], catalogo: [] };
  return {
    steps: (obj.steps || []).map(s => {
      const { _tempId, ...rest } = s;
      return omitEmpty(rest);
    }),
    catalogo: (obj.catalogo || []).map(c => {
      const { _tempId, ...rest } = c;
      return omitEmpty(rest);
    }),
  };
}

export function sanitizeCotizador(obj) {
  if (!obj || typeof obj !== 'object') return { productos: [], recargos: {} };
  const productos = (obj.productos || []).map(p => {
    const { _tempId, ...rest } = p;
    const clean = { label: (rest.label || '').trim(), usd: Number(rest.usd) };
    if (rest.id) clean.id = rest.id;
    return clean;
  });
  const r = obj.recargos || {};
  const recargos = {};
  // Todos opcionales — solo mandamos los que tienen valor numérico.
  if (r.transferencia !== '' && r.transferencia != null && !Number.isNaN(Number(r.transferencia))) {
    recargos.transferencia = Number(r.transferencia);
  }
  if (r.cuotas_3 !== '' && r.cuotas_3 != null && !Number.isNaN(Number(r.cuotas_3))) {
    recargos.cuotas_3 = Number(r.cuotas_3);
  }
  if (r.cuotas_6 !== '' && r.cuotas_6 != null && !Number.isNaN(Number(r.cuotas_6))) {
    recargos.cuotas_6 = Number(r.cuotas_6);
  }
  return { productos, recargos };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fábricas de items vacíos — un item nuevo listo para editar
// ═══════════════════════════════════════════════════════════════════════════

export function emptyModulo() {
  return {
    _tempId: tempId(),
    n: '',
    tint: 'tint-blue',
    title: '',
    body: '',
    iconKey: 'inventario',
    wide: false,
    badges: [],
    link: null,
  };
}
export function emptyBadge() {
  return { _tempId: tempId(), text: '', hi: false };
}
export function emptyComoFunciona() {
  return { _tempId: tempId(), n: '', title: '', body: '', icon: 'inventario' };
}
export function emptyTusDatos() {
  return { _tempId: tempId(), title: '', body: '' };
}
export function emptyCanjeStep() {
  return { _tempId: tempId(), n: '', title: '', body: '' };
}
export function emptyCanjeCatalogo() {
  return { _tempId: tempId(), modelo: '', cap: '', bat: '', toma: '' };
}
export function emptyCotizadorProducto() {
  return { _tempId: tempId(), label: '', usd: '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers de UI compartidos (todas las cards los usan)
// ═══════════════════════════════════════════════════════════════════════════

// Row-header estandarizado con # + preview + botones subir/bajar/eliminar.
// Mismo look que las rows de FAQ y testimonials en el file principal.
function ItemRowHeader({ idx, total, preview, onUp, onDown, onDelete, saving }) {
  return (
    <div className="u-flex-between-center-nogap">
      <div className="muted u-fs-12">
        #{idx + 1} — {preview || 'Sin nombre'}
      </div>
      <div className="u-flex-gap-4">
        <button type="button" className="icon-btn" onClick={onUp}
                disabled={saving || idx === 0} title="Subir">▲</button>
        <button type="button" className="icon-btn" onClick={onDown}
                disabled={saving || idx === total - 1} title="Bajar">▼</button>
        <button type="button" className="icon-btn" onClick={onDelete}
                disabled={saving} title="Eliminar">
          <Icons.Trash size={14} />
        </button>
      </div>
    </div>
  );
}

// Card wrapper con header (título + badge MODIFICADO + subtitle + action).
// Todas las cards Fase 5 usan la misma estructura.
function SectionCard({ title, subtitle, dirty, action, children }) {
  return (
    <Card>
      <div className="u-p-20-grid-gap-16">
        <div className="u-flex-between-start-16">
          <div>
            <h3 className="u-modal-title">
              {title}
              {dirty && (
                <span className="u-badge-modified">MODIFICADO</span>
              )}
            </h3>
            {subtitle && (
              <p className="muted u-m-4-0-0-fs-13">{subtitle}</p>
            )}
          </div>
          {action}
        </div>
        {children}
      </div>
    </Card>
  );
}

// Empty-state estilizado consistente con las otras cards del file.
function EmptyState({ children }) {
  return (
    <div className="muted u-cms-empty-16">
      {children}
    </div>
  );
}

// Character-counter footer para textareas.
function CharCounter({ value, max }) {
  return (
    <div className="muted tiny u-mt-2-td-right">
      {(value || '').length} / {max}
    </div>
  );
}

// Genérico add/update/remove/move sobre un array — evita repetir la lógica
// 5 veces (una por card). El caller es dueño del array via setValue.
function useArrayOps(value, setValue) {
  const arr = Array.isArray(value) ? value : [];
  return {
    add:    (mk) => setValue([...arr, mk()]),
    update: (idx, patch) => setValue(arr.map((it, i) => i === idx ? { ...it, ...patch } : it)),
    remove: (idx) => setValue(arr.filter((_, i) => i !== idx)),
    move:   (idx, dir) => {
      const next = [...arr];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      setValue(next);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. MÓDULOS — 7 cards de "Los módulos" con badges + link + wide + tint + icon
// ═══════════════════════════════════════════════════════════════════════════

export function ModulosCard({ value, original, onChange, saving }) {
  const dirty = !sameJSON(value, original);
  const ops = useArrayOps(value, onChange);
  const arr = Array.isArray(value) ? value : [];

  return (
    <SectionCard
      title="Sección Módulos"
      subtitle='Los cards de "Los módulos" en el landing. Vacío → landing usa los 7 default hardcoded.'
      dirty={dirty}
      action={
        <Btn variant="ghost" onClick={() => ops.add(emptyModulo)} disabled={saving || arr.length >= 12}>
          <Icons.Plus size={14} /> Agregar módulo
        </Btn>
      }
    >
      {arr.length === 0 ? (
        <EmptyState>
          Todavía no cargaste módulos. La landing muestra los 7 default hardcoded.
        </EmptyState>
      ) : (
        <div className="u-grid-gap-12-nocol">
          {arr.map((m, idx) => (
            <div key={m.id || m._tempId} className="u-cms-item-card">
              <ItemRowHeader
                idx={idx} total={arr.length}
                preview={m.title ? m.title.slice(0, 60) : `Módulo ${m.n || ''}`}
                onUp={() => ops.move(idx, -1)}
                onDown={() => ops.move(idx, +1)}
                onDelete={() => ops.remove(idx)}
                saving={saving}
              />

              <div className="u-grid-4col-2fr-1fr-8">
                <div className="field">
                  <div className="muted tiny u-mb-2">Número (n)</div>
                  <input className="input" maxLength={3} placeholder="01"
                         value={m.n || ''} disabled={saving}
                         onChange={e => ops.update(idx, { n: e.target.value })} />
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Color (tint)</div>
                  <select className="input" value={m.tint || 'tint-blue'} disabled={saving}
                          onChange={e => ops.update(idx, { tint: e.target.value })}>
                    {TINT_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Icono</div>
                  <select className="input" value={m.iconKey || 'inventario'} disabled={saving}
                          onChange={e => ops.update(idx, { iconKey: e.target.value })}>
                    {ICON_MODULOS_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Ancho</div>
                  <label className="u-flex-center-gap-8">
                    <input type="checkbox" checked={m.wide === true} disabled={saving}
                           onChange={e => ops.update(idx, { wide: e.target.checked })} />
                    <span className="u-fs-12">Card doble (span 2)</span>
                  </label>
                </div>
              </div>

              <div className="field">
                <div className="muted tiny u-mb-2">Título</div>
                <input className="input" maxLength={60}
                       placeholder="Ej. Inventario y stock"
                       value={m.title || ''} disabled={saving}
                       onChange={e => ops.update(idx, { title: e.target.value })} />
              </div>
              <div className="field">
                <div className="muted tiny u-mb-2">Descripción (body)</div>
                <textarea className="input u-w-100-resize-v" rows={3} maxLength={400}
                          placeholder="Ej. Cargá productos, controlá stock en tiempo real..."
                          value={m.body || ''} disabled={saving}
                          onChange={e => ops.update(idx, { body: e.target.value })} />
                <CharCounter value={m.body} max={400} />
              </div>

              {/* Badges — sub-array chico. Botón agregar debajo del listado. */}
              <div className="field">
                <div className="muted tiny u-mb-2">
                  Badges ({(m.badges || []).length} / 6)
                </div>
                <div className="u-grid-gap-12-nocol">
                  {(m.badges || []).map((b, bi) => (
                    <div key={b._tempId || bi} className="u-flex-center-gap-8">
                      <input className="input u-flex-1" maxLength={40}
                             placeholder="Ej. Multi-depósito"
                             value={b.text || ''} disabled={saving}
                             onChange={e => {
                               const nb = [...(m.badges || [])];
                               nb[bi] = { ...b, text: e.target.value };
                               ops.update(idx, { badges: nb });
                             }} />
                      <label className="u-flex-center-gap-8 u-fs-12">
                        <input type="checkbox" checked={b.hi === true} disabled={saving}
                               onChange={e => {
                                 const nb = [...(m.badges || [])];
                                 nb[bi] = { ...b, hi: e.target.checked };
                                 ops.update(idx, { badges: nb });
                               }} />
                        Destacado
                      </label>
                      <button type="button" className="icon-btn"
                              disabled={saving} title="Quitar badge"
                              onClick={() => {
                                const nb = (m.badges || []).filter((_, i) => i !== bi);
                                ops.update(idx, { badges: nb });
                              }}>
                        <Icons.Trash size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="u-mt-4">
                  <Btn variant="ghost" sm disabled={saving || (m.badges || []).length >= 6}
                       onClick={() => ops.update(idx, { badges: [...(m.badges || []), emptyBadge()] })}>
                    <Icons.Plus size={12} /> Agregar badge
                  </Btn>
                </div>
              </div>

              {/* Link opcional — se manda solo si ambos campos tienen valor.
                  Toggle "sin link/con link" implicito: si el user vacía los
                  dos campos, el sanitizer omite el objeto entero. */}
              <div className="field">
                <div className="muted tiny u-mb-2">Link opcional</div>
                <div className="u-grid-4col-2fr-1fr-8">
                  <input className="input" maxLength={40}
                         placeholder="Texto (ej. Ver cómo funciona →)"
                         value={m.link?.text || ''} disabled={saving}
                         onChange={e => ops.update(idx, {
                           link: { ...(m.link || {}), text: e.target.value },
                         })} />
                  <input className="input" maxLength={200}
                         placeholder="URL o #anchor"
                         value={m.link?.href || ''} disabled={saving}
                         onChange={e => ops.update(idx, {
                           link: { ...(m.link || {}), href: e.target.value },
                         })} />
                </div>
                <div className="muted tiny u-mt-2-td-right">
                  Vacío → landing no muestra el link.
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. CÓMO FUNCIONA — 4 steps con icon select
// ═══════════════════════════════════════════════════════════════════════════

export function ComoFuncionaCard({ value, original, onChange, saving }) {
  const dirty = !sameJSON(value, original);
  const ops = useArrayOps(value, onChange);
  const arr = Array.isArray(value) ? value : [];

  return (
    <SectionCard
      title='Sección "Cómo funciona"'
      subtitle="Los 4 steps del walkthrough en el landing. Vacío → landing usa los 4 default."
      dirty={dirty}
      action={
        <Btn variant="ghost" onClick={() => ops.add(emptyComoFunciona)} disabled={saving || arr.length >= 6}>
          <Icons.Plus size={14} /> Agregar step
        </Btn>
      }
    >
      {arr.length === 0 ? (
        <EmptyState>
          Sin steps cargados. La landing muestra los 4 default (inventario, venta, saldos, métricas).
        </EmptyState>
      ) : (
        <div className="u-grid-gap-12-nocol">
          {arr.map((s, idx) => (
            <div key={s.id || s._tempId} className="u-cms-item-card">
              <ItemRowHeader
                idx={idx} total={arr.length}
                preview={s.title ? s.title.slice(0, 60) : `Step ${s.n || ''}`}
                onUp={() => ops.move(idx, -1)}
                onDown={() => ops.move(idx, +1)}
                onDelete={() => ops.remove(idx)}
                saving={saving}
              />
              <div className="u-grid-4col-2fr-1fr-8">
                <div className="field">
                  <div className="muted tiny u-mb-2">Número (n)</div>
                  <input className="input" maxLength={3} placeholder="1"
                         value={s.n || ''} disabled={saving}
                         onChange={e => ops.update(idx, { n: e.target.value })} />
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Icono</div>
                  <select className="input" value={s.icon || 'inventario'} disabled={saving}
                          onChange={e => ops.update(idx, { icon: e.target.value })}>
                    {ICON_COMO_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div />
                <div />
              </div>
              <div className="field">
                <div className="muted tiny u-mb-2">Título</div>
                <input className="input" maxLength={60}
                       placeholder="Ej. Cargá tu inventario"
                       value={s.title || ''} disabled={saving}
                       onChange={e => ops.update(idx, { title: e.target.value })} />
              </div>
              <div className="field">
                <div className="muted tiny u-mb-2">Descripción (body)</div>
                <textarea className="input u-w-100-resize-v" rows={2} maxLength={300}
                          placeholder="Ej. Sumás productos con foto, IMEI y precio en segundos."
                          value={s.body || ''} disabled={saving}
                          onChange={e => ops.update(idx, { body: e.target.value })} />
                <CharCounter value={s.body} max={300} />
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. TUS DATOS — array simplísimo de {title, body}
// ═══════════════════════════════════════════════════════════════════════════

export function TusDatosCard({ value, original, onChange, saving }) {
  const dirty = !sameJSON(value, original);
  const ops = useArrayOps(value, onChange);
  const arr = Array.isArray(value) ? value : [];

  return (
    <SectionCard
      title='Sección "Tus datos"'
      subtitle="Los 3 pilares de la sección Datos (backups, export, soft-delete). Vacío → landing usa los 3 default."
      dirty={dirty}
      action={
        <Btn variant="ghost" onClick={() => ops.add(emptyTusDatos)} disabled={saving || arr.length >= 6}>
          <Icons.Plus size={14} /> Agregar pilar
        </Btn>
      }
    >
      {arr.length === 0 ? (
        <EmptyState>
          Sin pilares cargados. La landing muestra los 3 default hardcoded.
        </EmptyState>
      ) : (
        <div className="u-grid-gap-12-nocol">
          {arr.map((p, idx) => (
            <div key={p.id || p._tempId} className="u-cms-item-card">
              <ItemRowHeader
                idx={idx} total={arr.length}
                preview={p.title ? p.title.slice(0, 60) : 'Sin título'}
                onUp={() => ops.move(idx, -1)}
                onDown={() => ops.move(idx, +1)}
                onDelete={() => ops.remove(idx)}
                saving={saving}
              />
              <div className="field">
                <div className="muted tiny u-mb-2">Título</div>
                <input className="input" maxLength={50}
                       placeholder="Ej. Backups automáticos"
                       value={p.title || ''} disabled={saving}
                       onChange={e => ops.update(idx, { title: e.target.value })} />
              </div>
              <div className="field">
                <div className="muted tiny u-mb-2">Descripción (body)</div>
                <textarea className="input u-w-100-resize-v" rows={3} maxLength={300}
                          placeholder="Ej. Diarios en 2 regiones, retención 30 días..."
                          value={p.body || ''} disabled={saving}
                          onChange={e => ops.update(idx, { body: e.target.value })} />
                <CharCounter value={p.body} max={300} />
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CANJE — objeto {steps, catalogo} con 2 sub-arrays
// ═══════════════════════════════════════════════════════════════════════════

export function CanjeCard({ value, original, onChange, saving }) {
  const dirty = !sameJSON(value, original);
  const v = value || { steps: [], catalogo: [] };
  const steps = Array.isArray(v.steps) ? v.steps : [];
  const catalogo = Array.isArray(v.catalogo) ? v.catalogo : [];

  // Ops locales para sub-arrays — el "state" a mutar es el objeto entero.
  function setSteps(next) { onChange({ ...v, steps: typeof next === 'function' ? next(steps) : next }); }
  function setCat(next)   { onChange({ ...v, catalogo: typeof next === 'function' ? next(catalogo) : next }); }
  const stepsOps = useArrayOps(steps, setSteps);
  const catOps   = useArrayOps(catalogo, setCat);

  return (
    <SectionCard
      title="Sección Canje de usados"
      subtitle="Steps del proceso + catálogo de valores mock (los reales se manejan aparte). Vacío → landing usa los defaults."
      dirty={dirty}
    >
      {/* Sub-sección: STEPS */}
      <div className="u-flex-between-center-nogap">
        <div className="u-fs-13-fw-600">Steps del proceso ({steps.length} / 6)</div>
        <Btn variant="ghost" sm onClick={() => stepsOps.add(emptyCanjeStep)}
             disabled={saving || steps.length >= 6}>
          <Icons.Plus size={12} /> Agregar step
        </Btn>
      </div>
      {steps.length === 0 ? (
        <EmptyState>Sin steps cargados. Landing muestra los 3 default.</EmptyState>
      ) : (
        <div className="u-grid-gap-12-nocol">
          {steps.map((s, idx) => (
            <div key={s.id || s._tempId} className="u-cms-item-card">
              <ItemRowHeader
                idx={idx} total={steps.length}
                preview={s.title ? s.title.slice(0, 60) : `Step ${s.n || ''}`}
                onUp={() => stepsOps.move(idx, -1)}
                onDown={() => stepsOps.move(idx, +1)}
                onDelete={() => stepsOps.remove(idx)}
                saving={saving}
              />
              <div className="u-grid-4col-2fr-1fr-8">
                <div className="field">
                  <div className="muted tiny u-mb-2">Número (n)</div>
                  <input className="input" maxLength={3} placeholder="1"
                         value={s.n || ''} disabled={saving}
                         onChange={e => stepsOps.update(idx, { n: e.target.value })} />
                </div>
                <div /><div /><div />
              </div>
              <div className="field">
                <div className="muted tiny u-mb-2">Título</div>
                <input className="input" maxLength={80}
                       placeholder="Ej. Pediste el valor de toma"
                       value={s.title || ''} disabled={saving}
                       onChange={e => stepsOps.update(idx, { title: e.target.value })} />
              </div>
              <div className="field">
                <div className="muted tiny u-mb-2">Descripción (body)</div>
                <textarea className="input u-w-100-resize-v" rows={2} maxLength={300}
                          placeholder="Ej. Elegís modelo + capacidad + estado batería..."
                          value={s.body || ''} disabled={saving}
                          onChange={e => stepsOps.update(idx, { body: e.target.value })} />
                <CharCounter value={s.body} max={300} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sub-sección: CATÁLOGO — grid 4 columnas modelo/cap/bat/toma */}
      <div className="u-flex-between-center-nogap u-mt-8">
        <div className="u-fs-13-fw-600">Catálogo de valores mock ({catalogo.length} / 20)</div>
        <Btn variant="ghost" sm onClick={() => catOps.add(emptyCanjeCatalogo)}
             disabled={saving || catalogo.length >= 20}>
          <Icons.Plus size={12} /> Agregar fila
        </Btn>
      </div>
      {catalogo.length === 0 ? (
        <EmptyState>Sin filas. Landing muestra el catálogo mock default.</EmptyState>
      ) : (
        <div className="u-grid-gap-12-nocol">
          {catalogo.map((c, idx) => (
            <div key={c.id || c._tempId} className="u-cms-item-card">
              <ItemRowHeader
                idx={idx} total={catalogo.length}
                preview={c.modelo || 'Sin modelo'}
                onUp={() => catOps.move(idx, -1)}
                onDown={() => catOps.move(idx, +1)}
                onDelete={() => catOps.remove(idx)}
                saving={saving}
              />
              <div className="u-grid-4col-2fr-1fr-8">
                <div className="field">
                  <div className="muted tiny u-mb-2">Modelo</div>
                  <input className="input" maxLength={60}
                         placeholder="iPhone 13"
                         value={c.modelo || ''} disabled={saving}
                         onChange={e => catOps.update(idx, { modelo: e.target.value })} />
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Capacidad</div>
                  <input className="input" maxLength={20}
                         placeholder="128 GB"
                         value={c.cap || ''} disabled={saving}
                         onChange={e => catOps.update(idx, { cap: e.target.value })} />
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Batería</div>
                  <input className="input" maxLength={10}
                         placeholder="85%"
                         value={c.bat || ''} disabled={saving}
                         onChange={e => catOps.update(idx, { bat: e.target.value })} />
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">Valor toma</div>
                  <input className="input" maxLength={20}
                         placeholder="USD 420"
                         value={c.toma || ''} disabled={saving}
                         onChange={e => catOps.update(idx, { toma: e.target.value })} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. COTIZADOR — objeto {productos, recargos} con 3 recargos %
// ═══════════════════════════════════════════════════════════════════════════

export function CotizadorCard({ value, original, onChange, saving }) {
  const dirty = !sameJSON(value, original);
  const v = value || { productos: [], recargos: {} };
  const productos = Array.isArray(v.productos) ? v.productos : [];
  const recargos = v.recargos || {};

  function setProds(next) { onChange({ ...v, productos: typeof next === 'function' ? next(productos) : next }); }
  const prodsOps = useArrayOps(productos, setProds);

  function updateRecargo(key, raw) {
    // Permitimos string vacío en el input (para que el user pueda borrar y
    // volver a tipear) — el sanitizer descarta '' antes del PATCH.
    onChange({ ...v, recargos: { ...recargos, [key]: raw === '' ? '' : raw } });
  }

  return (
    <SectionCard
      title="Sección Cotizador"
      subtitle="Catálogo de productos del demo + recargos %. Vacío → landing usa el mock hardcoded."
      dirty={dirty}
    >
      {/* Recargos — 3 números con label */}
      <div className="u-fs-13-fw-600">Recargos %</div>
      <div className="u-grid-4col-2fr-1fr-8">
        <div className="field">
          <div className="muted tiny u-mb-2">Transferencia (%)</div>
          <input className="input" type="number" min={0} max={200} step="0.1"
                 placeholder="0" value={recargos.transferencia ?? ''}
                 disabled={saving}
                 onChange={e => updateRecargo('transferencia', e.target.value)} />
        </div>
        <div className="field">
          <div className="muted tiny u-mb-2">3 cuotas (%)</div>
          <input className="input" type="number" min={0} max={200} step="0.1"
                 placeholder="12" value={recargos.cuotas_3 ?? ''}
                 disabled={saving}
                 onChange={e => updateRecargo('cuotas_3', e.target.value)} />
        </div>
        <div className="field">
          <div className="muted tiny u-mb-2">6 cuotas (%)</div>
          <input className="input" type="number" min={0} max={200} step="0.1"
                 placeholder="22" value={recargos.cuotas_6 ?? ''}
                 disabled={saving}
                 onChange={e => updateRecargo('cuotas_6', e.target.value)} />
        </div>
        <div />
      </div>

      {/* Productos — array con label + USD */}
      <div className="u-flex-between-center-nogap u-mt-8">
        <div className="u-fs-13-fw-600">Productos ({productos.length} / 20)</div>
        <Btn variant="ghost" sm onClick={() => prodsOps.add(emptyCotizadorProducto)}
             disabled={saving || productos.length >= 20}>
          <Icons.Plus size={12} /> Agregar producto
        </Btn>
      </div>
      {productos.length === 0 ? (
        <EmptyState>Sin productos. Landing muestra el catálogo mock hardcoded.</EmptyState>
      ) : (
        <div className="u-grid-gap-12-nocol">
          {productos.map((p, idx) => (
            <div key={p.id || p._tempId} className="u-cms-item-card">
              <ItemRowHeader
                idx={idx} total={productos.length}
                preview={p.label || 'Sin nombre'}
                onUp={() => prodsOps.move(idx, -1)}
                onDown={() => prodsOps.move(idx, +1)}
                onDelete={() => prodsOps.remove(idx)}
                saving={saving}
              />
              <div className="u-grid-4col-2fr-1fr-8">
                <div className="field">
                  <div className="muted tiny u-mb-2">Nombre (label)</div>
                  <input className="input" maxLength={60}
                         placeholder="iPhone 15 Pro 256 GB"
                         value={p.label || ''} disabled={saving}
                         onChange={e => prodsOps.update(idx, { label: e.target.value })} />
                </div>
                <div className="field">
                  <div className="muted tiny u-mb-2">USD</div>
                  <input className="input" type="number" min={1} max={20000} step="1"
                         placeholder="1250"
                         value={p.usd ?? ''} disabled={saving}
                         onChange={e => prodsOps.update(idx, { usd: e.target.value === '' ? '' : Number(e.target.value) })} />
                </div>
                <div /><div />
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
