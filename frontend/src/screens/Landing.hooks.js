/**
 * Landing.hooks.js — hooks extraídos del componente Landing.jsx.
 *
 * Sprint 2 M1 del roadmap post-auditoría (docs/AUDIT_LANDING_2026-07-19.md).
 *
 * Antes había UN useEffect monolítico con 3 fetches paralelos compartiendo
 * el mismo AbortController. Consecuencias:
 *   1. Difícil de testear (imposible aislar el fetch de pricing sin mockear
 *      los otros 2).
 *   2. Bug latente: si un fetch tarda más que otros, el controller lo puede
 *      cancelar antes de que resuelva (no era el caso hoy porque solo el
 *      timeout global de 8s dispara .abort(), pero la coupling era frágil).
 *   3. Difícil de leer: 150 líneas de useEffect con 3 fetches encadenados.
 *
 * Ahora cada hook es independiente:
 *   - Su propio AbortController + timeout.
 *   - Su propio catch con reportLandingError + section específico.
 *   - Retorna el/los estado(s) + un `isReady` boolean.
 *
 * El componente Landing coordina los 3 `isReady` para disparar el evento
 * `landing_content_ready` cuando todos resuelven — via un useEffect chico
 * que reemplaza el contador manual de fetchesDone.
 */

import { useEffect, useState } from 'react';
import { resolveApiBase } from '../lib/api';
import { reportLandingError } from './Landing.analytics';

// Exportado para que Landing.jsx pueda componer URLs de imágenes/assets del
// backend (ej. <img src> del carrusel Empresas) sin duplicar la resolución.
export const BACKEND_BASE = resolveApiBase(import.meta.env.VITE_API_URL);

// Timeout global por fetch — matcheado al anterior (8s). Si el backend no
// responde en ese lapso, el fetch se aborta y quedamos con los defaults.
const FETCH_TIMEOUT_MS = 8000;

// ── FALLBACKS ──────────────────────────────────────────────────────────
// Los mantenemos exportados (Landing.jsx los sigue usando en el JSX).

export const FALLBACK_PRICES = Object.freeze({
  starter: 39,
  pro: 189,
});

export const FALLBACK_CONTACT = Object.freeze({
  email:            'hola@tecnyapp.com',
  whatsapp:         '5491126165007',
  whatsapp_display: '+54 9 11 2616-5007',
  address:          'Buenos Aires, Argentina',
  instagram_handle: 'tecny.app',
  instagram_url:    'https://instagram.com/tecny.app',
});

export const FALLBACK_HERO = Object.freeze({
  headline:    'Todo tu negocio, en una sola pantalla.',
  subheadline: null,
  blurb:       'Cotizaciones, comprobantes, cuentas corrientes, envíos y caja — para equipos que venden tecnología. Dejá las planillas sueltas y los grupos de WhatsApp: Tecny ordena la operación de toda tu mesa de trabajo.',
});

export const FALLBACK_CTA = Object.freeze({
  headline: 'Ordená tu negocio hoy',
  body:     'Sumate a los equipos que ya dejaron las planillas atrás. Empezá gratis y mirá la diferencia en una semana.',
});

// FAQ default: 6 Q&A del diseño original. Se importa desde Landing.jsx via
// export dedicado por su tamaño y para no bloatear este file. Se pasa como
// parámetro al hook para invertir la dependencia (así el hook no importa
// el fallback largo — está en Landing.jsx solamente).

// ── HOOKS ──────────────────────────────────────────────────────────────

/**
 * useLandingPricing — fetch de /api/public/pricing.
 *
 * @returns {{ prices: {starter: number, pro: number}, isReady: boolean }}
 */
