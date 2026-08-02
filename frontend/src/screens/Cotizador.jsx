import { useState, useMemo, useEffect } from 'react';
import { Icons } from '../components/Icons';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import { fmt } from '../lib/format'; // Hygiene H2 auditoría 2026-06-06
import { tenantProfile, config as configApi, cajas as cajasApi, cotizador as cotizadorApi } from '../lib/api'; // 2026-06-22 + #445 lastTc + task #284 comisiones + task #286 endpoint scoped
import { useAuth } from '../contexts/AuthContext'; // 2026-06-22 tab Configuración (Mi negocio)
import { isTenantAdmin } from '../lib/userHasCap'; // 2026-06-25 Bug #1 — fix owner edit
import BusinessProfileSection from '../components/BusinessProfileSection'; // idem
// 2026-06-29 Multi-país F5: parametrizar labels + símbolo según país del tenant.
// AR → "ARS" + "$"; UY → "UYU" + "$U". Sin componente separado — la mayoría
// del flow es idéntico (cuotas, comisiones, mensaje al cliente), solo cambian
// strings. Ver docs/design/multi-pais-uyu.md sección 5.4.
import { useMonedasTenant } from '../lib/useMonedasTenant';
import { getStoredTc, saveStoredTc, subscribeTcChange } from '../lib/cotizadorTc';

// Símbolo monetario del país. Espejo de la convención usada en lib/format.ts:
// UYU se escribe con "$U" para distinguir de ARS "$" cuando el formato no
// trae el código (texto generado para WhatsApp, labels cortos).
const symbolFor = (monedaLocal) => (monedaLocal === 'UYU' ? '$U' : '$');

// 2026-06-22 fix: arma la oración "Nos encontrás en Google como..." dinámicamente
// según el perfil del tenant. Si el tenant NO tiene ficha de Google activada,
// devuelve string vacío (no se incluye la oración). Si la tiene pero faltan
// datos (caso defensivo, no debería pasar porque el backend valida), también
// se omite para no generar texto roto.
//
// Reglas del template:
//   · enabled=false → no aparece nada de Google.
//   · enabled=true + name + count>0 → "Nos encontrás en Google como "<name>"
//     con +N reseñas 5 estrellas."
//   · enabled=true + name pero count=0/null → "Nos encontrás en Google como
//     "<name>"." (sin la parte de reseñas — no inventamos números).
function buildGoogleLine(profile) {
  if (!profile?.google_business_enabled) return '';
  const name = (profile.google_business_name || '').trim();
  if (!name) return '';
  const count = Number(profile.google_reviews_count);
  const reseñas = Number.isInteger(count) && count > 0
    ? ` con +${count} reseñas 5 estrellas`
    : '';
  return `Nos encontrás en Google como "${name}"${reseñas}.`;
}


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
// 2026-08-02 (task #284): las comisiones ya NO son hardcoded — se leen de
// la config del tenant (`configApi.get()` para financiera + `cajasApi.
// listCajas()` para las tarjetas con `es_tarjeta=true`). Antes, todos los
// tenants Tecny cotizaban con los % del PO (Lucas) sin importar lo que
// configuraran en Config → General. Bug latente hasta la migración de
// esta sección a Cotizador > Tarjetas de crédito.
//
// Factor por el que hay que MULTIPLICAR el precio contado para pasarle el
// costo de la comisión al cliente sin perder margen. Sigue igual — es matemática.
const factor = (c) => 1 / (1 - c);

// Helper para mostrar el porcentaje EFECTIVO en los labels — el % real que
// el cliente paga arriba del contado, no la comisión cruda. Para 11% de
// comisión, el cliente paga 12.36% más que el contado, no 11%.
const pctEfectivo = (c) => ((factor(c) - 1) * 100).toFixed(2);

