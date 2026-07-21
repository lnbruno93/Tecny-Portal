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

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import './Landing.css';
// 2026-07-19 Sprint 1 H3 — observabilidad de la landing pública.
// Helpers para: dataLayer events (provider-agnóstico), performance marks,
// error reporting via backend Sentry. Ver Landing.analytics.js para detalle.
import {
  trackEvent,
  markPerformance,
  measurePerformance,
  reportLandingError,
} from './Landing.analytics';
// 2026-07-19 Sprint 2 M1 — hooks del CMS extraídos a archivo aparte.
// Antes había UN useEffect monolítico con 3 fetches paralelos sharing
// AbortController; ahora cada hook es independiente y testeable en aislamiento.
// FALLBACK_* + BACKEND_BASE viven en Landing.hooks.js; los re-importamos
// para uso local (buildWaLink, <img src>, comparación hero fallback).
import {
  useLandingPricing,
  useLandingCMS,
  useTrustedCompanies,
  FALLBACK_CONTACT,
  FALLBACK_HERO,
  BACKEND_BASE,
} from './Landing.hooks';

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
//
// 2026-07-19 Sprint 2 M3 a11y: agregado role="img" + aria-label. Antes los
// screen readers no anunciaban los checkmarks del pricing → el usuario ciego
// no percibía qué features incluía cada plan.
function Check({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
         role="img" aria-label="Incluido">
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
// 2026-07-19 Sprint 2 M3 a11y: era un <a href="#"> con aria-disabled="true",
// pero screen readers ignoran aria-disabled en <a> con href (lo leen como
// link activo normal). Ahora usamos <span role="link" aria-disabled="true">
// que sí es interpretado correctamente como "link deshabilitado". Preservamos
// el mismo look visual (opacity + cursor + tooltip) y semántica de "link
// próximamente" via role="link".
function SoonLink({ children, label }) {
  return (
    <span
      role="link"
      aria-disabled="true"
      title={`${label || children} — próximamente`}
      style={{ opacity: 0.45, cursor: 'not-allowed' }}
    >
      {children}
    </span>
  );
}

// FAQ default — los 6 Q&A hardcodeados del diseño original. Si el admin carga
// aunque sea 1, se usan los del admin (Lucas queda con control total).
// 2026-07-19 Sprint 2 M1: quedó acá (no se movió a Landing.hooks.js) por su
// tamaño — bloatearía el hooks file y dificultaría diff en un futuro rediseño.
// Se pasa como argumento a useLandingCMS para invertir la dependencia.
const FALLBACK_FAQ = Object.freeze([
  { id: 'default-1', question: '¿Necesito instalar algo?',
    answer: 'No. Tecny funciona desde el navegador, en la compu o el celular. Creás tu cuenta y empezás a usarlo en minutos, sin descargas ni configuración técnica.' },
  { id: 'default-2', question: '¿Cómo funciona el lector de comprobantes (OCR)?',
    answer: 'Sacás una foto del comprobante de pago o subís el PDF, y el sistema detecta el monto automáticamente con inteligencia artificial. Si la confianza es alta, queda pre-cargado; si no, te avisa para que lo revises. Aceptamos JPG, PNG, WEBP y PDF de hasta 5 MB.' },
  { id: 'default-3', question: '¿Mis vendedores van a ver toda la información?',
    answer: 'Vos decidís. Cada usuario tiene permisos por módulo: podés darle acceso solo al Cotizador y Envíos, por ejemplo, mientras que la parte financiera y de caja queda reservada para administradores.' },
  { id: 'default-4', question: '¿Puedo manejar pesos y dólares?',
    answer: 'Sí. Cuentas corrientes, cajas, comprobantes y catálogo de usados manejan ARS y USD por separado, sin mezclarlos. El cotizador convierte con el tipo de cambio que vos cargues.' },
  { id: 'default-5', question: '¿Qué pasa con mis datos si dejo de usarlo?',
    answer: 'Tus datos son tuyos. Podés exportarlos en cualquier momento. Nada se borra de forma definitiva sin tu confirmación — el sistema usa borrado suave para que nunca pierdas un registro por error.' },
  { id: 'default-6', question: '¿Ofrecen prueba gratis?',
    answer: '14 días gratis con todas las funciones, sin tarjeta de crédito. Si te sirve, elegís un plan; si no, no pagás nada.' },
]);

// Helper para armar link wa.me con mensaje pre-cargado. Normaliza el número
// stripeando cualquier cosa que no sea dígito (por si el admin editó con
// espacios o "+" por accidente).
function buildWaLink(whatsapp, message) {
  const digits = (whatsapp || FALLBACK_CONTACT.whatsapp).replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export default function Landing() {
  // 2026-07-19 Sprint 2 M1a — refactor: los 3 fetches del CMS ahora viven en
  // hooks independientes (Landing.hooks.js). Cada uno maneja su propio
  // AbortController + timeout + catch → error reporting específico por
  // sección. Cero coupling entre ellos, mientras que antes compartían un
  // AbortController y si uno tardaba podía abortar los otros.
  const { prices, isReady: pricesReady } = useLandingPricing();
  const { contact, hero, cta, faq, isReady: cmsReady } = useLandingCMS(FALLBACK_FAQ);
  const { trustedCompanies, isReady: trustedReady } = useTrustedCompanies();

  // Observabilidad de la landing (Sprint 1 H3):
  // - `landing_view` + `landing-mount` mark al montar (una vez).
  // - Cuando los 3 hooks reportan ready, disparamos
  //   `landing_content_ready` + measure de tiempo total (baseline RUM).
  //   Antes se hacía con un contador manual dentro del useEffect
  //   monolítico; ahora es un useEffect chico que reacciona a los
  //   booleans de cada hook.
  useEffect(() => {
    trackEvent('landing_view', { url: window.location.href });
    markPerformance('landing-mount');
  }, []);
  useEffect(() => {
    if (pricesReady && cmsReady && trustedReady) {
      markPerformance('landing-content-ready');
      measurePerformance('landing-content-time', 'landing-mount', 'landing-content-ready');
      trackEvent('landing_content_ready');
    }
  }, [pricesReady, cmsReady, trustedReady]);

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
            <Link to="/login" className="btn btn-ghost"
                  onClick={() => trackEvent('cta_click', { location: 'nav', target: 'login' })}>
              Iniciar sesión
            </Link>
            <Link to="/signup" className="btn btn-ghost"
                  onClick={() => trackEvent('cta_click', { location: 'nav', target: 'signup' })}>
              Crear cuenta
            </Link>
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
              onClick={() => trackEvent('cta_click', { location: 'nav', target: 'demo' })}
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
            {/* 2026-07-13 Fase 3: headline dinámico desde CMS. Si Lucas no
                cargó nada custom, cae al fallback con <br /> preservado.
                Cuando edita desde el admin, se muestra como single-line
                (perdemos el corte de línea del diseño original a cambio de
                editabilidad). */}
            {hero.headline === FALLBACK_HERO.headline ? (
              <h1 className="hero-h">Todo tu negocio,<br /><span className="hl">en una sola pantalla.</span></h1>
            ) : (
              <h1 className="hero-h">{hero.headline}</h1>
            )}
            {/* Subheadline opcional — solo se muestra si Lucas lo cargó desde admin. */}
            {hero.subheadline && (
              <p className="hero-sub" style={{ fontWeight: 600, marginBottom: 8 }}>{hero.subheadline}</p>
            )}
            <p className="hero-sub">{hero.blurb}</p>
            <div className="hero-actions">
              <Link to="/signup" className="btn btn-primary btn-lg"
                    onClick={() => trackEvent('cta_click', { location: 'hero', target: 'signup' })}>
                Empezá gratis
              </Link>
              <a href="#como" className="btn btn-lg"
                 onClick={() => trackEvent('cta_click', { location: 'hero', target: 'scroll-como' })}>
                Ver cómo funciona
              </a>
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
                  <div className="u-text-right"><div className="amt">ARS 4.280.000</div><span className="pill pill-pos">OCR 96%</span></div>
                </div>
                <div className="shot-row">
                  <div><div className="nm">Celular Express · #F-0420</div><div className="meta">Sofía P. · Depósito</div></div>
                  <div className="u-text-right"><div className="amt">ARS 1.840.000</div><span className="pill pill-amber">Pendiente</span></div>
                </div>
                <div className="shot-row">
                  <div><div className="nm">iStore Norte · #F-0419</div><div className="meta">Lucas I. · USD efectivo</div></div>
                  <div className="u-text-right"><div className="amt">USD 12.500</div><span className="pill pill-pos">OCR 95%</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/*
        ── LOGO STRIP — REMOVIDO #441 ───────────────────────────────────────
        2026-06-26: la franja "Equipos que ya operan con Tecny" listaba 6
        empresas (Tech Reseller, Celnyx, Mac Center, iSell, Movilink, Phone
        Lab). La mayoría eran nombres inventados — solo Celnyx es real (el
        tenant interno de Lucas / iPro). Mostrar logos fake engaña al
        prospecto sobre tracción real y rompe la confianza apenas un visitante
        google-ea cualquiera de los nombres.
        Cuando tengamos 3+ clientes con permiso explícito para mostrar el
        nombre, agregamos el strip de vuelta — con los reales únicamente.
        Sprint 3 L2 (2026-07-19): el CSS `.strip*` que quedaba huérfano en
        Landing.css se removió — cuando volvamos con logos reales, el
        pattern del carrusel de "Empresas que confiaron" sirve como base.
      */}

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
            <div className="calc-row"><span className="l">💳 3 cuotas (+23.5%)</span><span className="v u-color-accent">$1.756.170</span></div>
            <div className="calc-row"><span className="l">💳 6 cuotas (+28%)</span><span className="v u-color-accent">$1.820.160</span></div>
            <div className="calc-total"><span className="l" style={{ color: 'var(--muted)', fontSize: 13, alignSelf: 'flex-end' }}>6 × $303.360</span><span className="v">$1.820.160</span></div>
          </div>
        </div>
      </section>

      {/*
        ── TESTIMONIOS + BIGSTAT — REMOVIDO #441 ────────────────────────────
        2026-06-26: la sección listaba 3 testimonials con nombres y empresas
        inventadas (Ariel Méndez / Mac Center, Romina Saro / Celular Express,
        Federico Vidal / iSell) — strict fabrication, ningún cliente real dijo
        eso. La bigstat agregaba 4 métricas no auditables o directamente
        falsas:
          · "+2.800 reseñas 5★ en Google" — Tecny no tiene perfil de Google
            Business con 2.800 reseñas.
          · "18k cotizaciones por mes" — imposible con ~3-4 clientes reales.
          · "94% precisión del OCR" — número arbitrario no medido.
          · "7 módulos integrados" — verdadero, pero solo se sostiene si lo
            anclamos a un anchor verificable (la sección Módulos los lista).
        Mostrar todo esto a un prospecto que después abre la app y ve un
        portal vacío destruye la confianza. Cuando tengamos 3 clientes que
        firmen testimonios reales + Google Reviews activo, el patrón vuelve
        — con quotes auténticos y nombres reales que el prospecto puede
        verificar.
        Footer "Clientes" link al anchor #testimonios también removido — el
        anchor no existe más.
        Sprint 3 L2 (2026-07-19): el CSS `.test*` y `.bigstat*` que quedaba
        huérfano en Landing.css se removió como parte del cleanup general.
      */}

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

            2026-07-20 (Lucas): rename de nombres comerciales (Solo/Equipo/
            Multi-local) a los slugs técnicos del backend (Starter/Pro/
            Enterprise) + card Trial visible al inicio. Rationale:
              - El back office admin/planes muestra Trial/Starter/Pro/Enterprise
                y confunde ver nombres distintos en la landing.
              - Trial expuesto explícito refuerza el value prop "empezá gratis
                sin tarjeta" — antes vivía enterrado como subtitle de cada card.
              - Los slugs coinciden 1:1 con tenants.plan de la DB, feature
                flags per-plan (F2), y el JWT tenant_rol. Alinear naming
                cross-layer reduce fricción operativa.
          */}
          <div className="plans plans-4col">
            <div className="plan">
              <div className="pname">Trial</div>
              <div className="pdesc">Probá Tecny completo antes de elegir plan. Sin tarjeta.</div>
              <div className="price"><span className="cur">USD </span><span className="num">0</span><span className="per">/14 días</span></div>
              <div className="pnote">Sin compromiso</div>
              <ul>
                <li><Check /> Acceso completo a la plataforma</li>
                <li><Check /> Sin tarjeta requerida</li>
                <li><Check /> Cancelable en cualquier momento</li>
                <li><Check /> Migrás sin perder datos</li>
              </ul>
              <Link to="/signup" className="btn"
                    onClick={() => trackEvent('cta_click', { location: 'pricing', target: 'signup', plan: 'trial' })}>
                Empezar prueba gratis
              </Link>
            </div>
            <div className="plan">
              <div className="pname">Starter</div>
              <div className="pdesc">Para el revendedor independiente que arranca a ordenarse.</div>
              <div className="price"><span className="cur">USD </span><span className="num">{prices.starter}</span><span className="per">/mes</span></div>
              <div className="pnote">14 días de prueba gratis</div>
              <ul>
                <li><Check /> 1 usuario</li>
                <li><Check /> Cotizador + Usados</li>
                <li><Check /> Financiera básica</li>
                <li><Check /> 50 OCR / mes</li>
              </ul>
              <Link to="/signup" className="btn"
                    onClick={() => trackEvent('cta_click', { location: 'pricing', target: 'signup', plan: 'starter' })}>
                Empezar gratis
              </Link>
            </div>
            <div className="plan featured">
              <div className="tag-pop">Más elegido</div>
              <div className="pname">Pro</div>
              <div className="pdesc">Para el negocio con vendedores y cuentas corrientes activas.</div>
              <div className="price"><span className="cur">USD </span><span className="num">{prices.pro}</span><span className="per">/mes</span></div>
              <div className="pnote">14 días de prueba gratis</div>
              <ul>
                <li><Check /> Hasta 10 usuarios</li>
                <li><Check /> Los 7 módulos completos</li>
                <li><Check /> Permisos por usuario</li>
                <li><Check /> OCR ilimitado + Historial</li>
              </ul>
              <Link to="/signup" className="btn btn-primary"
                    onClick={() => trackEvent('cta_click', { location: 'pricing', target: 'signup', plan: 'pro' })}>
                Empezar gratis
              </Link>
            </div>
            <div className="plan">
              <div className="pname">Enterprise</div>
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
                onClick={() => trackEvent('cta_click', { location: 'pricing', target: 'demo', plan: 'multi-local' })}
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

      {/* ── EMPRESAS QUE CONFIARON (2026-07-19, CMS Fase 4) ────────────
          Carrusel infinito auto-scroll estilo Stripe/Vercel. Los logos se
          gestionan desde admin.tecnyapp.com/sitio-publico → card "Empresas
          que confiaron en Tecny". Duplicamos el array en el DOM para el
          loop seamless (translateX 0 → -50%: cuando el segundo set queda
          donde arrancó el primero, la transición es invisible).

          Fail-open silencioso: si trustedCompanies está vacío (backend
          caído, ninguna empresa cargada, o admin borró todas), la sección
          NO se renderiza. La landing sigue completa sin placeholder feo.

          Placement decision 2026-07-19: entre Precios y FAQ. Rationale:
          después de mostrar los precios el visitor está evaluando; ver
          logos de empresas concretas antes de las FAQ le da un empujón
          de social proof en el momento de la decisión. */}
      {trustedCompanies.length > 0 && (
        <section className="s trusted" id="empresas">
          <div className="wrap">
            <div className="s-head center">
              <div className="s-kicker">Confían en nosotros</div>
              <h2 className="s-title">Empresas que confiaron en Tecny</h2>
              <p className="s-sub">
                Comercios y equipos que ya ordenaron su operación con nosotros.
              </p>
            </div>
            <div className="trusted-track-wrap"
                 aria-label="Empresas que confiaron en Tecny">
              {/* Duplicamos el array para el loop seamless (set A + set B).
                  El :hover en .trusted-track-wrap pausa el marquee (más
                  UX-friendly para leer un logo específico).
                  2026-07-19 Sprint 2 M3 a11y:
                  - role="list" + role="listitem" para que screen readers
                    anuncien "lista de empresas: N ítems".
                  - Set B (duplicado del loop) va con aria-hidden="true"
                    para que no lea cada empresa 2 veces. El marquee es
                    puramente visual — la información completa está en A. */}
              <div className="trusted-track" role="list">
                {[...trustedCompanies, ...trustedCompanies].map((c, i) => (
                  <div
                    key={`${c.id}-${i}`}
                    className="trusted-logo"
                    role="listitem"
                    aria-hidden={i >= trustedCompanies.length ? 'true' : undefined}
                    title={c.nombre}
                  >
                    <img
                      src={`${BACKEND_BASE}/api/public/trusted-companies/${c.id}/logo`}
                      alt={c.nombre}
                      loading="lazy"
                      // 2026-07-19 Sprint 1 H3: si un <img> del carrusel se rompe
                      // (CSP mal aplicada, backend caído, blob corrupto, etc.),
                      // Sentry se entera. Filtramos el 1er evento por id para no
                      // reportar 2 veces el mismo logo (viene duplicado por el
                      // loop del marquee). Debounce simple con Set en memoria.
                      onError={(e) => {
                        if (i >= trustedCompanies.length) return; // set B del loop
                        reportLandingError(new Error('trusted_company_logo_failed'), {
                          section: 'trusted-companies',
                          logo_id: c.id,
                          logo_nombre: c.nombre,
                          logo_url: e?.target?.src,
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── FAQ ──────────────────────────────────────────── */}
      <section className="s" id="faq" style={{ background: 'var(--bg-2)', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)' }}>
        <div className="wrap">
          <div className="s-head center">
            <div className="s-kicker">Preguntas frecuentes</div>
            <h2 className="s-title">Lo que todos preguntan</h2>
          </div>
          {/* 2026-07-13 Fase 3: FAQ dinámica desde CMS. Si el admin no cargó
              nada, se usa FALLBACK_FAQ (los 6 defaults del diseño original).
              El primer item se abre por default (patrón <details open>). */}
          <div className="faq">
            {faq.map((q, i) => (
              <details key={q.id || `faq-${i}`} className="qa" open={i === 0}>
                <summary>{q.question}
                  <svg className="pm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                </summary>
                <div className="a">{q.answer}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA FINAL ────────────────────────────────────── */}
      <section className="s">
        <div className="wrap">
          <div className="cta-final">
            {/* 2026-07-13 Fase 3: CTA final dinámico desde CMS. */}
            <h2>{cta.headline}</h2>
            <p>{cta.body}</p>
            <div className="hero-actions">
              <Link to="/signup" className="btn btn-primary btn-lg"
                    onClick={() => trackEvent('cta_click', { location: 'cta-final', target: 'signup' })}>
                Empezá gratis
              </Link>
              {/* 2026-06-25 ONB-8 → Calendly: era mailto: como fallback temporal.
                  Ahora abre el booking de Calendly con utm_campaign=cta-final
                  para que sepamos si la sección final convierte más que el CTA
                  del nav (insight para iterar copy/posicionamiento). */}
              <a
                href={calendlyHref('cta-final')}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-lg"
                onClick={() => trackEvent('cta_click', { location: 'cta-final', target: 'demo' })}
              >
                Agendá una demo
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── CONTACTO (2026-07-13) ────────────────────────── */}
      {/* Sección editable desde admin.tecnyapp.com/sitio-publico (CMS Fase 1).
          Los datos vienen del fetch a /api/public/site-config arriba —
          fallback hardcodeado si el backend no responde. El link "Contacto"
          del footer scrollea acá (antes era SoonLink, cf. #441).

          Placement decision 2026-07-13 (Lucas): DESPUÉS del CTA final.
          Rationale: el CTA "Ordená tu negocio hoy" es el pico de conversión —
          va sin nada abajo compitiendo. Contacto acá funciona como "escape
          hatch" para el visitor que scrolleó todo pero no cliqueó — última
          chance de captarlo por WhatsApp/Email/IG. Convención SaaS
          (Notion, Linear, Stripe, etc.). */}
      <section className="s" id="contacto">
        <div className="wrap">
          <div className="s-head center">
            <div className="s-kicker">Contacto</div>
            <h2 className="s-title">Hablá con nosotros</h2>
            <p className="s-sub">
              ¿Dudas antes de arrancar? ¿Necesitás algo específico para tu negocio?
              Escribinos por el canal que prefieras — respondemos en el día.
            </p>
          </div>
          <div className="contact-grid">
            {/* WhatsApp — canal preferido para consultas comerciales en AR */}
            <a
              href={buildWaLink(contact.whatsapp, 'Hola! Me interesa Tecny. ¿Me pueden contar más?')}
              target="_blank"
              rel="noopener noreferrer"
              className="contact-card"
            >
              <div className="contact-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.966-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.226 1.36.194 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                </svg>
              </div>
              <div className="contact-body">
                <div className="contact-label">WhatsApp</div>
                <div className="contact-value">{contact.whatsapp_display}</div>
                <div className="contact-hint">Respondemos en el día</div>
              </div>
            </a>

            {/* Email — canal formal, útil para adjuntos o propuestas */}
            <a href={`mailto:${contact.email}`} className="contact-card">
              <div className="contact-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
              </div>
              <div className="contact-body">
                <div className="contact-label">Email</div>
                <div className="contact-value">{contact.email}</div>
                <div className="contact-hint">Ideal para propuestas</div>
              </div>
            </a>

            {/* Instagram — canal social, ver contenido reciente + productos */}
            <a
              href={contact.instagram_url}
              target="_blank"
              rel="noopener noreferrer"
              className="contact-card"
            >
              <div className="contact-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                </svg>
              </div>
              <div className="contact-body">
                <div className="contact-label">Instagram</div>
                <div className="contact-value">@{contact.instagram_handle}</div>
                <div className="contact-hint">Novedades del producto</div>
              </div>
            </a>

            {/* Ubicación — info-only, no es clickeable. */}
            <div className="contact-card contact-card-info" aria-label="Ubicación">
              <div className="contact-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
              </div>
              <div className="contact-body">
                <div className="contact-label">Ubicación</div>
                <div className="contact-value">{contact.address}</div>
                <div className="contact-hint">Reuniones a coordinar</div>
              </div>
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
              {/* #441: "Clientes" linkeaba a #testimonios — anchor removido
                  porque la sección era fake. Cuando tengamos testimonios
                  reales, restaurar tanto la sección como el link. */}
              {/* 2026-07-13: Contacto ya no es "próximamente" — activado tras
                  la CMS Fase 1 (email + WhatsApp + IG + address editables desde
                  admin). Sección #contacto renderizada arriba del CTA final. */}
              <a href="#contacto">Contacto</a>
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
            {/* #441: removido "Tech Reseller" del crédito — era un nombre
                inventado de la franja de logos fake.
                2026-07-17: Lucas pidió sacar "Celnyx" también — el crédito
                queda solo con la marca del producto (Tecny) + ubicación. */}
            <div className="cr">© 2026 Tecny · Buenos Aires, Argentina</div>
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