export function useLandingPricing() {
  const [prices, setPrices] = useState(FALLBACK_PRICES);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(BACKEND_BASE + '/api/public/pricing', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then((data) => {
        const p = data?.prices;
        if (!p || typeof p !== 'object') return;
        // Validación defensiva: solo actualizamos si los campos críticos son
        // números >= 0. Si llega algo raro (NULL, string, negativo) mantenemos
        // el fallback hardcoded.
        const next = { ...FALLBACK_PRICES };
        if (typeof p.starter === 'number' && p.starter >= 0) next.starter = p.starter;
        if (typeof p.pro === 'number' && p.pro >= 0) next.pro = p.pro;
        setPrices(next);
      })
      .catch((err) => reportLandingError(err, { section: 'pricing' }))
      .finally(() => {
        clearTimeout(timer);
        setIsReady(true);
      });

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return { prices, isReady };
}

/**
 * useLandingCMS — fetch de /api/public/site-config (contact + hero + cta + faq).
 *
 * `defaultFaq` se pasa como parámetro para invertir la dependencia — así el
 * hook no importa el array largo de FAQ que vive en Landing.jsx.
 *
 * @param {Array} defaultFaq - FALLBACK_FAQ del componente Landing.
 * @returns {{
 *   contact, hero, cta, faq, isReady
 * }}
 */
export function useLandingCMS(defaultFaq) {
  const [contact, setContact] = useState(FALLBACK_CONTACT);
  const [hero, setHero] = useState(FALLBACK_HERO);
  const [cta, setCta] = useState(FALLBACK_CTA);
  const [faq, setFaq] = useState(defaultFaq);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(BACKEND_BASE + '/api/public/site-config', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then((data) => {
        const c = data?.contact;
        if (c && typeof c === 'object') {
          // Merge defensivo con el fallback: cualquier campo null/missing
          // en el response mantiene el valor default (evita renderizar "null"
          // en la landing si Lucas dejó un campo vacío en el admin).
          setContact({
            email:            c.email            || FALLBACK_CONTACT.email,
            whatsapp:         c.whatsapp         || FALLBACK_CONTACT.whatsapp,
            whatsapp_display: c.whatsapp_display || FALLBACK_CONTACT.whatsapp_display,
            address:          c.address          || FALLBACK_CONTACT.address,
            instagram_handle: c.instagram_handle || FALLBACK_CONTACT.instagram_handle,
            instagram_url:    c.instagram_url    || FALLBACK_CONTACT.instagram_url,
          });
        }

        // 2026-07-13 Fase 3: hero, cta, faq. Solo campos truthy overriden el
        // fallback — el CMS puede tener parciales (ej. Lucas cambió el
        // headline pero dejó el blurb como default).
        const h = data?.hero;
        if (h && typeof h === 'object') {
          setHero({
            headline:    h.headline    || FALLBACK_HERO.headline,
            subheadline: h.subheadline || FALLBACK_HERO.subheadline,
            blurb:       h.blurb       || FALLBACK_HERO.blurb,
          });
        }
        const ct = data?.cta;
        if (ct && typeof ct === 'object') {
          setCta({
            headline: ct.headline || FALLBACK_CTA.headline,
            body:     ct.body     || FALLBACK_CTA.body,
          });
        }
        // FAQ: si el admin cargó al menos 1, usa los del admin. Si es [],
        // mantiene el fallback de 6 defaults hardcodeados.
        if (Array.isArray(data?.faq) && data.faq.length > 0) {
          setFaq(data.faq);
        }
      })
      .catch((err) => reportLandingError(err, { section: 'site-config' }))
      .finally(() => {
        clearTimeout(timer);
        setIsReady(true);
      });

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return { contact, hero, cta, faq, isReady };
}

/**
 * useTrustedCompanies — fetch de /api/public/trusted-companies.
 *
 * Endpoint separado del site-config para no bloatear el payload con base64/
 * URLs de 30-40 logos. Cache HTTP 5min matchea el resto del CMS.
 *
 * Retorna array vacío si el fetch falla — la sección Empresas se auto-oculta
 * en el JSX (`trustedCompanies.length > 0 && ...`) para cero impacto visible
 * al visitor.
 *
 * @returns {{ trustedCompanies: Array, isReady: boolean }}
 */
export function useTrustedCompanies() {
  const [trustedCompanies, setTrustedCompanies] = useState([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(BACKEND_BASE + '/api/public/trusted-companies', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data?.companies) && data.companies.length > 0) {
          setTrustedCompanies(data.companies);
        }
        // Si viene vacío, mantenemos []: la sección no se renderiza.
      })
      .catch((err) => reportLandingError(err, { section: 'trusted-companies' }))
      .finally(() => {
        clearTimeout(timer);
        setIsReady(true);
      });

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return { trustedCompanies, isReady };
}
