import { useState, useMemo } from 'react';
import { Icons } from '../components/Icons';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n) {
  const v = Math.abs(Number(n));
  if (!v && v !== 0) return '0';
  return v.toLocaleString('es-AR');
}

// Coeficientes de financiación
const COEFS = {
  contado: 1.0,
  transf:  1.03,
  c1:      1.11,
  c3:      1.235,
  c6:      1.28,
};

// ─── Tab: Tarjetas de crédito ────────────────────────────────────────────────

function TabTarjetas() {
  const [tc, setTc]         = useState(1200);
  const [prods, setProds]   = useState([
    { id: 1, nom: 'iPhone 16 Pro 256GB Natural Titanium', vari: '', usd: 1185 },
  ]);
  const [copiado, setCopiado] = useState(false);

  const addProd = () =>
    setProds([...prods, { id: Date.now(), nom: '', vari: '', usd: 0 }]);

  const rmProd = (id) =>
    prods.length > 1 && setProds(prods.filter(p => p.id !== id));

  const setProd = (id, field, val) =>
    setProds(prods.map(p => p.id === id ? { ...p, [field]: val } : p));

  const calculo = useMemo(() => {
    const lines = prods.map(p => {
      const base = (parseFloat(p.usd) || 0) * tc;
      return {
        p,
        contado: Math.round(base),
        transf:  Math.round(base * COEFS.transf),
        c1:      Math.round(base * COEFS.c1),
        c3:      Math.round(base * COEFS.c3),
        c6:      Math.round(base * COEFS.c6),
      };
    });
    const tots = lines.reduce(
      (a, l) => ({
        contado: a.contado + l.contado,
        transf:  a.transf  + l.transf,
        c1: a.c1 + l.c1,
        c3: a.c3 + l.c3,
        c6: a.c6 + l.c6,
      }),
      { contado: 0, transf: 0, c1: 0, c3: 0, c6: 0 }
    );
    return { lines, tots };
  }, [prods, tc]);

  const copyText = () => {
    let txt = 'Te comparto la cotización que me solicitaste:\n';
    calculo.lines.forEach(({ p, contado, transf, c1, c3, c6 }) => {
      txt += `\n- ${p.nom || 'Producto'}${p.vari ? ' ' + p.vari : ''}\n`;
      txt += `- Precio: USD ${fmt(p.usd)} | TC $${fmt(tc)}\n\n`;
      txt += `- Contado en pesos ARS: $${fmt(contado)}\n`;
      txt += `- Transferencia ARS: $${fmt(transf)}\n\n`;
      txt += `- 💳 1 cuota: $${fmt(c1)}\n`;
      txt += `- 💳 3 cuotas: $${fmt(c3)} ($${fmt(Math.round(c3 / 3))}/cuota)\n`;
      txt += `- 💳 6 cuotas: $${fmt(c6)} ($${fmt(Math.round(c6 / 6))}/cuota)\n`;
    });
    if (calculo.lines.length > 1) {
      txt += `\n━━━━━━━━━━━━━━━\n`;
      txt += `TOTAL CONTADO: $${fmt(calculo.tots.contado)}\n`;
      txt += `TOTAL TRANSFERENCIA: $${fmt(calculo.tots.transf)}\n\n`;
      txt += `💳 TOTAL 1 cuota: $${fmt(calculo.tots.c1)}\n`;
      txt += `💳 TOTAL 3 cuotas: $${fmt(calculo.tots.c3)}\n`;
      txt += `💳 TOTAL 6 cuotas: $${fmt(calculo.tots.c6)}\n`;
    }
    txt += `\nNos encontrás en Google como "iPro Tech | Reseller" con +2800 reseñas 5 estrellas.`;
    navigator.clipboard?.writeText(txt);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1800);
  };

  return (
    <div className="quote-grid">
      {/* ── Left: inputs ── */}
      <div>
        {/* TC card */}
        <div className="card card-tight" style={{ marginBottom: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label">Tipo de cambio (USD → ARS)</div>
            <div className="input-group" style={{ maxWidth: 240 }}>
              <span className="addon addon-l" style={{ color: 'var(--accent)' }}>$</span>
              <input
                type="number"
                className="input mono"
                value={tc}
                onChange={e => setTc(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>

        {/* Products header */}
        <div className="flex-between" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Productos a cotizar</div>
          <button className="btn btn-sm" onClick={addProd}>
            <span className="ico"><Icons.Plus size={13} /></span>
            Agregar producto
          </button>
        </div>

        {/* Product rows */}
        <div className="stack" style={{ gap: 10 }}>
          {prods.map((p, i) => (
            <div key={p.id} className="card card-tight">
              <div className="flex-between" style={{ marginBottom: 10 }}>
                <div className="muted tiny" style={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Producto {i + 1}
                </div>
                {prods.length > 1 && (
                  <button className="icon-btn" onClick={() => rmProd(p.id)}>
                    <Icons.X size={14} />
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10 }}>
                <div className="field">
                  <div className="field-label">Producto &amp; Detalle</div>
                  <input
                    className="input"
                    placeholder="ej. iPhone 16 Pro 256GB Natural Titanium"
                    value={p.nom}
                    onChange={e => setProd(p.id, 'nom', e.target.value)}
                  />
                </div>
                <div className="field">
                  <div className="field-label">Precio USD</div>
                  <input
                    type="number"
                    className="input mono"
                    placeholder="0"
                    value={p.usd}
                    onChange={e => setProd(p.id, 'usd', e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right: resultado sticky ── */}
      <div className="quote-sticky">
        <div className="flex-between" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Resultado</div>
          <button className="btn btn-sm btn-primary" onClick={copyText}>
            <span className="ico">
              {copiado ? <Icons.Check size={13} /> : <Icons.Share size={13} />}
            </span>
            {copiado ? 'Copiado' : 'Copiar texto'}
          </button>
        </div>

        {calculo.lines.map(({ p, contado, transf, c1, c3, c6 }, i) => (
          <div
            key={p.id}
            style={{
              paddingBottom: 14,
              marginBottom: 14,
              borderBottom: i < calculo.lines.length - 1 ? '1px solid var(--hairline)' : 0,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>
              {p.nom || 'Producto'}{' '}
              {p.vari && (
                <span className="muted" style={{ fontWeight: 500 }}>{p.vari}</span>
              )}
            </div>
            <div className="quote-line">
              <span className="lbl">Contado</span>
              <span className="val mono pos" style={{ fontWeight: 600 }}>${fmt(contado)}</span>
            </div>
            <div className="quote-line">
              <span className="lbl">Transferencia (+3%)</span>
              <span className="val mono pos" style={{ fontWeight: 600 }}>${fmt(transf)}</span>
            </div>
            <div className="quote-line" style={{ marginTop: 6 }}>
              <span className="lbl">💳 1 cuota (+11%)</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                ${fmt(c1)}
              </span>
            </div>
            <div className="quote-line">
              <span className="lbl">💳 3 cuotas (+23.5%)</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                ${fmt(c3)}{' '}
                <small className="muted">· ${fmt(Math.round(c3 / 3))}/c</small>
              </span>
            </div>
            <div className="quote-line">
              <span className="lbl">💳 6 cuotas (+28%)</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                ${fmt(c6)}{' '}
                <small className="muted">· ${fmt(Math.round(c6 / 6))}/c</small>
              </span>
            </div>
          </div>
        ))}

        {calculo.lines.length > 1 && (
          <>
            <div className="quote-total">
              <span className="lbl muted tiny" style={{ alignSelf: 'flex-end' }}>Total contado</span>
              <span className="val mono pos">${fmt(calculo.tots.contado)}</span>
            </div>
            <div className="quote-line">
              <span className="lbl">Total transferencia</span>
              <span className="val mono pos" style={{ fontWeight: 600 }}>${fmt(calculo.tots.transf)}</span>
            </div>
            <div className="quote-line" style={{ marginTop: 4 }}>
              <span className="lbl">💳 Total 1 cuota</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>${fmt(calculo.tots.c1)}</span>
            </div>
            <div className="quote-line">
              <span className="lbl">💳 Total 3 cuotas</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>${fmt(calculo.tots.c3)}</span>
            </div>
            <div className="quote-line">
              <span className="lbl">💳 Total 6 cuotas</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>${fmt(calculo.tots.c6)}</span>
            </div>
          </>
        )}

        {/* USD reference */}
        <div
          className="muted tiny mono"
          style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}
        >
          TC referencia: ${fmt(tc)} / USD
        </div>
      </div>
    </div>
  );
}

// ─── Tab: USD → ARS ─────────────────────────────────────────────────────────

function TabUsd() {
  const [tc, setTc]         = useState(1200);
  const [usdIn, setUsdIn]   = useState('');
  const [optEf, setOptEf]   = useState(true);
  const [optTars, setOptTars] = useState(false);
  const [optTusd, setOptTusd] = useState(false);
  const [copiado, setCopiado] = useState(false);

  const usdCalc = useMemo(() => {
    const u = parseFloat(usdIn) || 0;
    return {
      ef:   Math.round(u * tc),
      tars: Math.round(u * tc * 1.03),
      tusd: (u * 1.03).toFixed(2),
    };
  }, [usdIn, tc]);

  const copyUsd = () => {
    const u = parseFloat(usdIn) || 0;
    if (!u) return;
    let m = `Te comparto la cotización que me solicitaste:\n\nDe acuerdo al último tipo de cambio (TC $${fmt(tc)}):\n\n`;
    if (optEf)   m += `- Efectivo / Contado: $${fmt(usdCalc.ef)}\n`;
    if (optTars) m += `- Transferencia ARS: $${fmt(usdCalc.tars)}\n`;
    if (optTusd) m += `- Transferencia USD: u$s ${usdCalc.tusd}\n`;
    m += `\nNos encontrás en Google como "iPro Tech | Reseller" con +2800 reseñas 5 estrellas.`;
    navigator.clipboard?.writeText(m);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1800);
  };

  const opciones = [
    {
      key: 'ef',
      val: optEf,
      set: setOptEf,
      label: 'Efectivo / Contado',
      sub: 'Cobro en pesos al TC del día',
    },
    {
      key: 'tars',
      val: optTars,
      set: setOptTars,
      label: 'Transferencia ARS (+3%)',
      sub: 'Cobro en pesos con recargo',
    },
    {
      key: 'tusd',
      val: optTusd,
      set: setOptTusd,
      label: 'Transferencia USD (+3%)',
      sub: 'Cobro en dólares con recargo',
    },
  ];

  return (
    <div className="quote-grid">
      {/* ── Left: inputs ── */}
      <div>
        <div className="card card-tight">
          <div className="row" style={{ marginBottom: 18 }}>
            <div className="field" style={{ flex: 1 }}>
              <div className="field-label">Tipo de cambio (USD → ARS)</div>
              <div className="input-group">
                <span className="addon addon-l" style={{ color: 'var(--accent)' }}>$</span>
                <input
                  type="number"
                  className="input mono"
                  value={tc}
                  onChange={e => setTc(parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <div className="field-label">Monto USD a cotizar</div>
              <div className="input-group">
                <span className="addon addon-l" style={{ color: 'var(--accent)' }}>USD</span>
                <input
                  type="number"
                  className="input mono"
                  placeholder="0"
                  value={usdIn}
                  onChange={e => setUsdIn(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="field-label" style={{ marginBottom: 10 }}>
            Formas de pago a incluir en el mensaje
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {opciones.map(o => (
              <label
                key={o.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 14px',
                  background: o.val ? 'var(--accent-soft)' : 'var(--surface-2)',
                  border: '1px solid ' + (o.val ? 'var(--accent)' : 'var(--border)'),
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all .12s',
                }}
              >
                <input
                  type="checkbox"
                  checked={o.val}
                  onChange={e => o.set(e.target.checked)}
                  style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.label}</div>
                  <div className="muted tiny" style={{ marginTop: 2 }}>{o.sub}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right: resultado sticky ── */}
      <div className="quote-sticky">
        <div className="flex-between" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Resumen para el cliente</div>
          <button
            className="btn btn-sm btn-primary"
            onClick={copyUsd}
            disabled={!usdIn || parseFloat(usdIn) <= 0}
          >
            <span className="ico">
              {copiado ? <Icons.Check size={13} /> : <Icons.Share size={13} />}
            </span>
            {copiado ? 'Copiado' : 'Copiar'}
          </button>
        </div>

        {!usdIn || parseFloat(usdIn) <= 0 ? (
          <div
            className="muted tiny"
            style={{ padding: '24px 0', textAlign: 'center' }}
          >
            Ingresá un monto USD para ver el cálculo.
          </div>
        ) : (
          <>
            {optEf && (
              <div className="quote-line">
                <span className="lbl">Efectivo / Contado</span>
                <span className="val mono pos" style={{ fontWeight: 700 }}>${fmt(usdCalc.ef)}</span>
              </div>
            )}
            {optTars && (
              <div className="quote-line">
                <span className="lbl">Transferencia ARS (+3%)</span>
                <span className="val mono pos" style={{ fontWeight: 700 }}>${fmt(usdCalc.tars)}</span>
              </div>
            )}
            {optTusd && (
              <div className="quote-line">
                <span className="lbl">Transferencia USD (+3%)</span>
                <span
                  className="val mono"
                  style={{ fontWeight: 700, color: 'var(--accent)' }}
                >
                  USD {usdCalc.tusd}
                </span>
              </div>
            )}

            <hr className="h-rule" />

            <div className="muted tiny mono" style={{ marginBottom: 8 }}>
              USD {fmt(usdIn)} × TC ${fmt(tc)}
            </div>
            <div
              className="muted tiny"
              style={{
                paddingTop: 8,
                borderTop: '1px solid var(--hairline)',
                lineHeight: 1.6,
              }}
            >
              El texto se copia con saludo + cotización + cierre comercial.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function Cotizador() {
  const [tab, setTab] = useState('tarjetas');

  return (
    <div>
      {/* Page header */}
      <div className="page-hd" style={{ marginBottom: 'var(--gap)' }}>
        <div>
          <h1 className="page-title">Cotizador</h1>
          <div className="page-sub">Cálculo de precios para clientes · client-side, no persiste</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={'btn' + (tab === 'tarjetas' ? ' btn-primary' : '')}
            onClick={() => setTab('tarjetas')}
          >
            Tarjetas de crédito
          </button>
          <button
            className={'btn' + (tab === 'usd' ? ' btn-primary' : '')}
            onClick={() => setTab('usd')}
          >
            USD → ARS
          </button>
        </div>
      </div>

      {tab === 'tarjetas' && <TabTarjetas />}
      {tab === 'usd'      && <TabUsd />}
    </div>
  );
}