// ─── Hook: comisiones del tenant ─────────────────────────────────────────────
// 2026-08-02 (task #284 + #286): centraliza el fetch + save de las comisiones
// que afectan el cotizador (transferencia + tarjetas de crédito).
//
// Fuentes:
//   · Transferencia (Financiera) = `config.pct_financiera` (tabla `config`)
//   · Tarjetas de crédito        = `metodos_pago` con `es_tarjeta=true`,
//                                   ordenadas por `orden ASC, nombre ASC`.
//                                   Cada una tiene `comision_pct`.
//
// Antes esto vivía en Config → General, pero era un lugar poco natural para
// el operador (el Cotizador es donde ve el impacto de cada %). Se movió al
// Cotizador — Config solo mantiene la privacidad de ventas (task #280).
//
// LECTURA (task #286): usa `cotizadorApi.comisiones()` — endpoint dedicado
// del feature Cotizador gated con `cotizador.trabajar` (cap que tiene el
// vendedor). Antes leíamos de configApi.get() + cajasApi.listCajas(), pero
// esos endpoints están gated con caps que el vendedor NO tiene → 403
// silencioso → el resultado del Cotizador salía SIN líneas TC. Regresión
// cazada por Lucas post-deploy #979. Ver backend/src/routes/cotizador.js
// para el rationale + payload shape.
//
// ESCRITURA (save): sigue usando configApi.update() + cajasApi.updateCaja()
// — endpoints existentes con audit trail y las guardas de admin ya en su
// lugar. El `save` sólo lo llama el ComisionesPanel del tab Configuración
// y ese panel solo se muestra a admins (isTenantAdmin). Un vendedor nunca
// llega a llamar el save (renderizado hidden).
//
// El save es "batch por diff": solo se pega al endpoint para lo que cambió,
// para no invalidar innecesariamente el server ni gastar audit trail vacío.
function useComisionesTenant() {
  const [pctFinanciera, setPctFinanciera] = useState(3);
  const [tarjetas, setTarjetas] = useState([]); // [{id, nombre, pct, _original}]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedTick, setSavedTick] = useState(0); // bump para forzar re-render sin dirty

  useEffect(() => {
    let alive = true;
    cotizadorApi.comisiones()
      .then((data) => {
        if (!alive) return;
        setPctFinanciera(Number(data?.pctFinanciera ?? 3));
        // El backend ya devuelve las tarjetas filtradas (es_tarjeta=true) y
        // ordenadas (orden ASC, nombre ASC). Aquí sólo mapeamos al shape
        // interno del hook (nombre `pct` + `_original` para el diff-save).
        const tcs = (data?.tarjetas || []).map(t => ({
          id: t.id,
          nombre: t.nombre,
          pct: Number(t.comision_pct ?? 0),
          _original: Number(t.comision_pct ?? 0),
        }));
        setTarjetas(tcs);
      })
      .catch(e => { if (alive) setError(e.message || 'No se pudieron cargar las comisiones.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [savedTick]);

  const setTarjetaPct = (id, val) => {
    setTarjetas(ts => ts.map(t => t.id === id ? { ...t, pct: val } : t));
  };

  async function save(newPctFin) {
    // Diff: solo pegamos lo que cambió. Si nada cambió, no hacemos nada
    // (dirty-check lo maneja el caller).
    const updates = [];
    if (Number(newPctFin) !== Number(pctFinanciera)) {
      updates.push(configApi.update({ pct_financiera: Number(newPctFin) }));
    }
    tarjetas.forEach(t => {
      if (Number(t.pct) !== Number(t._original)) {
        updates.push(cajasApi.updateCaja(t.id, { comision_pct: Number(t.pct) }));
      }
    });
    if (updates.length === 0) return;
    await Promise.all(updates);
    // Re-fetch para sincronizar _original con lo persistido.
    setSavedTick(t => t + 1);
  }

  return {
    pctFinanciera, setPctFinanciera,
    tarjetas, setTarjetaPct,
    loading, error, save,
  };
}

// ─── Panel: edición de comisiones (tab Configuración) ────────────────────────
// 2026-08-02 (task #285): antes vivía dentro de TabTarjetas, pero era ajeno
// al contenido de ese tab (edición de config vs cotización real). Movido al
// tab "Configuración" del Cotizador junto con BusinessProfileSection.
//
// TabTarjetas y TabUsd siguen usando useComisionesTenant() para LEER las %
// que aplican al cálculo — el fetch corre en cada mount, así que si el user
// edita acá y vuelve al tab de cotización, se refleja automáticamente.
// Ver DECISIÓN durable 66 (memory: aprovechar fetch fresh en re-mount).
function ComisionesPanel() {
  const {
    pctFinanciera, tarjetas, setTarjetaPct,
    loading, error, save,
  } = useComisionesTenant();
  const [pctFinInput, setPctFinInput] = useState('');
  useEffect(() => { setPctFinInput(String(pctFinanciera)); }, [pctFinanciera]);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  const dirty =
    parseFloat(pctFinInput) !== Number(pctFinanciera) ||
    tarjetas.some(t => Number(t.pct) !== Number(t._original));

  async function handleSave() {
    const vFin = parseFloat(pctFinInput);
    if (isNaN(vFin) || vFin < 0 || vFin > 100) {
      setSaveErr('Financiera: valor inválido (0–100).'); return;
    }
    for (const t of tarjetas) {
      const v = Number(t.pct);
      if (isNaN(v) || v < 0 || v > 100) {
        setSaveErr(`${t.nombre}: valor inválido (0–100).`); return;
      }
    }
    setSaving(true); setSaveErr(''); setSavedOk(false);
    try {
      await save(vFin);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2500);
    } catch (e) {
      setSaveErr(e.message || 'No se pudieron guardar las comisiones.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  // Simulación Financiera para preview (base fija 1M ARS).
  const simBase = 1_000_000;
  const simPctFin = parseFloat(pctFinInput) || 0;
  const simRet = simBase * (simPctFin / 100);
  const simNeto = simBase - simRet;

  return (
    <div className="card u-mb-14">
      <div className="card-hd">
        <div className="u-fw-600-fs-15">Comisiones de métodos de pago</div>
        <div className="muted tiny u-mt-2">
          Se aplican al cotizar (y también al cobrar con cada método en Ventas).
        </div>
      </div>
      <div className="u-p-0-0-16">
        {/* Financiera */}
        <div className="field u-mb-16">
          <div className="field-label">Transferencias <span className="muted">(Financiera)</span></div>
          <div className="u-flex-center-gap-10">
            <div className="input-group u-mw-160">
              <input
                type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                step="0.1" min="0" max="100"
                className="input mono u-fw-700-fs-16"
                data-testid="cotizador-pct-financiera"
                value={pctFinInput}
                onChange={e => { setPctFinInput(e.target.value); setSaveErr(''); setSavedOk(false); }}
              />
              <span className="addon u-color-accent-fw-700">%</span>
            </div>
            <span className="muted tiny">
              Guardado: <span className="mono u-fw-700">{Number(pctFinanciera).toFixed(1)}%</span>
            </span>
          </div>
        </div>

        {/* Tarjetas */}
        <div className="u-mb-16">
          <div className="field-label u-mb-8">Tarjetas de crédito</div>
          {tarjetas.length === 0 ? (
            <div className="muted tiny u-p-6-0">
              No hay tarjetas configuradas. Creá una en Cajas → Config marcándola como tarjeta.
            </div>
          ) : (
            <div className="stack u-gap-8">
              {tarjetas.map(t => {
                const tDirty = Number(t.pct) !== Number(t._original);
                return (
                  <div key={t.id} className="u-config-tarjeta-row">
                    <div className="u-fs-13-fw-600">{t.nombre}</div>
                    <div className="input-group">
                      <input
                        type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                        step="0.1" min="0" max="100"
                        className="input mono u-fw-700-fs-15"
                        data-testid={`cotizador-pct-tarjeta-${t.id}`}
                        value={t.pct}
                        onChange={e => { setTarjetaPct(t.id, e.target.value); setSaveErr(''); setSavedOk(false); }}
                      />
                      <span className="addon u-color-accent-fw-700">%</span>
                    </div>
                    <span className="muted tiny u-text-right">
                      {tDirty
                        ? <>Guardado: <span className="mono">{Number(t._original).toFixed(1)}%</span></>
                        : <span className="mono">{Number(t._original).toFixed(1)}%</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Simulación Financiera con ARS 1.000.000 */}
        <div className="u-config-sim-box">
          <div className="muted tiny u-config-sim-title">
            Simulación Financiera con ARS 1.000.000
          </div>
          <div className="stack u-gap-6">
            <div className="flex-between">
              <span className="muted tiny">Bruto</span>
              <span className="mono u-fw-600">ARS 1.000.000</span>
            </div>
            <div className="flex-between">
              <span className="muted tiny">Retención ({simPctFin.toFixed(1)}%)</span>
              <span className="mono u-color-accent-fw-600">ARS {fmt(simRet)}</span>
            </div>
            <div className="flex-between u-config-sim-total">
              <span className="u-fs-13-fw-600">Nos queda</span>
              <span className="mono pos u-fw-700-fs-15">ARS {fmt(simNeto)}</span>
            </div>
          </div>
        </div>

        {/* Feedback + save */}
        {saveErr && <div className="u-alert-neg">{saveErr}</div>}
        {savedOk && <div className="u-alert-pos">Comisiones guardadas.</div>}
        {error && <div className="u-alert-neg">{error}</div>}
        <div className="flex-row u-gap-8">
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !dirty}
            data-testid="cotizador-comisiones-save"
          >
            <Icons.Check size={15} />
            {saving ? 'Guardando…' : dirty ? 'Guardar cambios' : 'Sin cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Tarjetas de crédito ────────────────────────────────────────────────

function TabTarjetas() {
  // 2026-06-29 Multi-país F5: el cotizador parametriza labels + símbolo según
  // país del tenant. AR (default) → "ARS" + "$"; UY → "UYU" + "$U". El TC
  // default también es país-aware (#445 + F5 backend): GET /api/config/last-tc
  // ahora devuelve el TC default del país (1400 AR, 40 UY) cuando no hay
  // ventas recientes.
  const { monedaLocal } = useMonedasTenant();
  const symLocal = symbolFor(monedaLocal);
  // 2026-08-02 (task #284): comisiones dinámicas por tenant, ya no hardcoded.
  // Solo LEE — el UI de edición vive en tab Configuración (ComisionesPanel).
  const { pctFinanciera, tarjetas } = useComisionesTenant();
  // #445 + follow-up 2026-07-01: TC persistente en localStorage. Al montar,
  // si el operador ya lo tipeó antes (en cualquier sesión), lo recuperamos
  // instantáneamente. Sólo hidratamos desde el backend cuando localStorage
  // está vacío (primera vez en este navegador). Ver lib/cotizadorTc.js
  // para el racionale completo. Los 2 tabs (Tarjetas + USD) comparten el
  // mismo TC — cambiarlo en uno actualiza el otro al toque.
  const [tc, setTc]         = useState(() => getStoredTc() ?? 1400);
  // Nombre por defecto como hint (el placeholder del input igual lo muestra),
  // pero precio en 0 para que el operador NO lo confunda con un valor real.
  // Antes el default era 1185 y se prestaba a errores cuando se olvidaban de
  // pisarlo (se cotizaba con un precio inventado).
  const [prods, setProds]   = useState([
    { id: 1, nom: 'iPhone 16 Pro 256GB Natural Titanium', vari: '', usd: 0 },
  ]);
  const [copiado, setCopiado] = useState(false);
  // Perfil del tenant para inyectar la oración de Google dinámicamente en
  // el mensaje copiado. Si el fetch falla (red caída) cae al string vacío
  // por defecto y el mensaje sale SIN la frase de Google — preferible a
  // bloquear el cotizado o mostrar datos de otro negocio.
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    let alive = true;
    tenantProfile.get()
      .then((p) => { if (alive) setProfile(p); })
      .catch(() => { /* silent: el mensaje sale sin la frase de Google */ });
    // Hidratación TC desde backend SOLO si no había persistido en localStorage.
    // Si el operador ya tenía un valor guardado, respetamos su elección — no
    // se pisa con el último TC del backend en cada mount.
    if (getStoredTc() === null) {
      configApi.lastTc()
        .then((res) => {
          if (alive && res && Number.isFinite(Number(res.tc))) setTc(Number(res.tc));
        })
        .catch(() => { /* silent: fallback al hardcoded */ });
    }
    // Sync entre TabTarjetas y TabUsd de la misma pestaña + entre pestañas.
    // Si el user cambia el TC en cualquiera de esos contextos, este tab se
    // actualiza sin necesidad de re-mount. Ver lib/cotizadorTc.js.
    const unsubscribe = subscribeTcChange((v) => { if (alive) setTc(v); });
    return () => { alive = false; unsubscribe(); };
  }, []);

  const addProd = () =>
    setProds([...prods, { id: Date.now(), nom: '', vari: '', usd: 0 }]);

  const rmProd = (id) =>
    prods.length > 1 && setProds(prods.filter(p => p.id !== id));

  const setProd = (id, field, val) =>
    setProds(prods.map(p => p.id === id ? { ...p, [field]: val } : p));

  // 2026-08-02 (task #284): cálculo dinámico basado en la config real del
  // tenant. Antes usaba `COEFS.c1/c3/c6` hardcoded — bug latente porque
  // TODOS los tenants Tecny cotizaban con los % de Lucas. Ahora cada
  // tenant cotiza con SUS propias tarjetas (cantidad y % según lo que
  // configuró en la sección de arriba, que persiste vía cajasApi).
  //
  // Trade-off: el shape del cálculo cambió de {c1,c3,c6} fijos → array
  // dinámico `tarjetas[]`. Los usos downstream (render + copyText) se
  // actualizaron para iterar sobre el array.
  const pctFinDec = Number(pctFinanciera) / 100 || 0;
  const calculo = useMemo(() => {
    const factTransf = factor(pctFinDec);
    const factTarjetas = tarjetas.map(t => factor(Number(t.pct) / 100 || 0));
    const lines = prods.map(p => {
      const base = (parseFloat(p.usd) || 0) * tc;
      return {
        p,
        contado:  Math.round(base),
        transf:   Math.round(base * factTransf),
        tarjetas: tarjetas.map((t, i) => ({
          id:     t.id,
          nombre: t.nombre,
          pct:    Number(t.pct) || 0,
          monto:  Math.round(base * factTarjetas[i]),
        })),
      };
    });
    const totContado = lines.reduce((a, l) => a + l.contado, 0);
    const totTransf  = lines.reduce((a, l) => a + l.transf, 0);
    const totTarjetas = tarjetas.map((t, i) => ({
      id:     t.id,
      nombre: t.nombre,
      monto:  lines.reduce((a, l) => a + (l.tarjetas[i]?.monto || 0), 0),
    }));
    return { lines, tots: { contado: totContado, transf: totTransf, tarjetas: totTarjetas } };
  }, [prods, tc, pctFinDec, tarjetas]);

  const copyText = () => {
    let txt = 'Te comparto la cotización que me solicitaste:\n';
    calculo.lines.forEach(({ p, contado, transf, tarjetas: lineTarjs }) => {
      txt += `\n- ${p.nom || 'Producto'}${p.vari ? ' ' + p.vari : ''}\n`;
      // F5: TC con símbolo país-aware ("$" para AR, "$U" para UY).
      txt += `- Precio: USD ${fmt(p.usd)} | TC ${symLocal}${fmt(tc)}\n\n`;
      txt += `- Contado en pesos ${monedaLocal}: ${symLocal}${fmt(contado)}\n`;
      txt += `- Transferencia ${monedaLocal}: ${symLocal}${fmt(transf)}\n\n`;
      // Task #284: iterar dinámico por tarjetas del tenant. Extraemos # de
      // cuotas del nombre si matchea "N cuota(s)" (ej. "TC | 3 Cuotas" → 3)
      // para agregar el desglose "por cuota" — puramente cosmético.
      lineTarjs.forEach(t => {
        const m = String(t.nombre || '').match(/(\d+)\s*cuota/i);
        const n = m ? parseInt(m[1], 10) : 1;
        const perCuota = n > 1 ? ` (${symLocal}${fmt(Math.round(t.monto / n))}/cuota)` : '';
        txt += `- 💳 ${t.nombre}: ${symLocal}${fmt(t.monto)}${perCuota}\n`;
      });
    });
    if (calculo.lines.length > 1) {
      txt += `\n━━━━━━━━━━━━━━━\n`;
      txt += `TOTAL CONTADO: ${symLocal}${fmt(calculo.tots.contado)}\n`;
      txt += `TOTAL TRANSFERENCIA: ${symLocal}${fmt(calculo.tots.transf)}\n\n`;
      calculo.tots.tarjetas.forEach(t => {
        txt += `💳 TOTAL ${t.nombre}: ${symLocal}${fmt(t.monto)}\n`;
      });
    }
    // 2026-06-22 fix multi-tenant: la frase de Google (nombre del negocio +
    // reseñas) ahora se inyecta dinámicamente desde el perfil del tenant.
    // Si el tenant tiene `google_business_enabled = false`, NO aparece nada
    // de Google (cada cliente Tecny solía ver "Tecny Tech | Reseller", el
    // negocio personal de Lucas — bug obvio en multi-tenant).
    //
    // La 2da frase (recomendación del banco) sigue para TODOS porque es
    // universal sobre operaciones con tarjeta, no específica de un negocio.
    // No se duplica en TabUsd porque efectivo/transferencia no involucra
    // banco que validar.
    const googleLine = buildGoogleLine(profile);
    if (googleLine) {
      txt += `\n${googleLine} En caso de que te interese la cotización, te recomendamos llamar previamente a tu banco para validar la operación.`;
    } else {
      txt += `\nEn caso de que te interese la cotización, te recomendamos llamar previamente a tu banco para validar la operación.`;
    }
    navigator.clipboard?.writeText(txt);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1800);
  };

  return (
    <div className="quote-grid">
      {/* ── Left: inputs ── */}
      <div>
        {/* TC card */}
        <div className="card card-tight u-mb-14">
          <div className="field u-mb-0">
            <div className="field-label">Tipo de cambio (USD → {monedaLocal})</div>
            <div className="input-group u-mw-240-max">
              <span className="addon addon-l u-color-accent">{symLocal}</span>
              <input
                type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                className="input mono"
                value={tc}
                onChange={e => {
                  const v = parseFloat(e.target.value) || 0;
                  setTc(v);
                  // Persistir + propagar a TabUsd y otras pestañas.
                  saveStoredTc(v);
                }}
              />
            </div>
          </div>
        </div>

        {/* Products header */}
        <div className="flex-between u-mb-10">
          <div className="u-fs-13-fw-600">Productos a cotizar</div>
          <button className="btn btn-sm" onClick={addProd}>
            <span className="ico"><Icons.Plus size={13} /></span>
            Agregar producto
          </button>
        </div>

        {/* Product rows */}
        <div className="stack u-gap-10">
          {prods.map((p, i) => (
            <div key={p.id} className="card card-tight">
              <div className="flex-between u-mb-10">
                <div className="muted tiny u-uppercase-06-fw-700">
                  Producto {i + 1}
                </div>
                {prods.length > 1 && (
                  <button className="icon-btn" onClick={() => rmProd(p.id)}>
                    <Icons.X size={14} />
                  </button>
                )}
              </div>
              <div className="u-grid-1fr-140-10">
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
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
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
        <div className="flex-between u-mb-14">
          <div className="u-fs-14-fw-600">Resultado</div>
          <button className="btn btn-sm btn-primary" onClick={copyText}>
            <span className="ico">
              {copiado ? <Icons.Check size={13} /> : <Icons.Share size={13} />}
            </span>
            {copiado ? 'Copiado' : 'Copiar texto'}
          </button>
        </div>

        {calculo.lines.map(({ p, contado, transf, tarjetas: lineTarjs }) => (
          <div key={p.id} className="u-quote-product-line">
            <div className="u-fw-600-fs-135-mb-8">
              {p.nom || 'Producto'}{' '}
              {p.vari && (
                <span className="muted u-fw-500">{p.vari}</span>
              )}
            </div>
            <div className="quote-line">
              <span className="lbl">Contado</span>
              <span className="val mono pos u-fw-600">{symLocal}{fmt(contado)}</span>
            </div>
            <div className="quote-line">
              <span className="lbl">Transferencia (+{pctEfectivo(pctFinDec)}%)</span>
              <span className="val mono pos u-fw-600">{symLocal}{fmt(transf)}</span>
            </div>
            {/* Task #284: renderizado dinámico. Cantidad de cuotas se extrae
                del nombre para el "por cuota" — puramente cosmético.
                Task #285: cuando N>1, stackear el "por cuota" DEBAJO del
                monto en vez de al lado (con "·"). Antes el layout quedaba
                desbalanceado en cuotas 3/6 — el ancho del value expresado
                horizontal empujaba el label a 2 líneas ("TC | 3 Cuotas
                (+30.72%)" se cortaba). Ahora el valor ocupa 1 línea de ancho
                predecible + 1 línea chiquita muted debajo si hay desglose. */}
            {lineTarjs.map((t, i) => {
              const m = String(t.nombre || '').match(/(\d+)\s*cuota/i);
              const n = m ? parseInt(m[1], 10) : 1;
              return (
                <div key={t.id} className={i === 0 ? 'quote-line u-mt-6' : 'quote-line'}>
                  <span className="lbl">💳 {t.nombre} (+{pctEfectivo(t.pct / 100)}%)</span>
                  <span className="val mono u-color-accent-fw-600 u-quote-tarjeta-val">
                    <span>{symLocal}{fmt(t.monto)}</span>
                    {n > 1 && (
                      <small className="muted u-quote-tarjeta-per-cuota">
                        {symLocal}{fmt(Math.round(t.monto / n))}/c
                      </small>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}

        {calculo.lines.length > 1 && (
          <>
            <div className="quote-total">
              <span className="lbl muted tiny u-align-self-end">Total contado</span>
              <span className="val mono pos">{symLocal}{fmt(calculo.tots.contado)}</span>
            </div>
            <div className="quote-line">
              <span className="lbl">Total transferencia</span>
              <span className="val mono pos u-fw-600">{symLocal}{fmt(calculo.tots.transf)}</span>
            </div>
            {calculo.tots.tarjetas.map((t, i) => (
              <div key={t.id} className={i === 0 ? 'quote-line u-mt-4' : 'quote-line'}>
                <span className="lbl">💳 Total {t.nombre}</span>
                <span className="val mono u-color-accent-fw-600">{symLocal}{fmt(t.monto)}</span>
              </div>
            ))}
          </>
        )}

        {/* USD reference */}
        <div className="muted tiny mono u-quote-tc-ref">
          TC referencia: {symLocal}{fmt(tc)} / USD
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
  // 2026-06-29 Multi-país F5: ver TabTarjetas para racionale de monedaLocal.
  const { monedaLocal } = useMonedasTenant();
  const symLocal = symbolFor(monedaLocal);
  // Task #284: TabUsd solo usa la comisión de Transferencia (Financiera).
  // Fetchea via el mismo hook que TabTarjetas — así las 2 tabs cotizan
  // con la config real del tenant y no con hardcoded values.
  const { pctFinanciera } = useComisionesTenant();
  const pctTransfDec = Number(pctFinanciera) / 100 || 0;
  const factTransf = factor(pctTransfDec);
  // #445 + follow-up 2026-07-01: TC persistente. Ver TabTarjetas para
  // racionale — este tab comparte el mismo valor via lib/cotizadorTc.js.
  const [tc, setTc]         = useState(() => getStoredTc() ?? 1400);
  const [prods, setProds]   = useState([
    { id: 1, nom: '', usd: 0 },
  ]);
  const [optEf, setOptEf]   = useState(true);
  const [optTars, setOptTars] = useState(false);
  const [optTusd, setOptTusd] = useState(false);
  const [copiado, setCopiado] = useState(false);
  // Mismo patrón que TabTarjetas — perfil del tenant para frase de Google
  // dinámica. Cada tab tiene su propio fetch para no acoplar el state entre
  // ambos tabs (siguen siendo componentes independientes).
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    let alive = true;
    tenantProfile.get()
      .then((p) => { if (alive) setProfile(p); })
      .catch(() => { /* silent */ });
    // Ver TabTarjetas: fetch backend sólo si localStorage está vacío + sync
    // cross-component/cross-tab.
    if (getStoredTc() === null) {
      configApi.lastTc()
        .then((res) => {
          if (alive && res && Number.isFinite(Number(res.tc))) setTc(Number(res.tc));
        })
        .catch(() => { /* silent */ });
    }
    const unsubscribe = subscribeTcChange((v) => { if (alive) setTc(v); });
    return () => { alive = false; unsubscribe(); };
  }, []);

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
        // 2026-06-13: factor(pct) = 1/(1-comisión) para que la transferencia
        // liquide el contado limpio. Task #284: pctFinanciera viene del hook.
        ef:   Math.round(u * tc),
        tars: Math.round(u * tc * factTransf),
        // 2026-06-15: redondear a entero (consistente con ef/tars en ARS).
        // En USD también cotizamos en montos redondos (USD 928 en vez de 927.84).
        tusd: Math.round(u * factTransf),
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
    let m = `Te comparto la cotización que me solicitaste:\n\nDe acuerdo al último tipo de cambio (TC ${symLocal}${fmt(tc)}):\n`;
    calculo.lines.forEach(({ p, ef, tars, tusd, usdRaw }) => {
      if (usdRaw <= 0) return;  // omitimos productos sin precio cargado
      m += `\n- ${p.nom || 'Producto'} (USD ${fmt(p.usd)})\n`;
      // F5: símbolo + moneda país-aware.
      if (optEf)   m += `  Efectivo / Contado: ${symLocal}${fmt(ef)}\n`;
      if (optTars) m += `  Transferencia ${monedaLocal}: ${symLocal}${fmt(tars)}\n`;
      if (optTusd) m += `  Transferencia USD: u$s ${fmt(tusd)}\n`;
    });
    // Totales solo si hay más de un producto con precio.
    const validas = calculo.lines.filter(l => l.usdRaw > 0);
    if (validas.length > 1) {
      m += `\n━━━━━━━━━━━━━━━\n`;
      if (optEf)   m += `TOTAL Efectivo / Contado: ${symLocal}${fmt(calculo.tots.ef)}\n`;
      if (optTars) m += `TOTAL Transferencia ${monedaLocal}: ${symLocal}${fmt(calculo.tots.tars)}\n`;
      if (optTusd) m += `TOTAL Transferencia USD: u$s ${fmt(calculo.tots.tusd)}\n`;
    }
    // 2026-06-22 fix multi-tenant: ver TabTarjetas para racionale completo.
    // En TabUsd la 2da frase del banco NO aplica (no es operación con tarjeta).
    const googleLine = buildGoogleLine(profile);
    if (googleLine) m += `\n${googleLine}`;
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
      label: `Transferencia ${monedaLocal} (+${pctEfectivo(pctTransfDec)}%)`,
      sub: 'Cobro en pesos con recargo',
    },
    {
      key: 'tusd',
      val: optTusd,
      set: setOptTusd,
      label: `Transferencia USD (+${pctEfectivo(pctTransfDec)}%)`,
      sub: 'Cobro en dólares con recargo',
    },
  ];

  return (
    <div className="quote-grid">
      {/* ── Left: inputs ── */}
      <div>
        {/* TC card */}
        <div className="card card-tight u-mb-14">
          <div className="field u-mb-0">
            <div className="field-label">Tipo de cambio (USD → {monedaLocal})</div>
            <div className="input-group u-mw-240-max">
              <span className="addon addon-l u-color-accent">{symLocal}</span>
              <input
                type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                className="input mono"
                value={tc}
                onChange={e => {
                  const v = parseFloat(e.target.value) || 0;
                  setTc(v);
                  // Persistir + propagar a TabUsd y otras pestañas.
                  saveStoredTc(v);
                }}
              />
            </div>
          </div>
        </div>

        {/* Products header */}
        <div className="flex-between u-mb-10">
          <div className="u-fs-13-fw-600">Productos a cotizar</div>
          <button className="btn btn-sm" onClick={addProd}>
            <span className="ico"><Icons.Plus size={13} /></span>
            Agregar producto
          </button>
        </div>

        {/* Product rows — mismo shape que TabTarjetas para consistencia visual. */}
        <div className="stack u-stack-gap-10-mb-16">
          {prods.map((p, i) => (
            <div key={p.id} className="card card-tight">
              <div className="flex-between u-mb-10">
                <div className="muted tiny u-uppercase-06-fw-700">
                  Producto {i + 1}
                </div>
                {prods.length > 1 && (
                  <button className="icon-btn" onClick={() => rmProd(p.id)}>
                    <Icons.X size={14} />
                  </button>
                )}
              </div>
              <div className="u-grid-1fr-140-10">
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
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
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
          <div className="field-label u-mb-10">
            Formas de pago a incluir en el mensaje
          </div>
          <div className="stack u-gap-8">
            {opciones.map(o => (
              <label
                key={o.key}
                className={`u-pay-opt ${o.val ? 'u-pay-opt-active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={o.val}
                  onChange={e => o.set(e.target.checked)}
                  className="u-checkbox-accent-15"
                />
                <div className="u-flex-1">
                  <div className="u-fw-600-fs-135">{o.label}</div>
                  <div className="muted tiny u-mt-2">{o.sub}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right: resultado sticky ── */}
      <div className="quote-sticky">
        <div className="flex-between u-mb-14">
          <div className="u-fs-14-fw-600">Resumen para el cliente</div>
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
          <div className="muted tiny u-quote-empty">
            Ingresá un monto USD para ver el cálculo.
          </div>
        ) : (
          <>
            {/* Líneas por producto */}
            {calculo.lines.filter(l => l.usdRaw > 0).map(({ p, ef, tars, tusd }) => (
              <div key={p.id} className="u-quote-summary-line">
                <div className="u-fw-600-fs-135-mb-8">
                  {p.nom || 'Producto'}{' '}
                  <span className="muted tiny mono u-fw-500">
                    · USD {fmt(p.usd)}
                  </span>
                </div>
                {optEf && (
                  <div className="quote-line">
                    <span className="lbl">Efectivo / Contado</span>
                    <span className="val mono pos u-fw-700">{symLocal}{fmt(ef)}</span>
                  </div>
                )}
                {optTars && (
                  <div className="quote-line">
                    <span className="lbl">Transferencia {monedaLocal} (+{pctEfectivo(pctTransfDec)}%)</span>
                    <span className="val mono pos u-fw-700">{symLocal}{fmt(tars)}</span>
                  </div>
                )}
                {optTusd && (
                  <div className="quote-line">
                    <span className="lbl">Transferencia USD (+{pctEfectivo(pctTransfDec)}%)</span>
                    <span className="val mono u-color-accent-fw-700">
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
                    <span className="val mono pos u-fw-700">{symLocal}{fmt(calculo.tots.ef)}</span>
                  </div>
                )}
                {optTars && (
                  <div className="quote-line">
                    <span className="lbl">Total Transferencia {monedaLocal}</span>
                    <span className="val mono pos u-fw-700">{symLocal}{fmt(calculo.tots.tars)}</span>
                  </div>
                )}
                {optTusd && (
                  <div className="quote-line">
                    <span className="lbl">Total Transferencia USD</span>
                    <span className="val mono u-color-accent-fw-700">
                      USD {fmt(calculo.tots.tusd)}
                    </span>
                  </div>
                )}
              </>
            )}

            <hr className="h-rule" />

            <div className="muted tiny mono u-mb-8">
              Total USD {fmt(calculo.tots.usdRaw)} × TC {symLocal}{fmt(tc)}
            </div>
            <div className="muted tiny u-quote-bottom-hint">
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
  // 2026-06-22 — el perfil del negocio (ficha de Google) vive ACÁ y no en
  // Config, porque acá es donde el dato se usa (mensaje generado en cada
  // cotización). Lucas pidió moverlo de Config para que sea más contextual y
  // se preste a menos confusión. El form completo aparece solo a admins; los
  // vendedores comunes ven una vista read-only desde la misma tab.
  const { user } = useAuth();
  // 2026-06-25 Bug #1: usar isTenantAdmin que también acepta tenant_cap_rol
  // ∈ {owner, admin}. Antes era `user?.role === 'admin'` (rol GLOBAL), lo
  // que bloqueaba al owner del tenant de editar el nombre del negocio.
  // El backend (tenant-profile.js) acepta owner via adminOnly middleware —
  // el bug era 100% frontend. Reportado por primer cliente real.
  const isAdmin = isTenantAdmin(user);
  // 2026-06-29 Multi-país F5: label del tab "USD → ARS" → "USD → {moneda}"
  // para que el operador UY vea "USD → UYU". Decisión durable (design doc
  // §5.4): mostramos la moneda real, NO un genérico "USD → Local".
  const { monedaLocal } = useMonedasTenant();

  return (
    <div>
      {/* Page header */}
      <div className="page-hd u-mb-var-gap">
        <div>
          <h1 className="page-title">Cotizador</h1>
          <div className="page-sub">Cálculo de precios para clientes · client-side, no persiste</div>
        </div>
        <div className="u-flex-gap-8">
          {/* Configuración va primera porque es lo que el admin abre cuando
              llega al módulo por primera vez (setea su ficha de Google una
              vez y se olvida). Default tab sigue siendo 'tarjetas' — el uso
              diario es la cotización, no la config. */}
          <button
            className={'btn' + (tab === 'config' ? ' btn-primary' : '')}
            onClick={() => setTab('config')}
          >
            <Icons.Settings size={14} /> Configuración
          </button>
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
            USD → {monedaLocal}
          </button>
        </div>
      </div>

      {tab === 'tarjetas' && <TabTarjetas />}
      {tab === 'usd'      && <TabUsd />}
      {tab === 'config'   && (
        <>
          {/* 2026-08-02 (task #285): Comisiones movidas al tab Configuración
              (antes vivían en Tarjetas de crédito — pedido de Lucas). Se ve
              solo si isAdmin: un vendedor con acceso al Cotizador no debería
              poder tocar las % del negocio. El propio ComisionesPanel usa
              useComisionesTenant() → cualquier vendedor logueado igual carga
              las % en el cotizador vía TabTarjetas/TabUsd, solo que no puede
              editarlas. */}
          {isAdmin && <ComisionesPanel />}
          <BusinessProfileSection isAdmin={isAdmin} />
        </>
      )}
    </div>
  );
}
