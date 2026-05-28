import { useState, useEffect } from 'react';
import { Icons } from '../components/Icons';
import { usuarios as usuariosApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { TOOLS } from '../lib/tools';
import { fmt } from '../lib/format';

const TOOL_LABELS = {
  cotizador:  'Cotizador',
  financiera: 'Financiera',
  cajas:      'Cajas',
  envios:     'Envíos',
  cuentas:    'Cuentas CC',
  usados:     'Usados',
  usuarios:   'Usuarios',
  inventario: 'Inventario',
  ventas:     'Ventas',
  proveedores: 'Proveedores | Compras',
  proyectos:  'Proyectos',
  contactos:  'Contactos',
  cambios:    'Cambios de Divisa',
  tarjetas:   'Tarjetas de Crédito',
};

function initials(nombre) {
  return ((nombre || '').split(' ').slice(0, 2).map(w => w[0]).join('') || '??').toUpperCase();
}

function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export default function Usuarios() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const [users, setUsers]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [rolFilter, setRolFilter]   = useState('todos');
  const [editingId, setEditingId]   = useState(null);
  const [editPerms, setEditPerms]   = useState({});
  const [saving, setSaving]         = useState(false);

  // ── Alta de usuario ─────────────────────────────────────────────────────
  const EMPTY_NEW = { nombre: '', username: '', email: '', password: '', role: 'op', perms: {} };
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser]       = useState(EMPTY_NEW);
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState('');

  function openCreate() {
    setNewUser(EMPTY_NEW);
    setCreateError('');
    setShowCreate(true);
  }
  const setNU = (field, val) => setNewUser(u => ({ ...u, [field]: val }));

  async function handleCreate(e) {
    e.preventDefault();
    const nombre = newUser.nombre.trim();
    const username = newUser.username.trim().toLowerCase();
    if (!nombre) { setCreateError('El nombre es obligatorio.'); return; }
    if (username.length < 2) { setCreateError('El usuario debe tener al menos 2 caracteres.'); return; }
    if (!/^[a-z0-9_]+$/.test(username)) { setCreateError('Usuario: solo minúsculas, números y guión bajo.'); return; }
    if (newUser.password.length < 8 || !/[A-Za-z]/.test(newUser.password) || !/[0-9]/.test(newUser.password)) {
      setCreateError('La contraseña debe tener mínimo 8 caracteres, con al menos una letra y un número.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const created = await usuariosApi.create({
        nombre,
        username,
        email: newUser.email.trim() || null,
        password: newUser.password,
        role: newUser.role,
        perms: newUser.role === 'admin' ? {} : newUser.perms,
      });
      setUsers(prev => [created, ...prev]);
      setShowCreate(false);
      toast.success('Usuario creado.');
    } catch (err) {
      setCreateError(err.message || 'No se pudo crear el usuario.');
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    usuariosApi.list()
      .then(data => setUsers(Array.isArray(data) ? data : []))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── KPI ──────────────────────────────────────────────────────────────────
  const admins   = users.filter(u => u.role === 'admin').length;
  const operadores = users.filter(u => u.role === 'op' || u.role === 'operador').length;

  // ── Filter ────────────────────────────────────────────────────────────────
  const filtered = users.filter(u => {
    if (rolFilter === 'todos') return true;
    if (rolFilter === 'admin') return u.role === 'admin';
    if (rolFilter === 'op') return u.role === 'op' || u.role === 'operador';
    return true;
  });

  // ── Edit handlers ─────────────────────────────────────────────────────────
  function startEdit(u) {
    setEditingId(u.id);
    setEditPerms({ ...(u.perms || {}) });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditPerms({});
  }

  async function savePerms(userId) {
    setSaving(true);
    try {
      const updated = await usuariosApi.update(userId, { perms: editPerms });
      setUsers(prev =>
        prev.map(u =>
          u.id === userId ? { ...u, perms: updated?.perms || editPerms } : u
        )
      );
      setEditingId(null);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(userId) {
    const ok = await confirm({ title: 'Eliminar usuario', message: 'Esta acción desactivará la cuenta. No se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await usuariosApi.delete(userId);
      setUsers(prev => prev.filter(u => u.id !== userId));
      toast.success('Usuario eliminado.');
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Usuarios</h1>
          <div className="page-sub">Accesos y permisos · admin (bypass total) u operador (granular por tool)</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={() => {
            setLoading(true);
            usuariosApi.list()
              .then(data => setUsers(Array.isArray(data) ? data : []))
              .catch(e => toast.error(e.message))
              .finally(() => setLoading(false));
          }}>
            <Icons.Refresh size={15} />
            Actualizar
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <Icons.Plus size={15} />
            Nuevo usuario
          </button>
        </div>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Total usuarios</div>
          <div className="kpi-value mono">{users.length}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Admins</div>
          <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>{admins}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>acceso total</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Operadores</div>
          <div className="kpi-value mono">{operadores}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>permisos granulares</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Tools disponibles</div>
          <div className="kpi-value mono">{TOOLS.length}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>permisos por usuario</div>
        </div>
      </div>

      {/* ── Filter segment ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <div className="seg">
          {[
            { value: 'todos', label: 'Todos' },
            { value: 'admin', label: 'Admins' },
            { value: 'op',    label: 'Operadores' },
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

      {/* ── Users table ───────────────────────────────────────────────────── */}
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
                <th>Permisos activos</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => {
                const isAdmin = u.role === 'admin';
                const activeTools = isAdmin ? TOOLS : TOOLS.filter(t => u.perms?.[t]);
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="flex-row" style={{ gap: 10 }}>
                        <div style={{
                          width: 32, height: 32, borderRadius: '50%',
                          background: isAdmin ? 'var(--accent-soft)' : 'var(--surface-3)',
                          display: 'grid', placeItems: 'center',
                          fontWeight: 700, fontSize: 11,
                          color: isAdmin ? 'var(--accent)' : 'var(--text)',
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
                      {isAdmin
                        ? <Badge tone="accent">Admin</Badge>
                        : <Badge tone="default">Operador</Badge>
                      }
                    </td>
                    <td>
                      {isAdmin ? (
                        <span className="muted tiny">Bypass total · acceso a todo</span>
                      ) : (
                        <div className="flex-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {activeTools.length === 0
                            ? <span className="dim tiny">Sin permisos</span>
                            : activeTools.map(t => (
                              <Badge key={t} tone="info" style={{ fontSize: 11 }}>
                                {TOOL_LABELS[t]}
                              </Badge>
                            ))
                          }
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="flex-row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          className="icon-btn"
                          title="Editar permisos"
                          onClick={() =>
                            editingId === u.id ? cancelEdit() : startEdit(u)
                          }
                        >
                          <Icons.Edit size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Eliminar usuario"
                          style={{ color: 'var(--neg)' }}
                          onClick={() => handleDelete(u.id)}
                        >
                          <Icons.Trash size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Inline permission editor ──────────────────────────────────────── */}
      {editingId !== null && (() => {
        const u = users.find(x => x.id === editingId);
        if (!u) return null;
        const isAdmin = u.role === 'admin';
        return (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-hd flex-between">
              <div>
                <div style={{ fontWeight: 600 }}>Permisos de {u.nombre}</div>
                <div className="muted tiny" style={{ marginTop: 2 }}>
                  {isAdmin
                    ? 'Admin — los permisos se ignoran (acceso total)'
                    : 'Marcá las tools a las que tiene acceso'}
                </div>
              </div>
              <div className="flex-row" style={{ gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                  Cancelar
                </button>
                {!isAdmin && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => savePerms(u.id)}
                    disabled={saving}
                  >
                    <Icons.Check size={14} />
                    {saving ? 'Guardando…' : 'Guardar'}
                  </button>
                )}
              </div>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 8,
              padding: 16,
            }}>
              {isAdmin ? (
                <span className="muted tiny">Acceso total (admin)</span>
              ) : (
                TOOLS.map(t => (
                  <label
                    key={t}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 14px',
                      background: editPerms[t] ? 'var(--surface-2)' : 'var(--surface)',
                      border: `1px solid ${editPerms[t] ? 'var(--border-strong)' : 'var(--border)'}`,
                      borderRadius: 8,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={editPerms[t] || false}
                      onChange={e =>
                        setEditPerms(p => ({ ...p, [t]: e.target.checked }))
                      }
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      {TOOL_LABELS[t]}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Modal: nuevo usuario ──────────────────────────────────────────── */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nuevo usuario</h3>
              <button className="icon-btn" onClick={() => setShowCreate(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="Juan Pérez" value={newUser.nombre}
                        onChange={e => setNU('nombre', e.target.value)} autoFocus />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Usuario <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input mono" placeholder="juanp" value={newUser.username}
                        onChange={e => setNU('username', e.target.value.toLowerCase())} />
                      <div className="muted tiny" style={{ marginTop: 3 }}>Solo minúsculas, números y guión bajo.</div>
                    </div>
                  </div>

                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Email <span className="muted">(opcional)</span></label>
                      <input type="email" className="input" placeholder="juan@empresa.com" value={newUser.email}
                        onChange={e => setNU('email', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Contraseña <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="password" className="input" placeholder="••••••••" value={newUser.password}
                        onChange={e => setNU('password', e.target.value)} autoComplete="new-password" />
                      <div className="muted tiny" style={{ marginTop: 3 }}>Mínimo 8 caracteres, con al menos una letra y un número.</div>
                    </div>
                  </div>

                  <div className="field">
                    <label className="field-label">Rol</label>
                    <div className="seg">
                      <button type="button" className={`seg-btn${newUser.role === 'op' ? ' on' : ''}`}
                        onClick={() => setNU('role', 'op')}>Operador</button>
                      <button type="button" className={`seg-btn${newUser.role === 'admin' ? ' on' : ''}`}
                        onClick={() => setNU('role', 'admin')}>Admin</button>
                    </div>
                    <div className="muted tiny" style={{ marginTop: 4 }}>
                      {newUser.role === 'admin'
                        ? 'Admin: acceso total a todos los módulos (los permisos se ignoran).'
                        : 'Operador: solo accede a las tools que marques abajo.'}
                    </div>
                  </div>

                  {newUser.role === 'op' && (
                    <div className="field">
                      <label className="field-label">Permisos (tools)</label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                        {TOOLS.map(t => (
                          <label key={t} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                            background: newUser.perms[t] ? 'var(--surface-2)' : 'var(--surface)',
                            border: `1px solid ${newUser.perms[t] ? 'var(--border-strong)' : 'var(--border)'}`,
                            borderRadius: 8, cursor: 'pointer',
                          }}>
                            <input type="checkbox" checked={newUser.perms[t] || false}
                              onChange={e => setNewUser(u => ({ ...u, perms: { ...u.perms, [t]: e.target.checked } }))}
                              style={{ accentColor: 'var(--accent)' }} />
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{TOOL_LABELS[t]}</span>
                          </label>
                        ))}
                      </div>
                      <div className="muted tiny" style={{ marginTop: 4 }}>
                        El usuario debe volver a iniciar sesión para que los permisos tomen efecto.
                      </div>
                    </div>
                  )}

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
