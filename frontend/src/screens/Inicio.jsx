import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Icons } from '../components/Icons';
import { config, comprobantes, cuentas, envios, historial } from '../lib/api';
import { fmt as fmtMagnitud } from '../lib/format';

// ─── Formatters ──────────────────────────────────────────────────────────────
// Hygiene H2 auditoría 2026-06-06: usar lib/format como fuente única.
// Mantenemos wrappers locales por:
//   · fmt() — prefijo '$' (las tarjetas del dashboard piden moneda visible).
//   · fmtFecha() — variante "hoy con día semana" sin argumentos (header del
//     saludo); el helper compartido toma ISO y devuelve dd/mm/aa.
//   · fmtCount() — String(n) trivial, no vale la pena un helper.

function fmt(n) {
  return '$' + fmtMagnitud(n);
}

function fmtCount(n) {
  return String(Number(n) || 0);
}

function fmtFecha() {
  return new Date().toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function relativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hs = Math.floor(mins / 60);
  if (hs < 24) return `hace ${hs} h`;
  return `hace ${Math.floor(hs / 24)} d`;
}

// ─── Static data ─────────────────────────────────────────────────────────────

const OP_MAP = {
  INSERT: { icon: 'Plus',    tint: 'pos'  },
  UPDATE: { icon: 'Edit',    tint: 'info' },
  DELETE: { icon: 'Trash',   tint: 'neg'  },
  OCR:    { icon: 'Sparkle', tint: 'info' },
  LOGIN:  { icon: 'Users',   tint: 'muted'},
};

const TABLA_LABEL = {
  comprobantes:   'comprobante',
  pagos:          'pago',
  envios:         'envío',
  clientes_cc:    'cliente CC',
  movimientos_cc: 'movimiento CC',
  usados:         'equipo',
  users:          'usuario',
};

// ─── Main component ──────────────────────────────────────────────────────────

