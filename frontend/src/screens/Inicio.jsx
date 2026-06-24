import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Icons } from '../components/Icons';
import { config, envios, historial } from '../lib/api';
import { fmt as fmtMagnitud } from '../lib/format';
// 2026-06-18 #323 TANDA 1 H3: card de onboarding para signup público nuevo.
// El componente se auto-oculta cuando el user completa los 3 pasos o lo
// dismissa manualmente — no hay flag de "es user nuevo" porque es más
// honesto basarse en el estado real del tenant.
import OnboardingCard from '../components/OnboardingCard';
import { userHasCap } from '../lib/userHasCap';

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
    // 2026-06-10 U-04: eliminados los fetches a `comprobantes.totales()` y
    // `cuentas.resumenGeneral()`. Las variables derivadas que dependían de ellos
    // (`comprobantesHoy`, `montoNeto`, `totalDeuda`, `cantClientes`) estaban
    // declaradas pero NUNCA se renderizaban — eran dead code que ralentizaba
    // la TTI inicial sin aportar nada (uno tarda → TTI tarda, especialmente si
    // el backend está bajo presión). Si en el futuro queremos mostrarlas, hay
    // que re-agregarlas con su tile correspondiente.
    // 2026-06-23 F5c: solo pegamos a /api/historial si el user tiene la cap
    // `inicio.actividad_reciente` (la card de abajo gateada por la misma
    // cap). Sin esto, vendedores rebotaban con 403 y rompían el TTI inicial.
    // 2026-06-24 TANDA 1 P1 fix: degradar cada fetch por separado en lugar
    // de Promise.all + catch global. El patrón anterior rompía la home
    // entera para LECTURA (no tiene envios.trabajar ni config.*) — el
    // primer 403 de Promise.all hacía setError y desaparecían greeting +
    // tools + activity. Ahora cada fetch falla a su propio fallback y la
    // pantalla siempre renderiza con lo que pudo conseguir.
    const wantsHistorial = userHasCap(user, 'inicio.actividad_reciente');
    const swallowForbidden = (fallback) => (err) => {
      // 403 = falta cap. Degradamos silenciosamente (la UI ya esconde el
      // bloque correspondiente). Otros errores también degradan, pero
      // los logueamos para que sigan apareciendo en Sentry.
      if (err?.status !== 403) {
        // eslint-disable-next-line no-console
        console.warn('[Inicio] fetch falló', err);
      }
      return fallback;
    };
    Promise.all([
      config.get().catch(swallowForbidden({ pct_financiera: 0 })),
      envios.list().catch(swallowForbidden({ data: [] })),
      wantsHistorial
        ? historial.list({ per_page: 6, page: 1 }).catch(swallowForbidden({ data: [] }))
        : Promise.resolve({ data: [] }),
    ])
      .then(([cfg, envData, hData]) => {
        setData({ cfg, envData, hData });
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [user]);

  // Derived values (only when data is available)
  const pctFin = data ? Number(data.cfg.pct_financiera) : 0;

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
      {/* TANDA 1 H3 #323: onboarding card. Visible solo si el user no completó
          los 3 primeros pasos y no clickeó "saltar". Se auto-oculta cuando
          corresponde. NO recibe props — fetchea su propio status. */}
      <OnboardingCard />

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

        {/* Activity card — 2026-06-23 F5c: solo visible si el user tiene
            la capability `inicio.actividad_reciente`. Vendedor sin la cap
            ve el resto del Inicio sin esta card (greeting + tools grid). */}
        {userHasCap(user, 'inicio.actividad_reciente') && (
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
        )}
      </div>
    </div>
  );
}
