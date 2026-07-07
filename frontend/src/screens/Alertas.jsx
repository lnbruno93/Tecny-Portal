// Módulo "Alertas" — exporta `AlertasModule` para embebido dentro de Config
// (como un tab) sin asumir un page-head propio. El consumidor (Config.jsx)
// renderiza el header y wrappea el módulo.
//
// Dos sub-vistas internas: Activas (lista de alertas que disparan ahora) y
// Configuración (toggle on/off + edit de umbrales).
//
// Activas: agrupa por tipo (caja_negativa, stock_bajo, cc_mora, proveedor_atrasado)
// con count + lista expandible + link al lugar de acción.

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { alertas as alertasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { blockInvalidNumberKeys } from '../lib/inputUtils';
import { useTcReferencia } from '../contexts/TcReferenciaContext';

const TITULOS = {
  caja_negativa:      'Caja en negativo',
  stock_bajo:         'Stock bajo',
  cc_mora:            'Clientes en mora',
  proveedor_atrasado: 'Proveedores con deuda atrasada',
  tc_referencia:      'TC de referencia (warning inline)',
};

// Tipos que NO son "alertas activas" sino settings globales. El front los
// renderiza aparte en la pestaña Configurar (no aparecen en Activas).
const TIPOS_SETTING = new Set(['tc_referencia']);

// Etiqueta amigable + tipo de input para cada parámetro conocido.
const PARAMETROS_META = {
  umbral_unidades:      { label: 'Unidades mínimas antes de alertar', tipo: 'number', min: 1, max: 1000 },
  dias_sin_pago:        { label: 'Días sin pago para considerar moroso', tipo: 'number', min: 1, max: 365 },
  dias_sin_movimiento:  { label: 'Días sin movimiento para alertar', tipo: 'number', min: 1, max: 365 },
  valor:                { label: 'TC de referencia (ARS por USD)', tipo: 'number', min: 1, max: 100000 },
  tolerancia_pct:       { label: '% de tolerancia por debajo', tipo: 'number', min: 0, max: 50 },
};

const COLOR_SEVERIDAD = {
  critica: 'var(--neg)',
  alta:    'var(--warn)',
  media:   'var(--accent)',
  baja:    'var(--text-muted)',
};

export default function AlertasModule() {
  const { toast } = useToast();
  const [subtab, setSubtab] = useState('activas');
  const [activas, setActivas] = useState(null);   // { grupos, total_alertas, generado_en }
  const [config, setConfig] = useState([]);       // [{tipo, activa, parametros, ...}]
  const [loading, setLoading] = useState(true);

  function loadAll() {
    setLoading(true);
    Promise.all([alertasApi.list(), alertasApi.config()])
      .then(([a, c]) => { setActivas(a); setConfig(c); })
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(loadAll, []); // eslint-disable-line

  return (
    <div>
      <div className="flex-row" style={{ gap: 4, marginBottom: 12 }}>
        <button className={'btn ' + (subtab === 'activas' ? 'btn-primary' : '')}
                onClick={() => setSubtab('activas')}>
          Activas {activas?.total_alertas > 0 && (
            <span className="badge" style={{ background: 'var(--neg)', color: '#fff', marginLeft: 6 }}>
              {activas.total_alertas}
            </span>
          )}
        </button>
        <button className={'btn ' + (subtab === 'config' ? 'btn-primary' : '')}
                onClick={() => setSubtab('config')}>
          Configurar alertas
        </button>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} title="Recargar">
          <Icons.Refresh size={14} />
        </button>
      </div>

      {loading ? <div className="empty">Cargando…</div> : (
        subtab === 'activas'
          ? <TabActivas data={activas} />
          : <TabConfig config={config} onSaved={loadAll} />
      )}
    </div>
  );
}

export function TabActivas({ data }) {
  if (!data) return <div className="empty">Sin datos.</div>;
  if (data.total_alertas === 0) {
    return (
      <div className="card card-tight" style={{ textAlign: 'center', padding: 32, color: 'var(--pos)' }}>
        <Icons.Check size={32} />
        <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>Todo bajo control</div>
        <div className="muted tiny" style={{ marginTop: 4 }}>No hay alertas activas en este momento.</div>
      </div>
    );
  }
  // Defensive audit 2026-07-06: `data.grupos` viene del backend siempre
  // como array (fetcher canónico en alertas route line 43), pero un guard
  // barato hace la pantalla resistente a un rollback/deploy que devuelva
  // shape parcial. Sin esto un `undefined.filter()` explota el chunk.
  const grupos = data.grupos || [];
  return (
    <>
      {grupos.filter(g => g.count > 0).map(g => (
        <GrupoAlerta key={g.tipo} grupo={g} />
      ))}
      {grupos.filter(g => g.count === 0).length > 0 && (
        <div className="muted tiny" style={{ marginTop: 12 }}>
          ✓ Sin alertas en: {grupos.filter(g => g.count === 0).map(g => TITULOS[g.tipo] || g.tipo).join(', ')}
        </div>
      )}
    </>
  );
}

function GrupoAlerta({ grupo }) {
  const [expanded, setExpanded] = useState(true);
  const color = COLOR_SEVERIDAD[grupo.severidad] || 'var(--accent)';
  return (
    <div className="card card-tight" style={{ marginBottom: 12, borderLeft: `4px solid ${color}` }}>
      <div className="flex-between" style={{ cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
        <div>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{grupo.titulo}</span>
          <span className="badge" style={{ marginLeft: 8, background: color, color: '#fff' }}>{grupo.count}</span>
        </div>
        <button className="icon-btn">
          {expanded ? <Icons.ChevronUp size={16} /> : <Icons.ChevronDown size={16} />}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {grupo.error ? (
            <div className="empty tiny" style={{ color: 'var(--neg)' }}>Error: {grupo.error}</div>
          ) : (
            <div style={{ borderTop: '1px solid var(--border)' }}>
              {grupo.items.map(item => (
                <div key={item.id} className="flex-between" style={{
                  padding: '6px 0', borderBottom: '1px solid var(--border-light, rgba(0,0,0,0.05))',
                  fontSize: 13,
                }}>
                  <div>{item.descripcion}</div>
                  {item.link && (
                    <Link to={item.link} className="btn btn-ghost btn-sm">
                      Ir <Icons.ChevronRight size={12} />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TabConfig({ config, onSaved }) {
  const settings   = config.filter(c => TIPOS_SETTING.has(c.tipo));
  const evaluables = config.filter(c => !TIPOS_SETTING.has(c.tipo));
  return (
    <>
      {settings.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: 'var(--text-muted)' }}>
            Settings globales
          </div>
          <div className="muted tiny" style={{ marginBottom: 8 }}>
            Valores de referencia que el frontend usa para advertir sobre posibles errores al cargar datos.
            No generan alertas en la pestaña "Activas".
          </div>
          {settings.map(c => (
            <ConfigRow key={c.tipo} cfg={c} onSaved={onSaved} />
          ))}
          <div style={{ height: 16 }} />
        </>
      )}
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: 'var(--text-muted)' }}>
        Alertas evaluadas
      </div>
      <div className="muted tiny" style={{ marginBottom: 8 }}>
        Activá/desactivá cada tipo y ajustá los umbrales. Los cambios pueden tardar hasta 60s en
        reflejarse en la pestaña "Activas" (cache).
      </div>
      {evaluables.map(c => (
        <ConfigRow key={c.tipo} cfg={c} onSaved={onSaved} />
      ))}
    </>
  );
}

function ConfigRow({ cfg, onSaved }) {
  const { toast } = useToast();
  const { reload: reloadTcRef } = useTcReferencia();
  const [activa, setActiva] = useState(cfg.activa);
  const [params, setParams] = useState({ ...(cfg.parametros || {}) });
  const [saving, setSaving] = useState(false);
  // Render solo las keys conocidas — evita mostrar internals como
  // `alerta_por_debajo` (boolean) que el user no necesita ver.
  const parametrosKeys = Object.keys(cfg.parametros || {}).filter(k => PARAMETROS_META[k]);

  function notifyChange() {
    onSaved?.();
    // Si lo que cambió es el TC de referencia, recargá el context para que
    // los warnings inline reflejen el cambio sin recargar la página.
    if (cfg.tipo === 'tc_referencia') reloadTcRef();
  }

  async function toggleActiva() {
    setSaving(true);
    try {
      await alertasApi.updateConfig(cfg.tipo, { activa: !activa });
      setActiva(!activa);
      notifyChange();
      toast.success(`${TITULOS[cfg.tipo] || cfg.tipo} ${!activa ? 'activada' : 'desactivada'}`);
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  }

  async function saveParams() {
    setSaving(true);
    try {
      // Coercer numéricos antes de mandar.
      const parsed = {};
      for (const k of parametrosKeys) {
        const meta = PARAMETROS_META[k];
        if (meta?.tipo === 'number') {
          parsed[k] = Number(params[k]);
        } else {
          parsed[k] = params[k];
        }
      }
      await alertasApi.updateConfig(cfg.tipo, { parametros: parsed });
      notifyChange();
      toast.success('Parámetros actualizados');
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="card card-tight" style={{ marginBottom: 10 }}>
      <div className="flex-between" style={{ marginBottom: parametrosKeys.length > 0 ? 8 : 0 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{TITULOS[cfg.tipo] || cfg.tipo}</div>
          <div className="muted tiny">{cfg.tipo}</div>
        </div>
        <label className="flex-row" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={activa} onChange={toggleActiva} disabled={saving}
                 style={{ accentColor: 'var(--accent)' }} />
          <span style={{ fontSize: 13 }}>{activa ? 'Activa' : 'Desactivada'}</span>
        </label>
      </div>
      {parametrosKeys.length > 0 && activa && (
        <div className="flex-row" style={{ gap: 12, alignItems: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {parametrosKeys.map(k => {
            const meta = PARAMETROS_META[k] || { label: k, tipo: 'text' };
            return (
              <div key={k} className="field" style={{ flex: '0 0 240px' }}>
                <label className="field-label">{meta.label}</label>
                <input
                  type={meta.tipo}
                  onKeyDown={meta.tipo === 'number' ? blockInvalidNumberKeys : undefined}
                  min={meta.min} max={meta.max}
                  className="input mono"
                  value={params[k] ?? ''}
                  onChange={e => setParams(p => ({ ...p, [k]: e.target.value }))}
                />
              </div>
            );
          })}
          <button className="btn btn-primary btn-sm" disabled={saving} onClick={saveParams}>
            {saving ? '…' : 'Guardar'}
          </button>
        </div>
      )}
    </div>
  );
}
