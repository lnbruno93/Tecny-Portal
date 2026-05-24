import { useState, useEffect } from 'react';
import { Icons } from '../components/Icons';
import { usuarios as usuariosApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// ─── Formatter ───────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return Math.round(v).toLocaleString('es-AR');
}

const TOOLS = ['cotizador', 'financiera', 'cajas', 'envios', 'usuarios', 'cuentas', 'usados', 'inventario', 'ventas'];

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
          <div className="page-title">Usuarios</div>
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
    </div>
  );
}
