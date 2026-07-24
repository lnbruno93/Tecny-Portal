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

// CSS classes por severidad — evita construir var(--*) inline (CSP).
// Cada clase setea `--sev-color` (custom prop) que .u-grupo-alerta-* consume
// para el borderLeft del card + el bg del badge. Ver styles.css Sprint 98.
const SEVERIDAD_CLASS = {
  critica: 'u-sev-critica',
  alta:    'u-sev-alta',
  media:   'u-sev-media',
  baja:    'u-sev-baja',
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
      <div className="flex-row u-alertas-tabs-row">
        <button className={'btn ' + (subtab === 'activas' ? 'btn-primary' : '')}
                onClick={() => setSubtab('activas')}>
          Activas {activas?.total_alertas > 0 && (
            <span className="badge u-badge-neg-white-ml6">
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
      <div className="card card-tight u-alertas-ok-card">
        <Icons.Check size={32} />
        <div className="u-alertas-ok-title">Todo bajo control</div>
        <div className="muted tiny u-mt-4">No hay alertas activas en este momento.</div>
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
        <div className="muted tiny u-mt-12">
          ✓ Sin alertas en: {grupos.filter(g => g.count === 0).map(g => TITULOS[g.tipo] || g.tipo).join(', ')}
        </div>
      )}
    </>
  );
}

function GrupoAlerta({ grupo }) {
  const [expanded, setExpanded] = useState(true);
  // `sevClass` setea --sev-color en el card container; el borderLeftColor y el
  // badge bg consumen esa var via clases descendant en styles.css. Fallback a
  // 'u-sev-media' (var(--accent)) si el backend manda una severidad no mapeada.
  const sevClass = SEVERIDAD_CLASS[grupo.severidad] || 'u-sev-media';
  return (
    <div className={`card card-tight u-grupo-alerta-card ${sevClass}`}>
      <div className="flex-between u-cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div>
          <span className="u-fs-16-fw-600">{grupo.titulo}</span>
          <span className="badge u-badge-count-ml-8 u-grupo-alerta-count">{grupo.count}</span>
        </div>
        <button className="icon-btn">
          {expanded ? <Icons.ChevronUp size={16} /> : <Icons.ChevronDown size={16} />}
        </button>
      </div>
      {expanded && (
        <div className="u-mt-8">
          {grupo.error ? (
            <div className="empty tiny u-color-neg">Error: {grupo.error}</div>
          ) : (
            <div className="u-border-top-only">
              {grupo.items.map(item => (
                <div key={item.id} className="flex-between u-alertas-item-row">
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
          <div className="u-fw-600-fs-13-mb-6-muted">
            Settings globales
          </div>
          <div className="muted tiny u-mb-8">
            Valores de referencia que el frontend usa para advertir sobre posibles errores al cargar datos.
            No generan alertas en la pestaña "Activas".
          </div>
          {settings.map(c => (
            <ConfigRow key={c.tipo} cfg={c} onSaved={onSaved} />
          ))}
          <div className="u-h-16-spacer" />
        </>
      )}
      <div className="u-fw-600-fs-13-mb-6-muted">
        Alertas evaluadas
      </div>
      <div className="muted tiny u-mb-8">
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
    <div className="card card-tight u-mb-10">
      <div className={`flex-between ${parametrosKeys.length > 0 ? 'u-mb-8' : ''}`}>
        <div>
          <div className="u-fw-600">{TITULOS[cfg.tipo] || cfg.tipo}</div>
          <div className="muted tiny">{cfg.tipo}</div>
        </div>
        <label className="flex-row u-label-checkbox-pointer">
          <input type="checkbox" checked={activa} onChange={toggleActiva} disabled={saving}
                 className="u-accent-color" />
          <span className="u-fs-13">{activa ? 'Activa' : 'Desactivada'}</span>
        </label>
      </div>
      {parametrosKeys.length > 0 && activa && (
        <div className="flex-row u-alertas-params-row">
          {parametrosKeys.map(k => {
            const meta = PARAMETROS_META[k] || { label: k, tipo: 'text' };
            return (
              <div key={k} className="field u-flex-0-0-240">
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
