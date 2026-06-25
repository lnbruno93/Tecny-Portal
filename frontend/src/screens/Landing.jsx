// Landing comercial de Tecny — montada en tecnyapp.com root.
//
// Diseño: entrega de Claude Design (Tecny Landing.html), 2026-06-19. El HTML
// original era autocontenido (estilos inline + tipografía Google Fonts).
// Lo porté a React + CSS externo para integrarlo en el SPA existente sin
// romper el routing del portal.
//
// Routing:
//   · /             → Landing (este archivo) si user NO logueado
//   · /             → Navigate to /inicio si user YA logueado (decisión App.jsx)
//   · /login        → form de login (existente, sin cambios)
//   · /signup       → form de signup (existente, sin cambios)
//
// CTAs:
//   · "Iniciar sesión" / "Crear cuenta" / "Empezá gratis" → <Link to="/login"|"/signup">
//   · "Solicitá una demo" / "Agendá una demo" / "Contactar ventas" → Calendly
//     (constante CALENDLY_BASE_URL abajo + utm_source por CTA para tracking).
//
// Anchors internos (#como, #modulos, etc.): se mantienen como <a href="#...">
// porque el CSS tiene scroll-behavior: smooth y funciona sin tocar el router.
// React Router NO intercepta hash links cuando el path no cambia.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { resolveApiBase } from '../lib/api';
import './Landing.css';

// Link público del evento "Demo Tecny — Conocé el sistema" en Calendly.
// Si Lucas cambia el slug en Calendly (Booking page options), actualizar acá
// en UN SOLO lugar — los 3 CTAs apuntan a esta constante.
//
// Helper `calendlyHref(source)`: añade utm_source para que el dashboard de
// Calendly muestre qué CTA convirtió cada booking (nav vs cta-final vs
// plan-multi-local). Calendly trackea utm_* nativamente desde plan Standard,
// pero los params no hacen daño en Free y quedan listos para el upgrade.
const CALENDLY_BASE_URL = 'https://calendly.com/hola-tecnyapp/demo-tecny';
const calendlyHref = (source) =>
  `${CALENDLY_BASE_URL}?utm_source=landing&utm_medium=cta&utm_campaign=${encodeURIComponent(source)}`;

// Helper visual — checkmark de los bullets de pricing. Repetido tantas veces
// en el HTML original que vale la pena un sub-component.
function Check({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5 10 17.5 20 7" />
    </svg>
  );
}

// UX-33 fix (audit 2026-06-22): links de footer que aún no apuntan a páginas
// reales (Sobre nosotros, Contacto, Soporte, Términos, Privacidad, Seguridad,
// Novedades + 3 redes sociales). Antes eran `<a href="#">` que scroll-up al
// top del page — UX engañosa para una landing pública con signup.
// Decisión Lucas 2026-06-22: marcarlos como "Próximamente" con aria-disabled
// + cursor not-allowed + tooltip. Preserva el layout completo del footer
// para cuando se cableen, sin engañar al visitor.
function SoonLink({ children, label }) {
  return (
    <a
      href="#"
      role="link"
      aria-disabled="true"
      title={`${label || children} — próximamente`}
      onClick={(e) => e.preventDefault()}
      style={{ opacity: 0.45, cursor: 'not-allowed' }}
    >
      {children}
    </a>
  );
}

// Fallback de pricing — matchea el seed de la migration plan_prices y los
// valores actuales en backend/src/lib/planPricing.js DEFAULT_PRICES. Si
// el fetch de /api/public/pricing falla (backend down, network slow,
// CORS hipotético), la landing sigue mostrando estos valores en vez de
// quedar con "$NaN" o un placeholder. NUNCA debe haber render sin precio.
//
// Cuando Lucas cambie pricing desde admin.tecnyapp.com/planes, el primer
// render mostrará estos defaults pero el useEffect lo reemplaza ~200ms
// después con los reales. Aceptable — no hay flicker visible para el
// user típico (carga + scroll a #precios toma más que el fetch).
const FALLBACK_PRICES = Object.freeze({
  starter: 39,
  pro: 189,
});

