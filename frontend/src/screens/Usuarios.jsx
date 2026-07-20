// Pantalla Usuarios — sistema capability-based (Permisos F2, 2026-06-23).
//
// Reemplaza al sistema flat de 14 booleans (`user_permissions`) por roles +
// overrides granulares por capability. Reads + writes vía los endpoints
// nuevos `/api/capabilities/*` (F1). Crea + borra users sigue vía
// `/api/usuarios` (legacy) — esos endpoints no cambian en F2.
//
// Coexistencia con sistema viejo:
//   El usuario ve y edita solo los roles+caps nuevos. Pero como las routes
//   backend todavía gateaan con `requirePermission(tool)` hasta F3/F4, los
//   permisos flat siguen siendo los que determinan acceso real. Esta
//   pantalla muestra los caps efectivos del sistema nuevo (lo que va a regir
//   post-cutover), no los flat — el owner ve el estado deseado, no el
//   actual. Decisión explícita: la UI viejos perms se va a F4.

import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { usuarios as usuariosApi, capabilities as capsApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import Badge from '../components/Badge';
import useModal from '../lib/useModal';
import useFormFields from '../lib/useFormFields';

// Labels descriptivos de cada rol. Tienen que matchear ROLES_VALIDOS del
// backend (`backend/src/lib/capabilityCatalog.js`). El backend acepta el
// enum cerrado; acá solo decoramos para la UI.
const ROL_LABELS = {
  owner:     'Owner',
  admin:     'Admin',
  vendedor:  'Vendedor',
  encargado: 'Encargado',
  lectura:   'Solo Lectura',
  custom:    'Custom',
};

const ROL_DESCRIPCION = {
  owner:     'Dueño del tenant. Acceso total + gestión de usuarios y suscripción.',
  admin:     'Acceso total a la operación. No gestiona usuarios.',
  vendedor:  'Crea ventas retail/B2B, cobra, gestiona envíos. No ve plata (cajas/egresos/sanidad) ni costos de inventario.',
  encargado: 'Vendedor + acceso operativo a Cajas (ver), Egresos (ver), Inventario completo, Proyectos. Sin financiera ni gestión de plata.',
  lectura:   'Auditor / contador externo. Ve todo lo financiero sin poder operar.',
  custom:    'Sin rol base — arrancás de cero y tildás solo lo que quieras dar.',
};

// El admin del tenant puede asignar cualquier rol MENOS owner — owner se
// asigna solo en el signup (igual constraint en el backend / schema).
const ROLES_EDITABLES = ['admin', 'vendedor', 'encargado', 'lectura', 'custom'];

function initials(nombre) {
  return ((nombre || '').split(' ').slice(0, 2).map(w => w[0]).join('') || '??').toUpperCase();
}

// ─── Helpers de resolución (espejo de backend lib/capabilities + roleDefaults) ─

// Set de capabilities ON por rol (sin overrides). Mantener sincronizado
// con `backend/src/lib/roleDefaults.js`. Si se desincroniza, la UI muestra
// algo distinto a lo que rige el JWT — bug confuso pero NO inseguro
// (el backend siempre rige por su propio source of truth).
const ROLE_DEFAULTS = {
  owner: null, // bypass total — null = "todos los slugs"
  admin: null,
  vendedor: new Set([
    'ventas.trabajar', 'b2b.trabajar',
    'contactos.ver', 'contactos.crear_borrar',
    'inventario.ver',
    'cotizador.trabajar', 'usados.ver', 'envios.trabajar',
  ]),
  encargado: new Set([
    'inicio.actividad_reciente', 'resumen.ver',
    'ventas.trabajar', 'ventas.exportar',
    'b2b.trabajar', 'b2b.cobranza_masiva',
    'contactos.ver', 'contactos.crear_borrar',
    'cajas.ver', 'egresos.ver',
    'inventario.ver', 'inventario.ver_costos', 'inventario.ver_movimientos',
    'inventario.ver_compras', 'inventario.exportar',
    'proveedores.trabajar', 'cotizador.trabajar',
    'usados.ver', 'usados.agregar_equipo', 'usados.exportar',
    'envios.trabajar', 'proyectos.trabajar',
  ]),
  lectura: new Set([
    'inicio.actividad_reciente', 'resumen.ver',
    'cajas.ver', 'cajas.ver_deudas', 'cajas.ver_inversiones',
    'cajas.ver_360_capital', 'cajas.conciliacion',
    'egresos.ver', 'sanidad.trabajar',
    'inventario.ver', 'inventario.ver_costos', 'inventario.ver_movimientos', 'inventario.ver_compras',
    'proveedores.trabajar', 'tarjetas.trabajar', 'cambios.trabajar', 'financiera.trabajar',
    'usados.ver', 'proyectos.trabajar', 'proyectos.ver_costos', 'historial.ver',
  ]),
  custom: new Set(),
};

function isBypassRol(rol) { return rol === 'owner' || rol === 'admin'; }

// Resuelve { slug: true|false } combinando rol + overrides. Para owner/admin
// devuelve null (la UI lo trata como "todo ON").
function resolveCaps(rol, overrides) {
  if (isBypassRol(rol)) return null;
  const defaults = ROLE_DEFAULTS[rol] || new Set();
  const out = new Set(defaults);
  for (const ov of overrides || []) {
    if (ov.enabled === true) out.add(ov.capability_slug);
    else if (ov.enabled === false) out.delete(ov.capability_slug);
  }
  return out;
}

// ─── Pantalla principal ────────────────────────────────────────────────────

export default function Usuarios() {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [pantallas, setPantallas] = useState([]); // [{ id, label, capabilities: [...] }]
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [rolFilter, setRolFilter] = useState('todos');
  const [editingId, setEditingId] = useState(null);

  // Alta de usuario — usa endpoint legacy /api/usuarios (esa parte no cambió
  // en F2). El rol del sistema nuevo se setea con un PUT /capabilities/users/:id
  // después del create.
  const EMPTY_NEW = { nombre: '', username: '', email: '', password: '', rol: 'vendedor' };
  const [showCreate, setShowCreate]   = useState(false);
  // 2026-07-16 (task #145 UX B): validación inline con useFormFields.
  // Antes: 5 chequeos secuenciales con `if (X) { setCreateError(msg); return; }`
  // → user completaba todo, submitteaba, veía UNO solo por vez. Ahora todos
  // los errores relevantes aparecen JUNTOS debajo de cada campo, y se van
  // limpiando al empezar a corregir.
  const {
    form: newUser,
    setForm: setNewUser,
    setField: setNU,
    fieldErrors,
    setFieldErrors,
    validate: validateNewUser,
    resetErrors,
  } = useFormFields(EMPTY_NEW, (u) => {
    const errs = {};
    const nombre = u.nombre?.trim() || '';
    const username = u.username?.trim().toLowerCase() || '';
    const email = u.email?.trim() || '';
    if (!nombre) errs.nombre = 'Requerido.';
    if (!username) errs.username = 'Requerido.';
    else if (username.length < 2) errs.username = 'Mínimo 2 caracteres.';
    else if (!/^[a-z0-9_]+$/.test(username)) errs.username = 'Solo minúsculas, números y guión bajo.';
    if (!email) errs.email = 'Requerido.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Formato inválido. Ej: nombre@dominio.com';
    // 2026-06-26 (#446): mismo mínimo que el backend — 8 chars con letra y número.
    if (u.password.length < 8 || !/[A-Za-z]/.test(u.password) || !/[0-9]/.test(u.password)) {
      errs.password = 'Mínimo 8 caracteres, con al menos una letra y un número.';
    }
    return Object.keys(errs).length ? errs : null;
  });
  const [creating, setCreating]       = useState(false);
  const [createError, setCreateError] = useState(''); // errores no-field (ej. 409, 500)
  const createModalRef = useRef(null);
  useModal({ open: showCreate, onClose: () => setShowCreate(false), overlayRef: createModalRef });

  // ── Load inicial ─────────────────────────────────────────────────────────
  function refresh() {
    setLoading(true);
    Promise.all([capsApi.catalog(), capsApi.users()])
      .then(([cat, us]) => {
        setPantallas(Array.isArray(cat?.pantallas) ? cat.pantallas : []);
        setUsers(Array.isArray(us) ? us : []);
      })
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const totalCaps = useMemo(
    () => pantallas.reduce((acc, p) => acc + (p.capabilities?.length || 0), 0),
    [pantallas],
  );
  const owners = users.filter(u => u.rol === 'owner').length;
  const admins = users.filter(u => u.rol === 'admin').length;
  const operadores = users.length - owners - admins;

  // ── Filtro ───────────────────────────────────────────────────────────────
  const filtered = users.filter(u => {
    if (rolFilter === 'todos') return true;
    if (rolFilter === 'bypass') return isBypassRol(u.rol);
    return u.rol === rolFilter;
  });

  // ── Crear usuario ────────────────────────────────────────────────────────
  function openCreate() {
    setNewUser(EMPTY_NEW);
    resetErrors();
    setCreateError('');
    setShowCreate(true);
  }
  // 2026-07-16 (task #145 UX B): setNU ahora viene de useFormFields — misma
  // firma (field, val), pero además limpia fieldErrors[field] al setear.

  async function handleCreate(e) {
    e.preventDefault();
    // 2026-07-16 (task #145 UX B): validación inline consolidada — todos los
    // errores de field aparecen a la vez, no de uno en uno con early return.
    if (!validateNewUser()) return;
    // Normalizamos los mismos campos que ya normalizaba la versión previa.
    const nombre = newUser.nombre.trim();
    const username = newUser.username.trim().toLowerCase();
    const email = newUser.email.trim();
    setCreating(true);
    setCreateError('');
    try {
      // 1) Crear user via endpoint legacy. Le pasamos role='op' (el role
      // global del sistema viejo). Si el rol nuevo es 'admin' del tenant,
      // sigue siendo 'op' a nivel users.role — la nueva semántica de admin
      // del tenant la maneja tenant_user_roles.rol. Esto evita que un admin
      // de tenant tenga bypass cross-tenant (el users.role='admin' es global,
      // peligroso).
      // 2026-06-24 hotfix post-permisos: el campo `perms` se retiró del
      // schema en F4 (createUsuarioSchema.strict() rechaza extras → 400).
      // Antes mandábamos `perms: {}` con un comment "el sistema nuevo
      // decide" — pero .strict() no perdona, y "Crear usuario" venía
      // rompiendo silenciosamente en prod desde el cutover. El sistema
      // nuevo decide igual: el step 2 (capsApi.update con rol elegido)
      // genera las caps efectivas tras el INSERT.
      const created = await usuariosApi.create({
        nombre,
        username,
        email, // 2026-06-26 (#446): obligatorio, ya validado arriba.
        password: newUser.password,
        role: 'op',
      });
      // 2) Asignar el rol nuevo via PUT /capabilities/users/:id.
      // Si el rol elegido no es 'custom', basta con eso. Si es 'custom',
      // overrides queda en [] (el owner los va a tildar después).
      await capsApi.update(created.id, { rol: newUser.rol, overrides: [] });

      setShowCreate(false);
      toast.success('Usuario creado.');
      refresh(); // reload — más simple que insertar inline (rol + caps resueltos backend-side)
    } catch (err) {
      // 2026-07-16 (task #145 UX B): si el backend devuelve `fields` (400),
      // mapear a fieldErrors. Sino, error genérico.
      if (err.status === 400 && err.body?.fields) {
        setFieldErrors(err.body.fields);
      } else {
        setCreateError(err.message || 'No se pudo crear el usuario.');
      }
    } finally {
      setCreating(false);
    }
  }

  // ── Borrar usuario ───────────────────────────────────────────────────────
  async function handleDelete(u) {
    const ok = await confirm({
      title: 'Eliminar usuario',
      message: `${u.nombre} (@${u.username}) — su cuenta queda desactivada y se cierran todas sus sesiones.`,
      confirmLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try {
      await usuariosApi.delete(u.id);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      toast.success('Usuario eliminado.');
    } catch (e) {
      toast.error(e.message);
    }
  }

  const userEditando = users.find(u => u.id === editingId) || null;

  function handleSaved(updated) {
    setUsers(prev => prev.map(u => u.id === updated.id ? { ...u, ...updated } : u));
    setEditingId(null);
  }

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Usuarios</h1>
          <div className="page-sub">Rol base + permisos granulares por pantalla y capability.</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={refresh}>
            <Icons.Refresh size={15} /> Actualizar
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <Icons.Plus size={15} /> Nuevo usuario
          </button>
        </div>
      </div>

      {/* 2026-06-26 (#446): banner para users legacy con email placeholder.
          Antes el alta permitía no enviar email y el backend generaba
          `user_<id>@placeholder.local`. Esos users no pueden recibir
          invitaciones / resets de password / notificaciones. El banner
          es informativo (no force) — el owner los completa cuando puede
          editando cada user. */}
      {users.filter(u => (u.email || '').endsWith('@placeholder.local')).length > 0 && (
        <div className="banner banner-warn" style={{ marginBottom: 14 }}>
          <Icons.Bell size={16} />
          <span>
            <strong>
              {users.filter(u => (u.email || '').endsWith('@placeholder.local')).length} usuario
              {users.filter(u => (u.email || '').endsWith('@placeholder.local')).length === 1 ? '' : 's'} sin email real
            </strong>
            {' — '}
            actualizá su email haciendo click en su fila. Sin email no pueden recibir
            invitaciones, resets de contraseña ni notificaciones.
          </span>
        </div>
      )}

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Total usuarios</div>
          <div className="kpi-value mono">{users.length}</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Owners + Admins</div>
          <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>{owners + admins}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>bypass total</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Resto del equipo</div>
          <div className="kpi-value mono">{operadores}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>permisos por capability</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Capabilities disponibles</div>
          <div className="kpi-value mono">{totalCaps}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>en {pantallas.length} pantallas</div>
        </div>
      </div>

      {/* ── Filtro por rol ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <div className="seg">
          {[
            { value: 'todos',     label: 'Todos' },
            { value: 'bypass',    label: 'Owners + Admins' },
            { value: 'vendedor',  label: 'Vendedores' },
            { value: 'encargado', label: 'Encargados' },
            { value: 'lectura',   label: 'Lectura' },
            { value: 'custom',    label: 'Custom' },
          ].map(opt => (
            <button
              key={opt.value}
              className={`seg-btn${rolFilter === opt.value ? ' on' : ''}`}
              onClick={() => setRolFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tabla ─────────────────────────────────────────────────────────── */}
      <div className="card card-flush">
        <div className="card-hd">
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Equipo — {filtered.length} usuario{filtered.length !== 1 ? 's' : ''}
          </div>
        </div>

        {loading ? (
          <div className="empty">Cargando usuarios…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">Sin usuarios en esta categoría.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Permisos efectivos</th>
                <th>Overrides</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => {
                const bypass = isBypassRol(u.rol);
                // caps_efectivas viene null para bypass, o array de slugs.
                const capsCount = Array.isArray(u.caps_efectivas)
                  ? u.caps_efectivas.length
                  : (bypass ? totalCaps : 0);
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="flex-row" style={{ gap: 10 }}>
                        <div style={{
                          width: 32, height: 32, borderRadius: '50%',
                          background: bypass ? 'var(--accent-soft)' : 'var(--surface-3)',
                          display: 'grid', placeItems: 'center',
                          fontWeight: 700, fontSize: 11,
                          color: bypass ? 'var(--accent)' : 'var(--text)',
                          flexShrink: 0,
                        }}>
                          {initials(u.nombre)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{u.nombre}</div>
                          <div className="muted tiny mono">
                            @{u.username}
                            {u.email && ` · ${u.email}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={bypass ? 'accent' : 'default'}>
                        {ROL_LABELS[u.rol] || u.rol}
                      </Badge>
                    </td>
                    <td>
                      {bypass
                        ? <span className="muted tiny">Acceso total — sin restricciones</span>
                        : <span className="muted tiny mono">{capsCount} / {totalCaps}</span>
                      }
                    </td>
                    <td>
                      {!u.overrides || u.overrides.length === 0
                        ? <span className="dim tiny">—</span>
                        : <span className="muted tiny">{u.overrides.length} ajuste{u.overrides.length > 1 ? 's' : ''}</span>
                      }
                    </td>
                    <td>
                      <div className="flex-row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        {/* Owner NO se edita desde acá (lo gestiona el flujo de signup
                            + transferencia explícita). Admin global histórico del sistema
                            viejo (legacy_role='admin') tampoco — bypass lo hace innecesario. */}
                        {u.rol !== 'owner' && u.legacy_role !== 'admin' && (
                          <button
                            className="icon-btn"
                            title="Editar permisos"
                            aria-label="Editar permisos"
                            onClick={() => setEditingId(u.id)}
                          >
                            <Icons.Edit size={14} />
                          </button>
                        )}
                        {u.rol !== 'owner' && (
                          <button
                            className="icon-btn"
                            title="Eliminar usuario"
                            aria-label="Eliminar usuario"
                            style={{ color: 'var(--neg)' }}
                            onClick={() => handleDelete(u)}
                          >
                            <Icons.Trash size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Modal: editar rol + overrides ─────────────────────────────────── */}
      {userEditando && (
        <EditorPermisos
          usuario={userEditando}
          pantallas={pantallas}
          onClose={() => setEditingId(null)}
          onSaved={handleSaved}
        />
      )}

      {/* ── Modal: nuevo usuario ──────────────────────────────────────────── */}
      {showCreate && (
        <div ref={createModalRef} className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nuevo usuario</h3>
              <button className="icon-btn" onClick={() => setShowCreate(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            {/* 2026-07-11: form como flex-column con flex:1 + minHeight:0 para
                que la cadena flex del .modal (display:flex column + max-height:
                calc(100svh - 48px) + overflow:hidden) se propague al .modal-body.
                Antes usábamos `maxHeight: '72vh'` inline como workaround. Con el
                form flex, el .modal-body.flex:1 + overflow-y:auto del base CSS
                scrollea automáticamente. Ver Envios.jsx modal para el fix inicial. */}
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 16 }}>
                  <div className="row">
                    <div className="field u-flex-1">
                      <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className={'input' + (fieldErrors.nombre ? ' input-error' : '')} placeholder="Juan Pérez" value={newUser.nombre}
                        onChange={e => setNU('nombre', e.target.value)} autoFocus aria-invalid={!!fieldErrors.nombre} />
                      {fieldErrors.nombre && <div className="field-error">{fieldErrors.nombre}</div>}
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Usuario <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className={'input mono' + (fieldErrors.username ? ' input-error' : '')} placeholder="juanp" value={newUser.username}
                        onChange={e => setNU('username', e.target.value.toLowerCase())} aria-invalid={!!fieldErrors.username} />
                      {fieldErrors.username
                        ? <div className="field-error">{fieldErrors.username}</div>
                        : <div className="muted tiny" style={{ marginTop: 3 }}>Solo minúsculas, números y guión bajo.</div>}
                    </div>
                  </div>

                  <div className="row">
                    <div className="field u-flex-1">
                      {/* 2026-06-26 (#446): email pasa de opcional a obligatorio.
                          Sin email no podemos invitarlo, mandarle resets de pass,
                          ni notificaciones. */}
                      <label className="field-label">Email <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="email" className={'input' + (fieldErrors.email ? ' input-error' : '')} placeholder="juan@empresa.com" value={newUser.email}
                        onChange={e => setNU('email', e.target.value)} required aria-invalid={!!fieldErrors.email} />
                      {fieldErrors.email && <div className="field-error">{fieldErrors.email}</div>}
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Contraseña <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="password" className={'input' + (fieldErrors.password ? ' input-error' : '')} placeholder="••••••••" value={newUser.password}
                        onChange={e => setNU('password', e.target.value)} autoComplete="new-password" aria-invalid={!!fieldErrors.password} />
                      {fieldErrors.password
                        ? <div className="field-error">{fieldErrors.password}</div>
                        : <div className="muted tiny" style={{ marginTop: 3 }}>Mínimo 8 caracteres, con al menos una letra y un número.</div>}
                    </div>
                  </div>

                  <div className="field">
                    <label className="field-label">Rol base</label>
                    <select
                      className="input"
                      value={newUser.rol}
                      onChange={e => setNU('rol', e.target.value)}
                      style={{ fontSize: 14 }}
                    >
                      {ROLES_EDITABLES.map(r => (
                        <option key={r} value={r}>{ROL_LABELS[r]}</option>
                      ))}
                    </select>
                    <div className="muted tiny" style={{ marginTop: 4, lineHeight: 1.5 }}>
                      {ROL_DESCRIPCION[newUser.rol]}
                    </div>
                    <div className="muted tiny" style={{ marginTop: 4 }}>
                      Después podés ajustar permisos específicos desde la lista.
                    </div>
                  </div>

                  {createError && (
                    <div style={{ color: 'var(--neg)', fontSize: 13 }}>{createError}</div>
                  )}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Creando…' : 'Crear usuario'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Editor de permisos (modal) ─────────────────────────────────────────────
//
// Estado interno:
//   rol — el rol base seleccionado (string del enum)
//   overrides — array de { capability_slug, enabled }, reemplazo TOTAL al PUT.
//
// UX:
//   Cambiar el rol limpia los overrides (queremos arrancar desde el nuevo
//   default — si el usuario tildaba caps a mano de un rol viejo y luego cambia
//   a otro, esos tildes ya no tienen sentido).
//   Toggle de checkbox: si el nuevo valor matchea el default del rol, borramos
//   el override (no es ajuste). Si no matchea, lo agregamos/actualizamos.

function EditorPermisos({ usuario, pantallas, onClose, onSaved }) {
  const { toast } = useToast();
  const [rol, setRol] = useState(usuario.rol);
  const [overrides, setOverrides] = useState(usuario.overrides || []);
  const [saving, setSaving] = useState(false);

  // Lookup O(1) de overrides actuales por slug.
  const ovBySlug = useMemo(() => {
    const m = new Map();
    for (const o of overrides) m.set(o.capability_slug, o.enabled);
    return m;
  }, [overrides]);

  // Set de caps efectivas dado el rol + overrides.
  const effectiveCaps = useMemo(() => resolveCaps(rol, overrides), [rol, overrides]);
  const baseCaps      = useMemo(() => resolveCaps(rol, []), [rol]);

  // Para owner/admin: bypass total — no se editan capabilities. La UI
  // muestra la matriz pero deshabilitada con un mensaje.
  const bypass = isBypassRol(rol);

  function toggle(slug) {
    if (bypass) return; // no-op visual
    const baseOn = baseCaps?.has(slug) === true;
    const currentOn = ovBySlug.has(slug) ? ovBySlug.get(slug) : baseOn;
    const newOn = !currentOn;

    setOverrides(prev => {
      // Sacamos cualquier override previo sobre este slug.
      const without = prev.filter(o => o.capability_slug !== slug);
      // Si el nuevo valor coincide con el default del rol → sin override.
      if (newOn === baseOn) return without;
      // Sino, agregamos el override con su nuevo valor.
      return [...without, { capability_slug: slug, enabled: newOn }];
    });
  }

  function cambiarRol(nuevo) {
    setRol(nuevo);
    setOverrides([]); // arrancamos desde los defaults del rol nuevo
  }

  function restaurarAlRol() { setOverrides([]); }

  async function handleSubmit() {
    setSaving(true);
    try {
      const r = await capsApi.update(usuario.id, { rol, overrides });
      // r tiene { rol, overrides, pw_bumped }. Las caps_efectivas las
      // recalculamos en parent al hacer onSaved — más simple que volver a
      // pegar al endpoint GET /users.
      const efectivas = resolveCaps(r.rol, r.overrides);
      onSaved({
        ...usuario,
        rol: r.rol,
        overrides: r.overrides,
        caps_efectivas: efectivas === null ? null : Array.from(efectivas),
      });
      toast.success(r.pw_bumped
        ? 'Permisos guardados. El usuario va a tener que volver a iniciar sesión.'
        : 'Permisos guardados.');
    } catch (e) {
      toast.error(e.message || 'No se pudieron guardar los permisos.');
    } finally {
      setSaving(false);
    }
  }

  // Lista de capabilities (slug + label) por pantalla. La fuente de verdad
  // del display es lo que vino del backend GET /catalog — usamos las labels
  // de ahí (no las hardcodeamos acá).
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: '100%', maxWidth: 780, maxHeight: '92vh', overflow: 'hidden',
          padding: 0, display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>Permisos: {usuario.nombre}</div>
              <div className="muted tiny" style={{ marginTop: 4 }}>@{usuario.username}{usuario.email && ` · ${usuario.email}`}</div>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <Icons.X size={16} />
            </button>
          </div>
        </div>

        {/* Rol base dropdown */}
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--hairline)' }}>
          <div className="field-label" style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Rol base</div>
          <div className="flex-row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <select
              className="input"
              value={rol}
              onChange={(e) => cambiarRol(e.target.value)}
              disabled={saving}
              style={{ minWidth: 180, fontSize: 14, padding: '8px 12px' }}
            >
              {ROLES_EDITABLES.map(r => (
                <option key={r} value={r}>{ROL_LABELS[r]}</option>
              ))}
            </select>
            <div className="muted tiny" style={{ flex: 1, minWidth: 200, lineHeight: 1.5 }}>
              {ROL_DESCRIPCION[rol]}
            </div>
          </div>
        </div>

        {/* Capabilities por pantalla */}
        <div style={{ padding: '16px 22px', flex: 1, overflow: 'auto' }}>
          <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Permisos por pantalla</div>
            {!bypass && overrides.length > 0 && (
              <button className="btn btn-sm" onClick={restaurarAlRol} disabled={saving}>
                ↺ Restaurar al rol base
              </button>
            )}
          </div>

          {bypass && (
            <div style={{
              padding: '12px 14px', marginBottom: 12,
              background: 'var(--accent-soft, rgba(96,165,250,0.14))',
              borderLeft: '3px solid var(--accent)', borderRadius: 6, fontSize: 13,
            }}>
              <strong>{ROL_LABELS[rol]}</strong> tiene <strong>acceso total</strong> a todas las pantallas y capabilities. No se editan permisos individuales — el rol manda.
            </div>
          )}

          {pantallas.map(pantalla => {
            const caps = pantalla.capabilities || [];
            const capsOn = caps.filter(c => bypass || effectiveCaps?.has(c.slug)).length;
            const total = caps.length;
            return (
              <div
                key={pantalla.id}
                style={{
                  marginBottom: 10,
                  border: '1px solid var(--hairline)',
                  borderRadius: 8,
                  background: capsOn === 0 ? 'transparent' : 'var(--surface)',
                  overflow: 'hidden',
                  opacity: bypass ? 0.6 : 1,
                }}
              >
                <div style={{
                  padding: '10px 14px',
                  background: capsOn === total ? 'color-mix(in oklab, var(--pos) 8%, var(--surface))'
                            : capsOn > 0     ? 'var(--surface)'
                            :                  'transparent',
                  borderBottom: '1px solid var(--hairline)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{pantalla.label}</div>
                  <div className="muted tiny">
                    {capsOn}/{total} {capsOn === total ? '✓ acceso completo' : capsOn === 0 ? '✕ sin acceso' : 'parcial'}
                  </div>
                </div>
                <div style={{ padding: '6px 14px 10px' }}>
                  {caps.map(cap => {
                    const isOn  = bypass || effectiveCaps?.has(cap.slug) === true;
                    const isBase = bypass || baseCaps?.has(cap.slug) === true;
                    const esOverride = !bypass && (isOn !== isBase);
                    return (
                      <label
                        key={cap.slug}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '6px 0', cursor: bypass || saving ? 'default' : 'pointer', fontSize: 13,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={bypass || saving}
                          onChange={() => toggle(cap.slug)}
                          style={{ width: 16, height: 16, cursor: bypass ? 'default' : 'pointer' }}
                        />
                        <span className="u-flex-1">{cap.label}</span>
                        {esOverride && (
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                            background: isOn
                              ? 'color-mix(in oklab, var(--pos) 18%, transparent)'
                              : 'color-mix(in oklab, var(--neg) 18%, transparent)',
                            color: isOn ? 'var(--pos)' : 'var(--neg)',
                          }}>
                            {isOn ? '+ override' : '− revocado'}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Overrides summary — solo se muestra si hay overrides y no es bypass. */}
          {!bypass && overrides.length > 0 && (
            <div style={{
              marginTop: 12, padding: '10px 14px',
              background: 'var(--surface-2)', borderRadius: 6,
              borderLeft: '3px solid var(--accent)', fontSize: 12.5,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {overrides.length} ajuste{overrides.length > 1 ? 's' : ''} sobre el rol base:
              </div>
              <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
                {overrides.map((o, i) => {
                  // Buscamos label de cap + pantalla en el catálogo.
                  let pantallaLabel = o.capability_slug;
                  let capLabel = '';
                  for (const p of pantallas) {
                    const c = (p.capabilities || []).find(x => x.slug === o.capability_slug);
                    if (c) { pantallaLabel = p.label; capLabel = c.label; break; }
                  }
                  return (
                    <li key={i}>
                      <strong>{pantallaLabel}</strong>{capLabel && ` → ${capLabel}`} ·{' '}
                      <span style={{ color: o.enabled ? 'var(--pos)' : 'var(--neg)' }}>
                        {o.enabled ? 'agregado' : 'revocado'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 22px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'flex-end', gap: 10,
        }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
