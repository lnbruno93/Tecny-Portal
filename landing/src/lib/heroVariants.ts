/**
 * heroVariants.ts — variantes de mensaje del hero para message match con
 * anuncios Meta ADS.
 *
 * Estrategia:
 *   1. El HTML server-render lleva la variante DEFAULT (para SEO — Google
 *      indexea el mensaje genérico, no las variantes de ADS que confunden).
 *   2. En client-side, si el URL tiene `?utm_campaign=starter|pro|enterprise`
 *      un script swappea el eyebrow + headline + blurb del hero por la
 *      variante correspondiente.
 *   3. El mismo pattern se aplica al CTA final (`applyCtaVariant`).
 *
 * Cliente ideal 3-en-1 (Lucas 2026-07-29): corremos ADS con 3 audiencias
 * segmentadas en Meta, cada una con su copy específico. Problema principal
 * es distinto por segmento:
 *   - Starter (revendedor solo)   → "vivo en WhatsApp y planillas"
 *   - Pro (3-10 vendedores)       → "mis vendedores hacen lo que quieren"
 *   - Enterprise (multi-local)    → "quiero crecer pero la operación me come"
 *
 * Extensible: agregar una key nueva al objeto VARIANTS + emit anuncio Meta
 * con esa `utm_campaign`. Zero code change adicional.
 */

export interface HeroVariant {
  /** Chip pequeño arriba del headline. */
  eyebrow: string;
  /** Título principal (h1). Sin markup — se aplica como textContent. */
  headline: string;
  /** Sub-headline opcional (bold, arriba del blurb). null = oculto. */
  subheadline: string | null;
  /** Párrafo descriptivo. */
  blurb: string;
}

export interface CtaVariant {
  headline: string;
  body: string;
}

/** Variante default — usada en el server render + fallback si no matchea UTM. */
export const DEFAULT_HERO: HeroVariant = {
  eyebrow: 'Creado y pensado por vendedores de tecnología para vendedores de tecnología',
  headline: 'Tu negocio en una sola pantalla - Sin planillas ni WhatsApp caóticos',
  subheadline: null,
  blurb:
    'Cobros, pagos, cotizaciones, envíos, estado de cajas & cuentas corrientes ordenadas. Empezá hoy gratis - sin tarjeta ni compromiso de pago. ¡Ordená tu negocio HOY!',
};

export const DEFAULT_CTA: CtaVariant = {
  headline: 'Empezá gratis. Sin tarjeta, sin compromiso.',
  body: 'En 10 minutos estás cargando tu primer cotización. Si no te sirve, no pagás nada.',
};

/**
 * Mapping UTM_CAMPAIGN → variante.
 *
 * Convención: keys en lowercase, matching literal contra `utm_campaign`
 * (la landing normaliza a lowercase antes de lookup). Si Meta dispara
 * un anuncio con `utm_campaign=Starter` (capitalizada), sigue matcheando.
 */
export const HERO_VARIANTS: Readonly<Record<string, HeroVariant>> = Object.freeze({
  starter: {
    eyebrow: 'Para revendedores independientes',
    headline: 'Dejá el Excel. Ordená tu negocio en 10 minutos.',
    subheadline: null,
    blurb:
      'Cotizás, cobrás y llevás la caja desde una sola pantalla. El primer sistema pensado para revendedores solos que no quieren pelearse con un ERP corporativo.',
  },
  pro: {
    eyebrow: 'Para equipos con vendedores',
    headline: 'Que tus vendedores vendan. Vos controlá los números.',
    subheadline: null,
    blurb:
      'Permisos por vendedor, saldos en tiempo real, comprobantes con OCR. Sabés siempre quién cobró qué, cuánto te deben, y qué stock queda — sin perseguir a nadie.',
  },
  enterprise: {
    eyebrow: 'Para cadenas y multi-local',
    headline: 'Consolidá varios locales sin planillas.',
    subheadline: null,
    blurb:
      'Saldos, precios y permisos centralizados. Cada local opera con su caja, vos ves el consolidado. Onboarding dedicado y soporte prioritario incluido.',
  },
});

export const CTA_VARIANTS: Readonly<Record<string, CtaVariant>> = Object.freeze({
  starter: {
    headline: 'Empezá hoy. Ordená tu negocio esta semana.',
    body:
      'Sin tarjeta, sin compromiso. En 10 minutos cargás la primer cotización y arrancás a operar prolijo.',
  },
  pro: {
    headline: 'Recuperá el control de tu equipo.',
    body:
      'Sumá a tus vendedores en 15 minutos. Empezás gratis 14 días — sin tarjeta ni migración dolorosa.',
  },
  enterprise: {
    headline: 'Hablemos de tu operación.',
    body:
      'Cadenas con 2+ sucursales tienen onboarding dedicado. Coordinamos una demo con vos y armamos el plan a medida.',
  },
});

/**
 * Lee `?utm_campaign=X` del URL y devuelve la variante hero + cta si matchea.
 * Si no hay match, devuelve `null` (el default queda intacto).
 *
 * Case-insensitive: `Starter`, `STARTER`, `starter` matchean igual.
 */
export function getVariantFromUrl(url: string): { hero: HeroVariant; cta: CtaVariant } | null {
  try {
    const params = new URL(url).searchParams;
    const campaign = (params.get('utm_campaign') || '').trim().toLowerCase();
    if (!campaign) return null;
    const hero = HERO_VARIANTS[campaign];
    const cta = CTA_VARIANTS[campaign];
    if (!hero || !cta) return null;
    return { hero, cta };
  } catch {
    return null;
  }
}
