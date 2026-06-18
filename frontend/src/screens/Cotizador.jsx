import { useState, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import { fmt } from '../lib/format'; // Hygiene H2 auditoría 2026-06-06


// ─── Helpers ────────────────────────────────────────────────────────────────

// 2026-06-13: bug del cotizador detectado en prueba interna del PO.
//
// Antes los COEFS estaban como multiplicadores aditivos (1.11 para 1 cuota
// con 11% de comisión). Eso es matemáticamente INCORRECTO si querés que la
// tarjeta te liquide el contado limpio: la tarjeta descuenta el 11% sobre
// lo que el cliente paga, NO sobre el contado. Resultado con el código viejo:
//   - Cliente pagaba: contado × 1.11
//   - Tarjeta liquidaba: contado × 1.11 × 0.89 = contado × 0.9879
//   - Comercio perdía ~1.21% en cada venta con tarjeta (más en cuotas largas).
//
// Para que la tarjeta te liquide el contado neto, hay que pasarle el costo
// al cliente con la fórmula 1/(1−c), no 1+c. Verificación:
//   - 1 cuota (11%): factor = 1/0.89 = 1.1236 → cliente paga contado×1.1236
//   - Tarjeta liquida: 1.1236 × 0.89 = 1.0 → comercio recibe contado limpio ✅
//
// Expresamos los costos como COMISIONES (la comisión PURA que cobra cada
// método, no la suma final) y derivamos el COEFS automáticamente. Así el
// día que cambie la comisión real, se actualiza un solo lugar y el factor
// se recalcula.
const COMISIONES = {
  contado: 0,        // 0% — efectivo, sin recargo
  transf:  0.03,     // 3% — transferencia bancaria
  c1:      0.11,     // 11% — tarjeta de crédito 1 pago
  c3:      0.235,    // 23.5% — tarjeta 3 cuotas
  c6:      0.28,     // 28% — tarjeta 6 cuotas
};

// Factor por el que hay que MULTIPLICAR el precio contado para pasarle el
// costo de la comisión al cliente sin perder margen.
const factor = (c) => 1 / (1 - c);

// Coeficientes derivados. Cambiar siempre COMISIONES, nunca acá.
const COEFS = {
  contado: factor(COMISIONES.contado),   // 1.0
  transf:  factor(COMISIONES.transf),    // 1.0309…
  c1:      factor(COMISIONES.c1),        // 1.1236…
  c3:      factor(COMISIONES.c3),        // 1.3072…
  c6:      factor(COMISIONES.c6),        // 1.3889…
};

// Helper para mostrar el porcentaje EFECTIVO en los labels — el % real que
// el cliente paga arriba del contado, no la comisión cruda. Para 11% de
// comisión, el cliente paga 12.36% más que el contado, no 11%.
const pctEfectivo = (c) => ((factor(c) - 1) * 100).toFixed(c >= 0.1 ? 2 : 2);

// ─── Tab: Tarjetas de crédito ────────────────────────────────────────────────

function TabTarjetas() {
  const [tc, setTc]         = useState(1400);
  // Nombre por defecto como hint (el placeholder del input igual lo muestra),
  // pero precio en 0 para que el operador NO lo confunda con un valor real.
  // Antes el default era 1185 y se prestaba a errores cuando se olvidaban de
  // pisarlo (se cotizaba con un precio inventado).
  const [prods, setProds]   = useState([
    { id: 1, nom: 'iPhone 16 Pro 256GB Natural Titanium', vari: '', usd: 0 },
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
    txt += `\nNos encontrás en Google como "Tecny Tech | Reseller" con +2800 reseñas 5 estrellas.`;
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
                type="number" onKeyDown={blockInvalidNumberKeys}
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
                    type="number" onKeyDown={blockInvalidNumberKeys}
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
              <span className="lbl">Transferencia (+{pctEfectivo(COMISIONES.transf)}%)</span>
              <span className="val mono pos" style={{ fontWeight: 600 }}>${fmt(transf)}</span>
            </div>
            <div className="quote-line" style={{ marginTop: 6 }}>
              <span className="lbl">💳 1 cuota (+{pctEfectivo(COMISIONES.c1)}%)</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                ${fmt(c1)}
              </span>
            </div>
            <div className="quote-line">
              <span className="lbl">💳 3 cuotas (+{pctEfectivo(COMISIONES.c3)}%)</span>
              <span className="val mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                ${fmt(c3)}{' '}
                <small className="muted">· ${fmt(Math.round(c3 / 3))}/c</small>
              </span>
            </div>
            <div className="quote-line">
              <span className="lbl">💳 6 cuotas (+{pctEfectivo(COMISIONES.c6)}%)</span>
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
// 2026-06-15: refactor para soportar lista de productos (espejo del tab Tarjetas).
// Antes era 1 sólo "Monto USD a cotizar" sin nombre — ahora cotizás N items con
// nombre + precio USD c/u, y el mensaje al cliente sale enumerado.

function TabUsd() {
  const [tc, setTc]         = useState(1400);
  const [prods, setProds]   = useState([
    { id: 1, nom: '', usd: 0 },
  ]);
  const [optEf, setOptEf]   = useState(true);
  const [optTars, setOptTars] = useState(false);
  const [optTusd, setOptTusd] = useState(false);
  const [copiado, setCopiado] = useState(false);

  const addProd = () =>
    setProds([...prods, { id: Date.now(), nom: '', usd: 0 }]);
  const rmProd = (id) =>
    prods.length > 1 && setProds(prods.filter(p => p.id !== id));
  const setProd = (id, field, val) =>
    setProds(prods.map(p => p.id === id ? { ...p, [field]: val } : p));

  const calculo = useMemo(() => {
    const lines = prods.map(p => {
      const u = parseFloat(p.usd) || 0;
      return {
        p,
        usdRaw: u,
        // 2026-06-13: COEFS.transf (1/(1-comisión)) para que la transferencia
        // liquide el contado limpio.
        ef:   Math.round(u * tc),
        tars: Math.round(u * tc * COEFS.transf),
        // 2026-06-15: redondear a entero (consistente con ef/tars en ARS).
        // En USD también cotizamos en montos redondos (USD 928 en vez de 927.84).
        tusd: Math.round(u * COEFS.transf),
      };
    });
    const tots = lines.reduce(
      (a, l) => ({
        ef:     a.ef     + l.ef,
        tars:   a.tars   + l.tars,
        tusd:   a.tusd   + l.tusd,
        usdRaw: a.usdRaw + l.usdRaw,
      }),
      { ef: 0, tars: 0, tusd: 0, usdRaw: 0 }
    );
    return { lines, tots };
  }, [prods, tc]);

  const tieneMonto = calculo.tots.usdRaw > 0;

  const copyUsd = () => {
    if (!tieneMonto) return;
    let m = `Te comparto la cotización que me solicitaste:\n\nDe acuerdo al último tipo de cambio (TC $${fmt(tc)}):\n`;
    calculo.lines.forEach(({ p, ef, tars, tusd, usdRaw }) => {
      if (usdRaw <= 0) return;  // omitimos productos sin precio cargado
      m += `\n- ${p.nom || 'Producto'} (USD ${fmt(p.usd)})\n`;
      if (optEf)   m += `  Efectivo / Contado: $${fmt(ef)}\n`;
      if (optTars) m += `  Transferencia ARS: $${fmt(tars)}\n`;
      if (optTusd) m += `  Transferencia USD: u$s ${fmt(tusd)}\n`;
    });
    // Totales solo si hay más de un producto con precio.
    const validas = calculo.lines.filter(l => l.usdRaw > 0);
    if (validas.length > 1) {
      m += `\n━━━━━━━━━━━━━━━\n`;
      if (optEf)   m += `TOTAL Efectivo / Contado: $${fmt(calculo.tots.ef)}\n`;
      if (optTars) m += `TOTAL Transferencia ARS: $${fmt(calculo.tots.tars)}\n`;
      if (optTusd) m += `TOTAL Transferencia USD: u$s ${fmt(calculo.tots.tusd)}\n`;
    }
    m += `\nNos encontrás en Google como "Tecny Tech | Reseller" con +2800 reseñas 5 estrellas.`;
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
      label: `Transferencia ARS (+${pctEfectivo(COMISIONES.transf)}%)`,
      sub: 'Cobro en pesos con recargo',
    },
    {
      key: 'tusd',
      val: optTusd,
      set: setOptTusd,
      label: `Transferencia USD (+${pctEfectivo(COMISIONES.transf)}%)`,
      sub: 'Cobro en dólares con recargo',
    },
  ];

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
                type="number" onKeyDown={blockInvalidNumberKeys}
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

        {/* Product rows — mismo shape que TabTarjetas para consistencia visual. */}
        <div className="stack" style={{ gap: 10, marginBottom: 16 }}>
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
                    type="number" onKeyDown={blockInvalidNumberKeys}
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

        {/* Formas de pago — mismo widget que antes, ahora abajo de la lista. */}
        <div className="card card-tight">
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
            disabled={!tieneMonto}
          >
            <span className="ico">
              {copiado ? <Icons.Check size={13} /> : <Icons.Share size={13} />}
            </span>
            {copiado ? 'Copiado' : 'Copiar'}
          </button>
        </div>

        {!tieneMonto ? (
          <div
            className="muted tiny"
            style={{ padding: '24px 0', textAlign: 'center' }}
          >
            Ingresá un monto USD para ver el cálculo.
          </div>
        ) : (
          <>
            {/* Líneas por producto */}
            {calculo.lines.filter(l => l.usdRaw > 0).map(({ p, ef, tars, tusd }, i, arr) => (
              <div key={p.id} style={{
                paddingBottom: 12,
                marginBottom: 12,
                borderBottom: i < arr.length - 1 ? '1px solid var(--hairline)' : 0,
              }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>
                  {p.nom || 'Producto'}{' '}
                  <span className="muted tiny mono" style={{ fontWeight: 500 }}>
                    · USD {fmt(p.usd)}
                  </span>
                </div>
                {optEf && (
                  <div className="quote-line">
                    <span className="lbl">Efectivo / Contado</span>
                    <span className="val mono pos" style={{ fontWeight: 700 }}>${fmt(ef)}</span>
                  </div>
                )}
                {optTars && (
                  <div className="quote-line">
                    <span className="lbl">Transferencia ARS (+{pctEfectivo(COMISIONES.transf)}%)</span>
                    <span className="val mono pos" style={{ fontWeight: 700 }}>${fmt(tars)}</span>
                  </div>
                )}
                {optTusd && (
                  <div className="quote-line">
                    <span className="lbl">Transferencia USD (+{pctEfectivo(COMISIONES.transf)}%)</span>
                    <span className="val mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                      USD {fmt(tusd)}
                    </span>
                  </div>
                )}
              </div>
            ))}

            {/* Totales si hay más de 1 producto con precio. */}
            {calculo.lines.filter(l => l.usdRaw > 0).length > 1 && (
              <>
                {optEf && (
                  <div className="quote-line">
                    <span className="lbl">Total Efectivo / Contado</span>
                    <span className="val mono pos" style={{ fontWeight: 700 }}>${fmt(calculo.tots.ef)}</span>
                  </div>
                )}
                {optTars && (
                  <div className="quote-line">
                    <span className="lbl">Total Transferencia ARS</span>
                    <span className="val mono pos" style={{ fontWeight: 700 }}>${fmt(calculo.tots.tars)}</span>
                  </div>
                )}
                {optTusd && (
                  <div className="quote-line">
                    <span className="lbl">Total Transferencia USD</span>
                    <span className="val mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                      USD {fmt(calculo.tots.tusd)}
                    </span>
                  </div>
                )}
              </>
            )}

            <hr className="h-rule" />

            <div className="muted tiny mono" style={{ marginBottom: 8 }}>
              Total USD {fmt(calculo.tots.usdRaw)} × TC ${fmt(tc)}
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