// Resuelve base del backend para el endpoint público. Mismo helper que el
// resto de api.js — al ser endpoint sin auth, no necesitamos el wrapper
// completo con manejo de 401/token. fetch directo es suficiente y nos
// ahorra montar todo el module en el bundle de la landing si en el futuro
// se hace code-splitting de portal vs landing.
const BACKEND_BASE = resolveApiBase(import.meta.env.VITE_API_URL);

export default function Landing() {
  // Pricing dinámico de `plan_prices` table (Sub-fase C.1.4 #353).
  // Estado inicial = FALLBACK_PRICES para que el primer paint muestre
  // valores reales (no "—" ni skeleton). El fetch en mount los reemplaza
  // con los del backend si responde.
  const [prices, setPrices] = useState(FALLBACK_PRICES);

  useEffect(() => {
    // AbortController para cancelar si el user navega antes de que resuelva
    // (poco probable en la landing pero higiénico). Timeout 8s — si el
    // backend no responde, nos quedamos con los defaults.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    fetch(BACKEND_BASE + '/api/public/pricing', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then((data) => {
        const p = data?.prices;
        if (!p || typeof p !== 'object') return;
        // Validación defensiva: solo actualizamos si los campos críticos
        // son números >= 0. Si llega algo raro (NULL, string, negativo)
        // mantenemos el fallback hardcoded.
        const next = { ...FALLBACK_PRICES };
        if (typeof p.starter === 'number' && p.starter >= 0) next.starter = p.starter;
        if (typeof p.pro === 'number' && p.pro >= 0) next.pro = p.pro;
        setPrices(next);
      })
      .catch(() => {
        // Silencioso a propósito. La landing es pre-auth — un usuario
        // sin contexto ve "$39/mes" (default) y no "error". Si el backend
        // está caído al cargar la landing tenemos problemas mayores
        // (Sentry los reporta desde el portal autenticado).
      })
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return (
    <div className="tecny-landing">
      {/* ── NAV ──────────────────────────────────────────── */}
      <nav className="nav">
        <div className="nav-inner">
          <div className="brand"><span className="mk">T</span> Tecny</div>
          <div className="nav-links">
            <a href="#como">Cómo funciona</a>
            <a href="#modulos">Módulos</a>
            <a href="#precios">Precios</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="nav-cta">
            <Link to="/login" className="btn btn-ghost">Iniciar sesión</Link>
            <Link to="/signup" className="btn btn-ghost">Crear cuenta</Link>
            {/* 2026-06-25 ONB-8 → 2026-06-25 Calendly: "Solicitá una demo" pasa
                a abrir el booking de Calendly (utm_campaign=nav para tracking).
                Histórico: antes era mailto: a hola@tecnyapp.com (fallback
                temporal). Antes de eso era anchor a #precios (peor UX).
                target=_blank deja la landing abierta atrás — si el visitor no
                completa el booking puede volver a leer info sin perder contexto. */}
            <a
              href={calendlyHref('nav')}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Solicitá una demo
            </a>
          </div>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────── */}
      <header className="hero">
        <div className="wrap hero-grid">
          <div>
            <div className="eyebrow"><span className="dot"></span> El portal operativo para revendedores</div>
            <h1 className="hero-h">Todo tu negocio,<br /><span className="hl">en una sola pantalla.</span></h1>
            <p className="hero-sub">
              Cotizaciones, comprobantes, cuentas corrientes, envíos y caja — para equipos que
              venden tecnología. Dejá las planillas sueltas y los grupos de WhatsApp: Tecny
              ordena la operación de toda tu mesa de trabajo.
            </p>
            <div className="hero-actions">
              <Link to="/signup" className="btn btn-primary btn-lg">Empezá gratis</Link>
              <a href="#como" className="btn btn-lg">Ver cómo funciona</a>
            </div>
            <div className="hero-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5 10 17.5 20 7" />
              </svg>
              Sin tarjeta · listo en minutos · soporte en español
            </div>
          </div>

          {/* Product window — mockup del portal */}
          <div className="product-shot">
            <div className="shot-chrome">
              <span></span><span></span><span></span>
              <div className="shot-url">app.tecnyapp.com/inicio</div>
            </div>
            <div className="shot-body">
              <div className="shot-side">
                <div className="sb"><span className="m">T</span> Tecny</div>
                <div className="sh">Herramientas</div>
                <div className="si on"><span className="d"></span>Inicio</div>
                <div className="si"><span className="d"></span>Cotizador</div>
                <div className="si"><span className="d"></span>Financiera</div>
                <div className="si"><span className="d"></span>Cajas</div>
                <div className="si"><span className="d"></span>Envíos</div>
                <div className="si"><span className="d"></span>Cuentas CC</div>
              </div>
              <div className="shot-main">
                <div className="shot-h">Buen día, Lucas</div>
                <div className="shot-hsub">Martes 23 de mayo · 18 comprobantes hoy</div>
                <div className="shot-kpis">
                  <div className="shot-kpi"><div className="l">Comprobantes</div><div className="v">18</div><div className="t">↗ +6</div></div>
                  <div className="shot-kpi"><div className="l">Cobrado neto</div><div className="v">13,06M</div><div className="t">↗ +12.4%</div></div>
                  <div className="shot-kpi"><div className="l">Saldo CC</div><div className="v">14,28M</div><div className="t" style={{ color: 'var(--muted)' }}>−3.1%</div></div>
                  <div className="shot-kpi"><div className="l">Envíos</div><div className="v">7</div><div className="t">↗ +1</div></div>
                </div>
                <div className="shot-row">
                  <div><div className="nm">Mac Center · #F-0421</div><div className="meta">Camila R. · Transferencia</div></div>
                  <div style={{ textAlign: 'right' }}><div className="amt">ARS 4.280.000</div><span className="pill pill-pos">OCR 96%</span></div>
                </div>
                <div className="shot-row">
                  <div><div className="nm">Celular Express · #F-0420</div><div className="meta">Sofía P. · Depósito</div></div>
                  <div style={{ textAlign: 'right' }}><div className="amt">ARS 1.840.000</div><span className="pill pill-amber">Pendiente</span></div>
                </div>
                <div className="shot-row">
                  <div><div className="nm">iStore Norte · #F-0419</div><div className="meta">Lucas I. · USD efectivo</div></div>
                  <div style={{ textAlign: 'right' }}><div className="amt">USD 12.500</div><span className="pill pill-pos">OCR 95%</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── LOGO STRIP ───────────────────────────────────── */}
      <div className="strip">
        <div className="wrap">
          <div className="strip-label">Equipos que ya operan con Tecny</div>
          <div className="strip-logos">
            <span className="lg">Tech Reseller</span>
            <span className="lg">Celnyx</span>
            <span className="lg">Mac Center</span>
            <span className="lg">iSell</span>
            <span className="lg">Movilink</span>
            <span className="lg">Phone Lab</span>
          </div>
        </div>
      </div>

      {/* ── CÓMO FUNCIONA ────────────────────────────────── */}
      <section className="s" id="como">
        <div className="wrap">
          <div className="s-head center">
            <div className="s-kicker">Cómo funciona</div>
            <h2 className="s-title">De Excel al control total en cuatro pasos</h2>
            <p className="s-sub">Sin migración dolorosa. Empezás a cargar y el portal arma la foto del negocio sola.</p>
          </div>
          <div className="steps">
            <div className="step">
              <div className="n">01</div>
              <div className="ico">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5"/><path d="M21 3 11 13"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>
                </svg>
              </div>
              <h3>Creá tu equipo</h3>
              <p>Sumá a tus vendedores y administradores con permisos por módulo. Cada uno ve lo que le toca.</p>
            </div>
            <div className="step">
              <div className="n">02</div>
              <div className="ico">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 7h8M8 11h8M8 15h5"/>
                </svg>
              </div>
              <h3>Cargá la operación</h3>
              <p>Cotizá con un clic, subí comprobantes con foto y el OCR detecta el monto solo. Despachá envíos.</p>
            </div>
            <div className="step">
              <div className="n">03</div>
              <div className="ico">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 17 9 11l4 4 8-9"/><path d="M14 6h7v7"/>
                </svg>
              </div>
              <h3>Seguí los saldos</h3>
              <p>Cuentas corrientes, deudas, inversiones y caja se actualizan en vivo. Sabés siempre quién te debe.</p>
            </div>
            <div className="step">
              <div className="n">04</div>
              <div className="ico">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/>
                </svg>
              </div>
              <h3>Controlá todo</h3>
              <p>Historial de auditoría con cada cambio. Quién hizo qué, cuándo y cuánto — sin sorpresas.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── MÓDULOS ──────────────────────────────────────── */}
      <section className="s" id="modulos" style={{ background: 'var(--bg-2)', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)' }}>
        <div className="wrap">
          <div className="s-head">
            <div className="s-kicker">Los módulos</div>
            <h2 className="s-title">Una herramienta para cada parte del negocio</h2>
            <p className="s-sub">Siete módulos que conversan entre sí. Activá los que necesitás, sumá el resto cuando crezcas.</p>
          </div>
          <div className="mods">
            <div className="mod">
              <div className="ico tint-amber">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="18" rx="2.5"/>
                  <rect x="7" y="6.5" width="10" height="3.5" rx="0.6"/>
                  <circle cx="8.5" cy="13.5" r="0.7" fill="currentColor"/>
                  <circle cx="12" cy="13.5" r="0.7" fill="currentColor"/>
                  <circle cx="15.5" cy="13.5" r="0.7" fill="currentColor"/>
                </svg>
              </div>
              <h3>Cotizador</h3>
              <p>Precios al instante con tipo de cambio, recargos por cuota y formas de pago. Copiás el texto y lo mandás por WhatsApp.</p>
            </div>
            <div className="mod">
              <div className="ico tint-blue">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 17 9 11l4 4 8-9"/><path d="M14 6h7v7"/>
                </svg>
              </div>
              <h3>Financiera</h3>
              <p>Cargá comprobantes con foto, el OCR detecta el monto y calcula la retención automáticamente. Pagos y vendedores en un solo lugar.</p>
            </div>
            <div className="mod">
              <div className="ico tint-green">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 8H6a3 3 0 0 1 0-6h13v6Z"/>
                  <path d="M3 5v13a3 3 0 0 0 3 3h15V8"/>
                  <circle cx="17" cy="14" r="1.4" fill="currentColor"/>
                </svg>
              </div>
              <h3>Cajas</h3>
              <p>Deudas e inversiones por contacto, en pesos y dólares por separado. Sabés con exactitud qué entra, qué sale y a quién.</p>
            </div>
            <div className="mod">
              <div className="ico tint-purple">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 7h11v9H2z"/>
                  <path d="M13 10h4l4 4v2h-8"/>
                  <circle cx="7" cy="18" r="2"/>
                  <circle cx="17.5" cy="18" r="2"/>
                </svg>
              </div>
              <h3>Envíos</h3>
              <p>Despachos a domicilio con prioridad, horario y operador. Cada envío lleva productos con IMEI y cobros a realizar en la entrega.</p>
            </div>
            <div className="mod">
              <div className="ico tint-cyan">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3 5 4.5Z"/>
                  <path d="M8.5 8h7M8.5 12h7"/>
                </svg>
              </div>
              <h3>Cuentas CC</h3>
              <p>Clientes B2B con categorías VIP, A+ y A-. Compras, pagos, devoluciones y entregas con detalle de IMEI verificado por item.</p>
            </div>
            <div className="mod">
              <div className="ico tint-pink">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="2" width="12" height="20" rx="2.5"/>
                  <path d="M10 5h4"/>
                  <circle cx="12" cy="18" r="0.8" fill="currentColor"/>
                </svg>
              </div>
              <h3>Usados</h3>
              <p>Catálogo de precios en USD editable como una planilla. Actualizá decenas de modelos de una vez y mantené la tabla al día.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURE HIGHLIGHT ────────────────────────────── */}
      <section className="s">
        <div className="wrap feat">
          <div>
            <div className="s-kicker">Cotizá en segundos</div>
            <h2 className="s-title">El precio listo<br />antes de que el cliente termine de escribir</h2>
            <p className="s-sub">Cargás el modelo, el dólar del día y el sistema arma todas las formas de pago. Copiás y enviás.</p>
            <div className="feat-list">
              <div className="feat-item">
                <div className="ck"><Check size={14} /></div>
                <div>
                  <h4>Contado, transferencia y cuotas</h4>
                  <p>Cada forma con su recargo configurado, calculado en vivo.</p>
                </div>
              </div>
              <div className="feat-item">
                <div className="ck"><Check size={14} /></div>
                <div>
                  <h4>Texto listo para WhatsApp</h4>
                  <p>Saludo, precios y cierre comercial — un clic y al portapapeles.</p>
                </div>
              </div>
              <div className="feat-item">
                <div className="ck"><Check size={14} /></div>
                <div>
                  <h4>Varios productos juntos</h4>
                  <p>Armá una cotización con varios equipos y mostrá el total.</p>
                </div>
              </div>
            </div>
          </div>
          <div className="feat-visual">
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>iPhone 16 Pro · 256GB Natural</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }} className="mono">USD 1.185 · TC $1.200</div>
            <div className="calc-row"><span className="l">Contado</span><span className="v" style={{ color: 'var(--pos)' }}>$1.422.000</span></div>
            <div className="calc-row"><span className="l">Transferencia (+3%)</span><span className="v" style={{ color: 'var(--pos)' }}>$1.464.660</span></div>
            <div className="calc-row"><span className="l">💳 3 cuotas (+23.5%)</span><span className="v" style={{ color: 'var(--accent)' }}>$1.756.170</span></div>
            <div className="calc-row"><span className="l">💳 6 cuotas (+28%)</span><span className="v" style={{ color: 'var(--accent)' }}>$1.820.160</span></div>
            <div className="calc-total"><span className="l" style={{ color: 'var(--muted)', fontSize: 13, alignSelf: 'flex-end' }}>6 × $303.360</span><span className="v">$1.820.160</span></div>
          </div>
        </div>
      </section>

      {/* ── TESTIMONIOS ──────────────────────────────────── */}
      <section className="s" id="testimonios" style={{ background: 'var(--bg-2)', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)' }}>
        <div className="wrap">
          <div className="s-head center">
            <div className="s-kicker">Lo que dicen</div>
            <h2 className="s-title">Equipos que dejaron el caos atrás</h2>
          </div>
          <div className="tests">
            <div className="test">
              <div className="stars">★★★★★</div>
              <p className="q">"Antes cada vendedor cotizaba distinto. Ahora todos sacan el mismo precio en segundos y yo veo todo desde un solo lugar. Cambió cómo trabajamos."</p>
              <div className="who"><div className="av">AM</div><div><div className="nm">Ariel Méndez</div><div className="rl">Mac Center · CABA</div></div></div>
            </div>
            <div className="test">
              <div className="stars">★★★★★</div>
              <p className="q">"El OCR de comprobantes me ahorra horas. Saco la foto de la transferencia y el monto ya queda cargado. Las cuentas corrientes nunca estuvieron tan claras."</p>
              <div className="who"><div className="av">RS</div><div><div className="nm">Romina Saro</div><div className="rl">Celular Express</div></div></div>
            </div>
            <div className="test">
              <div className="stars">★★★★★</div>
              <p className="q">"Manejo tres sucursales y con el historial de auditoría sé exactamente quién tocó qué. Los envíos con cobro en la puerta nos ordenaron la logística entera."</p>
              <div className="who"><div className="av">FV</div><div><div className="nm">Federico Vidal</div><div className="rl">iSell · 3 locales</div></div></div>
            </div>
          </div>
          <div className="bigstat">
            <div><div className="v">+2.800</div><div className="l">reseñas 5★ en Google</div></div>
            <div><div className="v">18k</div><div className="l">cotizaciones por mes</div></div>
            <div><div className="v">94%</div><div className="l">precisión del OCR</div></div>
            <div><div className="v">7</div><div className="l">módulos integrados</div></div>
          </div>
        </div>
      </section>

      {/* ── PRECIOS ──────────────────────────────────────── */}
      <section className="s" id="precios">
        <div className="wrap">
          <div className="s-head center">
            <div className="s-kicker">Precios</div>
            <h2 className="s-title">Planes que crecen con tu equipo</h2>
            <p className="s-sub">Probá gratis 14 días. Sin tarjeta, sin compromiso. Cancelás cuando quieras.</p>
          </div>
          {/*
            Precios dinámicos desde `plan_prices` table via /api/public/pricing.
            Si Lucas cambia desde admin.tecnyapp.com/planes, este componente
            refleja el valor nuevo en el próximo render (cache backend max 5min;
            Cache-Control HTTP max 60s). Fallback a FALLBACK_PRICES hardcoded
            si el fetch falla — definidos arriba del componente.
              Solo   → backend slug 'starter' → USD prices.starter/mes
              Equipo → backend slug 'pro'     → USD prices.pro/mes
              Multi-local → 'enterprise' (custom_mrr_usd per-tenant) → "A medida"
          */}
          <div className="plans">
            <div className="plan">
              <div className="pname">Solo</div>
              <div className="pdesc">Para el revendedor independiente que arranca a ordenarse.</div>
              <div className="price"><span className="cur">USD </span><span className="num">{prices.starter}</span><span className="per">/mes</span></div>
              <div className="pnote">14 días de prueba gratis</div>
              <ul>
                <li><Check /> 1 usuario</li>
                <li><Check /> Cotizador + Usados</li>
                <li><Check /> Financiera básica</li>
                <li><Check /> 50 OCR / mes</li>
              </ul>
              <Link to="/signup" className="btn">Empezar gratis</Link>
            </div>
            <div className="plan featured">
              <div className="tag-pop">Más elegido</div>
              <div className="pname">Equipo</div>
              <div className="pdesc">Para el negocio con vendedores y cuentas corrientes activas.</div>
              <div className="price"><span className="cur">USD </span><span className="num">{prices.pro}</span><span className="per">/mes</span></div>
              <div className="pnote">14 días de prueba gratis</div>
              <ul>
                <li><Check /> Hasta 10 usuarios</li>
                <li><Check /> Los 7 módulos completos</li>
                <li><Check /> Permisos por usuario</li>
                <li><Check /> OCR ilimitado + Historial</li>
              </ul>
              <Link to="/signup" className="btn btn-primary">Empezar gratis</Link>
            </div>
            <div className="plan">
              <div className="pname">Multi-local</div>
              <div className="pdesc">Para cadenas con varias sucursales y administración central.</div>
              <div className="price"><span className="num" style={{ fontSize: 30 }}>A medida</span></div>
              <div className="pnote">Hablemos de tu operación</div>
              <ul>
                <li><Check /> Usuarios ilimitados</li>
                <li><Check /> Multi-equipo / multi-local</li>
                <li><Check /> Soporte prioritario</li>
                <li><Check /> Onboarding dedicado</li>
              </ul>
              {/* "Contactar ventas" del plan Multi-local: directo a Calendly
                  con utm_campaign=plan-multi-local. Es el CTA más caro y de
                  conversión más alta — usar Calendly evita perder leads serios
                  por mandarlos a un signup genérico que no calza con su intent
                  (un cliente multi-local NO se auto-onboardea desde /signup). */}
              <a
                href={calendlyHref('plan-multi-local')}
                target="_blank"
                rel="noopener noreferrer"
                className="btn"
              >
                Contactar ventas
              </a>
            </div>
          </div>
          {/* UX-34 fix (audit 2026-06-22): se eliminó "Precios a confirmar" del
              disclaimer — contradecía los precios USD reales que SÍ se muestran
              ($39 starter, $189 pro). Ahora solo el incentivo positivo. */}
          <div className="price-note">Todos los planes incluyen actualizaciones, backups y soporte en español.</div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────── */}
      <section className="s" id="faq" style={{ background: 'var(--bg-2)', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)' }}>
        <div className="wrap">
          <div className="s-head center">
            <div className="s-kicker">Preguntas frecuentes</div>
            <h2 className="s-title">Lo que todos preguntan</h2>
          </div>
          <div className="faq">
            <details className="qa" open>
              <summary>¿Necesito instalar algo?
                <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </summary>
              <div className="a">No. Tecny funciona desde el navegador, en la compu o el celular. Creás tu cuenta y empezás a usarlo en minutos, sin descargas ni configuración técnica.</div>
            </details>
            <details className="qa">
              <summary>¿Cómo funciona el lector de comprobantes (OCR)?
                <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </summary>
              <div className="a">Sacás una foto del comprobante de pago o subís el PDF, y el sistema detecta el monto automáticamente con inteligencia artificial. Si la confianza es alta, queda pre-cargado; si no, te avisa para que lo revises. Aceptamos JPG, PNG, WEBP y PDF de hasta 5 MB.</div>
            </details>
            <details className="qa">
              <summary>¿Mis vendedores van a ver toda la información?
                <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </summary>
              <div className="a">Vos decidís. Cada usuario tiene permisos por módulo: podés darle acceso solo al Cotizador y Envíos, por ejemplo, mientras que la parte financiera y de caja queda reservada para administradores.</div>
            </details>
            <details className="qa">
              <summary>¿Puedo manejar pesos y dólares?
                <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </summary>
              <div className="a">Sí. Cuentas corrientes, cajas, comprobantes y catálogo de usados manejan ARS y USD por separado, sin mezclarlos. El cotizador convierte con el tipo de cambio que vos cargues.</div>
            </details>
            <details className="qa">
              <summary>¿Qué pasa con mis datos si dejo de usarlo?
                <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </summary>
              <div className="a">Tus datos son tuyos. Podés exportarlos en cualquier momento. Nada se borra de forma definitiva sin tu confirmación — el sistema usa borrado suave para que nunca pierdas un registro por error.</div>
            </details>
            <details className="qa">
              <summary>¿Ofrecen prueba gratis?
                <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </summary>
              <div className="a">14 días gratis con todas las funciones, sin tarjeta de crédito. Si te sirve, elegís un plan; si no, no pagás nada.</div>
            </details>
          </div>
        </div>
      </section>

      {/* ── CTA FINAL ────────────────────────────────────── */}
      <section className="s">
        <div className="wrap">
          <div className="cta-final">
            <h2>Ordená tu negocio hoy</h2>
            <p>Sumate a los equipos que ya dejaron las planillas atrás. Empezá gratis y mirá la diferencia en una semana.</p>
            <div className="hero-actions">
              <Link to="/signup" className="btn btn-primary btn-lg">Empezá gratis</Link>
              {/* 2026-06-25 ONB-8 → Calendly: era mailto: como fallback temporal.
                  Ahora abre el booking de Calendly con utm_campaign=cta-final
                  para que sepamos si la sección final convierte más que el CTA
                  del nav (insight para iterar copy/posicionamiento). */}
              <a
                href={calendlyHref('cta-final')}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-lg"
              >
                Agendá una demo
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ───────────────────────────────────────── */}
      <footer>
        <div className="wrap">
          <div className="foot-grid">
            <div>
              <div className="brand"><span className="mk">T</span> Tecny</div>
              <p className="foot-brand-blurb">El portal operativo para revendedores. Cotizá, cobrá, despachá y administrá — todo en una sola pantalla.</p>
            </div>
            <div className="foot-col">
              <h5>Producto</h5>
              <a href="#modulos">Módulos</a>
              <a href="#como">Cómo funciona</a>
              <a href="#precios">Precios</a>
              <SoonLink>Novedades</SoonLink>
            </div>
            <div className="foot-col">
              <h5>Empresa</h5>
              <SoonLink>Sobre nosotros</SoonLink>
              <a href="#testimonios">Clientes</a>
              <SoonLink>Contacto</SoonLink>
              <SoonLink>Soporte</SoonLink>
            </div>
            <div className="foot-col">
              <h5>Legal</h5>
              {/* #332: las 3 páginas legales ahora existen con boilerplate
                  AR (Ley 25.326 + CCyCN). Pendiente revisión legal formal
                  — disclaimer visible en cada página. */}
              <Link to="/terms">Términos</Link>
              <Link to="/privacy">Privacidad</Link>
              <Link to="/security">Seguridad</Link>
            </div>
          </div>
          <div className="foot-bottom">
            <div className="cr">© 2026 Tecny · Tech Reseller & Celnyx · Buenos Aires, Argentina</div>
            <div className="soc">
              <SoonLink label="Instagram">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-label="Instagram">
                  <rect x="3" y="3" width="18" height="18" rx="5"/>
                  <circle cx="12" cy="12" r="4"/>
                  <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor"/>
                </svg>
              </SoonLink>
              <SoonLink label="WhatsApp">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="WhatsApp">
                  <path d="M3 21l1.7-5A8 8 0 1 1 8 19.3Z"/>
                </svg>
              </SoonLink>
              <SoonLink label="LinkedIn">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="LinkedIn">
                  <rect x="3" y="3" width="18" height="18" rx="3"/>
                  <path d="M7 10v7M7 7v.01M11 17v-4a2 2 0 0 1 4 0v4"/>
                </svg>
              </SoonLink>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