export default function Inicio() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const todayStr = new Date().toLocaleDateString('sv'); // YYYY-MM-DD
    Promise.all([
      config.get(),
      comprobantes.totales({ desde: todayStr, hasta: todayStr }),
      cuentas.resumenGeneral(),
      envios.list(),
      historial.list({ per_page: 6, page: 1 }),
    ])
      .then(([cfg, compTotales, rgData, envData, hData]) => {
        setData({ cfg, compTotales, rgData, envData, hData });
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Derived values (only when data is available)
  const comprobantesHoy = data ? Number(data.compTotales.count) : 0;
  const montoNeto       = data ? Number(data.compTotales.total_neto) : 0;
  const pctFin          = data ? Number(data.cfg.pct_financiera) : 0;
  const totalDeuda      = data ? Number(data.rgData.total_deuda) : 0;
  const cantClientes    = data ? Number(data.rgData.cant_clientes) : 0;

  const activosCount = data
    ? (data.envData.data || []).filter(e => e.estado === 'Pendiente' || e.estado === 'En camino').length
    : 0;

  const tools = [
    { id: 'egresos',     name: 'Egresos',              desc: 'Gastos por categoría · recurrentes', icon: 'ArrowDownRight', tint: 'amber',  meta: 'Salidas de dinero' },
    { id: 'inventario',  name: 'Inventario',           desc: 'Stock · costos · valorizado',         icon: 'Box',         tint: 'green',  meta: 'Equipos y accesorios' },
    { id: 'proveedores', name: 'Proveedores | Compras',desc: 'Compras y cuenta corriente',          icon: 'Building',    tint: 'cyan',   meta: 'Cta. cte. con proveedores' },
    { id: 'financiera',  name: 'Transferencias',       desc: 'Comprobantes, pagos y OCR',           icon: 'Trend',       tint: 'blue',   meta: 'Comprobantes y pagos' },
    { id: 'cambios',     name: 'Cambios de Divisa',    desc: 'Conversión USD ↔ ARS ↔ USDT',         icon: 'Dollar',      tint: 'pink',   meta: 'Operaciones de cambio' },
    { id: 'tarjetas',    name: 'Tarjetas de Crédito',  desc: 'Cobros y liquidaciones',              icon: 'CreditCard',  tint: 'purple', meta: 'Por método de pago' },
    { id: 'cotizador',   name: 'Cotizador',            desc: 'Precios con cuotas y USD → ARS',      icon: 'Calculator',  tint: 'amber',  meta: 'Cotizar a clientes' },
    { id: 'usados',      name: 'Usados | Cotizador',   desc: 'Catálogo de precios USD',             icon: 'Phone',       tint: 'pink',   meta: 'Equipos usados' },
    { id: 'envios',      name: 'Envíos',               desc: 'Despachos a domicilio · prioridad',   icon: 'Truck',       tint: 'purple', meta: data ? `${activosCount} activos` : '—' },
  ];

  // Parse historial items
  const activityItems = data
    ? (data.hData.data || []).map(row => {
        // accion format: "tabla: ACCION"
        const parts = (row.accion || '').split(': ');
        const tabla = parts[0] || '';
        const op    = (parts[1] || '').toUpperCase();
        const opInfo = OP_MAP[op] || { icon: 'Bolt', tint: 'muted' };
        const tablaLabel = TABLA_LABEL[tabla] || tabla;
        const verb = op === 'INSERT' ? 'registró' : op === 'UPDATE' ? 'actualizó' : op === 'DELETE' ? 'eliminó' : 'procesó';
        return {
          id:    row.id,
          icon:  opInfo.icon,
          tint:  opInfo.tint,
          who:   row.usuario_nombre || 'Sistema',
          what:  ` ${verb} ${tablaLabel}`,
          ref:   row.detalle ? ` · ${row.detalle}` : null,
          time:  relativeTime(row.creado_en),
        };
      })
    : [];

  const nombreCorto = user?.nombre ? user.nombre.split(' ')[0] : 'Lucas';
  const horaActual  = new Date().getHours();
  const saludo      = horaActual < 13 ? 'Buen día' : horaActual < 20 ? 'Buenas tardes' : 'Buenas noches';

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div>
        <div className="hello">
          <div className="greet">
            <h1>{saludo}, {nombreCorto}</h1>
            <div className="sub">{fmtFecha()} · cargando datos…</div>
          </div>
        </div>

      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <div>
        <div className="hello">
          <div className="greet">
            <h1>{saludo}, {nombreCorto}</h1>
            <div className="sub">{fmtFecha()}</div>
          </div>
        </div>
        <div style={{ color: 'var(--neg)', fontSize: 13, padding: '12px 0' }}>
          Error al cargar datos: {error}
        </div>
      </div>
    );
  }

  // ── Full render ───────────────────────────────────────────────────────────
  return (
    <div>
      {/* Greeting */}
      <div className="hello">
        <div className="greet">
          <h1>{saludo}, {nombreCorto}</h1>
          <div className="sub">
            {fmtFecha()} · financiera al {pctFin.toFixed(1)}% · {activityItems.length} eventos recientes
          </div>
        </div>
      </div>

      {/* Tools + Activity */}
      <div className="split-2" style={{ marginTop: 'var(--gap)' }}>
        {/* Tools column */}
        <div className="col">
          <div className="flex-between">
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Herramientas
            </h2>
            <div className="muted tiny">Acceso a los módulos del portal</div>
          </div>
          <div className="tool-grid">
            {tools.map(t => {
              const I = Icons[t.icon];
              return (
                <div key={t.id} className="tool" onClick={() => navigate('/' + t.id)}>
                  <div className={'tool-icon tint-' + t.tint}>
                    {I && <I size={20} />}
                  </div>
                  <div className="tool-title">{t.name}</div>
                  <div className="tool-sub">{t.desc}</div>
                  <div className="tool-meta">
                    <span>{t.meta}</span>
                  </div>
                  <div className="tool-arrow">
                    <Icons.ArrowUpRight size={14} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Activity card */}
        <div className="card card-flush">
          <div className="card-hd">
            <h3>Actividad reciente</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/historial')}>
              Ver todo
            </button>
          </div>
          <div className="activity">
            {activityItems.length === 0 && (
              <div className="empty">Sin actividad reciente</div>
            )}
            {activityItems.map(a => {
              const I = Icons[a.icon] || Icons.Bolt;
              return (
                <div key={a.id} className="activity-item">
                  <div className="dot-ico">
                    <I size={14} />
                  </div>
                  <div className="activity-msg">
                    <span className="who">{a.who}</span>
                    <span className="what">{a.what}</span>
                    {a.ref && (
                      <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: 12 }}>
                        {a.ref}
                      </span>
                    )}
                  </div>
                  <div className="activity-time">{a.time}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
