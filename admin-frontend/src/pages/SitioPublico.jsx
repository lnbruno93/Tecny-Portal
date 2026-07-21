// Pantalla Sitio Público — editar contenido dinámico de la landing
// tecnyapp.com desde el admin.
//
// Backend: GET/PATCH /api/super-admin/site-config (persisten en
// site_landing_config singleton). La landing pública consume
// GET /api/public/site-config con cache 5min HTTP + client-side.
//
// Secciones:
//   · Fase 1 (2026-07-13): Contacto (mail, WhatsApp, dirección, Instagram).
//   · Fase 2 (2026-07-13): Reseñas / testimonios editables.
//   · Fase 3 (futuro): Footer (Empresa, Legal, Redes).
//
// Diff-tracking: solo se envían los campos que cambiaron respecto al
// original. Testimonials es un array — se envía completo si cambió cualquier
// item (semántica "PUT sobre el field").

import { useEffect, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, PageHead } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import { fmtDateTime } from '../lib/format.js';
// 2026-07-18 CMS Landing Fase 4: card "Empresas que confiaron en Tecny".
// Componente aparte porque tiene CRUD granular row-by-row (no comparte el
// diff-tracking de esta pantalla) y encapsula el modal de upload.
import TrustedCompaniesCard from '../components/TrustedCompaniesCard.jsx';

// Campos de contacto en el orden que el operador espera verlos en el form.
const CONTACT_FIELDS = [
  { key: 'contact_email',            label: 'Email de contacto', placeholder: 'hola@tecnyapp.com', type: 'email',
    hint: 'Aparece en la sección Contacto de la landing.' },
  { key: 'contact_whatsapp',         label: 'WhatsApp (solo dígitos)', placeholder: '5491126165007', type: 'text', pattern: '\\d{8,15}',
    hint: 'Sin +, sin espacios ni guiones. Se usa para el link wa.me/*.' },
  { key: 'contact_whatsapp_display', label: 'WhatsApp (formato visible)', placeholder: '+54 9 11 2616-5007', type: 'text',
    hint: 'Cómo se muestra al usuario en la landing.' },
  { key: 'contact_address',          label: 'Dirección / ubicación', placeholder: 'Av. del Libertador 6299, Buenos Aires', type: 'text',
    hint: 'Texto libre. Aparece en la card de Contacto y en el footer.' },
  { key: 'contact_instagram_handle', label: 'Instagram (handle sin @)', placeholder: 'tecny.app', type: 'text',
    hint: 'Solo el nombre, sin @. Ej: tecny.app' },
  { key: 'contact_instagram_url',    label: 'Instagram (URL completa)', placeholder: 'https://instagram.com/tecny.app', type: 'url',
    hint: 'Link al perfil. Se usa en los botones de "Seguinos".' },
];

// Paleta de colores para el avatar de un testimonial. Google-style — combina
// bien con el diseño oscuro de la landing.
const AVATAR_COLORS = ['#4285F4', '#EA4335', '#FBBC04', '#34A853', '#9C27B0', '#00ACC1', '#FF7043', '#8E24AA'];

const EMPTY_CONTACT = CONTACT_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: '' }), {});

// 2026-07-13 CMS Fase 3: campos de Hero — headline, subheadline, blurb.
// Placeholders son los valores actuales hardcodeados en Landing.jsx (para
// que el operador vea qué está sobrescribiendo y qué queda como fallback).
const HERO_FIELDS = [
  { key: 'hero_headline',    label: 'Título principal (Hero headline)',
    placeholder: 'Todo tu negocio, en una sola pantalla.', type: 'text', maxLength: 100,
    hint: 'El título grande arriba. Vacío → usa el default de la landing. Máx 100 chars.' },
  { key: 'hero_subheadline', label: 'Subtítulo (Hero subheadline)',
    placeholder: 'El sistema para revendedores de tecnología.', type: 'text', maxLength: 120,
    hint: 'Debajo del título. Máx 120 chars.' },
  { key: 'hero_blurb',       label: 'Descripción (Hero blurb)',
    placeholder: 'Cotizaciones, comprobantes, cuentas corrientes, envíos y caja — para equipos que...',
    type: 'textarea', maxLength: 400,
    hint: 'Párrafo descriptivo. Máx 400 chars.' },
];
const EMPTY_HERO = HERO_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: '' }), {});

// 2026-07-13 CMS Fase 3: campos de CTA final.
const CTA_FIELDS = [
  { key: 'cta_headline', label: 'Título del CTA',
    placeholder: 'Ordená tu negocio hoy', type: 'text', maxLength: 80,
    hint: 'El título grande del bloque final antes del footer. Máx 80 chars.' },
  { key: 'cta_body',     label: 'Descripción del CTA',
    placeholder: 'Sumate a los equipos que ya dejaron las planillas atrás...',
    type: 'textarea', maxLength: 250,
    hint: 'Subtítulo bajo el título del CTA. Máx 250 chars.' },
];
const EMPTY_CTA = CTA_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: '' }), {});

function sameFaq(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}
function emptyFaq() {
  return { _tempId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
           question: '', answer: '' };
}

// Deep-equal chico para arrays de testimonials (comparación por serialización).
// Suficiente para el diff-tracking: 50 items × ~500 chars = ~25kB, JSON.stringify
// es sub-ms en esa escala.
function sameTestimonials(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

// Un testimonial vacío para el botón "Agregar reseña".
function emptyTestimonial() {
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  return { _tempId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
           name: '', initial: '', color, time: '', text: '' };
}

export default function SitioPublico() {
  const [contact, setContact]                 = useState(EMPTY_CONTACT);
  const [contactOriginal, setContactOriginal] = useState(EMPTY_CONTACT);
  const [testimonials, setTestimonials]                 = useState([]);
  const [testimonialsOriginal, setTestimonialsOriginal] = useState([]);
  // 2026-07-13 Toggle Google Business Profile: enabled/disabled. Trackeamos
  // original separado para dirty-detection y descartar changes.
  const [googleEnabled, setGoogleEnabled]                 = useState(true);
  const [googleEnabledOriginal, setGoogleEnabledOriginal] = useState(true);
  // Status live del cache backend (count, rating, cached_at). Se carga en
  // paralelo con el config — si falla no rompe la página (card muestra fallback).
  const [googleStatus, setGoogleStatus]     = useState(null);
  const [copyMsg, setCopyMsg]               = useState(null);
  // 2026-07-13 Fase 3: hero + cta como grupos de campos texto (mismo patrón
  // que contact), y faq como array editable (mismo patrón que testimonials).
  const [hero, setHero]                 = useState(EMPTY_HERO);
  const [heroOriginal, setHeroOriginal] = useState(EMPTY_HERO);
  const [cta, setCta]                   = useState(EMPTY_CTA);
  const [ctaOriginal, setCtaOriginal]   = useState(EMPTY_CTA);
  const [faq, setFaq]                   = useState([]);
  const [faqOriginal, setFaqOriginal]   = useState([]);
  const [meta, setMeta]         = useState({ updated_at: null });
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [savedMsg, setSavedMsg] = useState(null);
  const [error, setError]       = useState(null);

  async function cargar() {
    try {
      setLoading(true);
      const row = await adminApi.getSiteConfig();
      const nContact = CONTACT_FIELDS.reduce((acc, f) => {
        acc[f.key] = row?.[f.key] ?? '';
        return acc;
      }, {});
      setContact(nContact);
      setContactOriginal(nContact);
      const nTest = Array.isArray(row?.testimonials) ? row.testimonials : [];
      setTestimonials(nTest);
      setTestimonialsOriginal(nTest);
      // 2026-07-13: default true — si la row está pre-migration, tratamos
      // como enabled para no ocultar reseñas de Google por accidente.
      const nEnabled = row?.google_reviews_enabled !== false;
      setGoogleEnabled(nEnabled);
      setGoogleEnabledOriginal(nEnabled);
      // 2026-07-13 Fase 3: cargar hero + cta + faq. Null → '' para inputs.
      const nHero = HERO_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: row?.[f.key] ?? '' }), {});
      setHero(nHero);
      setHeroOriginal(nHero);
      const nCta = CTA_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: row?.[f.key] ?? '' }), {});
      setCta(nCta);
      setCtaOriginal(nCta);
      const nFaq = Array.isArray(row?.faq) ? row.faq : [];
      setFaq(nFaq);
      setFaqOriginal(nFaq);
      setMeta({ updated_at: row?.updated_at || null });

      // Cargar status en paralelo — no bloquea si falla (feature no crítica).
      try {
        const status = await adminApi.getGoogleReviewsStatus();
        setGoogleStatus(status);
      } catch { /* silent — la card muestra fallback "sin datos" */ }
    } catch (e) {
      setError(e.message || 'No se pudo cargar la config');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { cargar(); }, []);

  // Dirty state combinado (contacto + reseñas + toggle Google + hero + cta + faq).
  const dirtyContactKeys = CONTACT_FIELDS
    .map(f => f.key)
    .filter(k => (contact[k] || '') !== (contactOriginal[k] || ''));
  const dirtyHeroKeys = HERO_FIELDS
    .map(f => f.key)
    .filter(k => (hero[k] || '') !== (heroOriginal[k] || ''));
  const dirtyCtaKeys = CTA_FIELDS
    .map(f => f.key)
    .filter(k => (cta[k] || '') !== (ctaOriginal[k] || ''));
  const testimonialsDirty = !sameTestimonials(testimonials, testimonialsOriginal);
  const faqDirty = !sameFaq(faq, faqOriginal);
  const googleEnabledDirty = googleEnabled !== googleEnabledOriginal;
  const isDirty = dirtyContactKeys.length > 0
    || dirtyHeroKeys.length > 0
    || dirtyCtaKeys.length > 0
    || testimonialsDirty
    || faqDirty
    || googleEnabledDirty;
  const totalChanges = dirtyContactKeys.length
    + dirtyHeroKeys.length
    + dirtyCtaKeys.length
    + (testimonialsDirty ? 1 : 0)
    + (faqDirty ? 1 : 0)
    + (googleEnabledDirty ? 1 : 0);

  async function guardar() {
    if (!isDirty) return;
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const patch = {};
      for (const k of dirtyContactKeys) patch[k] = contact[k];
      for (const k of dirtyHeroKeys)    patch[k] = hero[k];
      for (const k of dirtyCtaKeys)     patch[k] = cta[k];
      if (testimonialsDirty) {
        // Sanitizar: strip claves internas de UI (_tempId) antes de enviar.
        patch.testimonials = testimonials.map(t => {
          const { _tempId, ...clean } = t;
          return clean;
        });
      }
      if (faqDirty) {
        patch.faq = faq.map(q => {
          const { _tempId, ...clean } = q;
          return clean;
        });
      }
      if (googleEnabledDirty) patch.google_reviews_enabled = googleEnabled;
      const updated = await adminApi.updateSiteConfig(patch);
      const nContact = CONTACT_FIELDS.reduce((acc, f) => {
        acc[f.key] = updated?.[f.key] ?? '';
        return acc;
      }, {});
      setContact(nContact);
      setContactOriginal(nContact);
      const nTest = Array.isArray(updated?.testimonials) ? updated.testimonials : [];
      setTestimonials(nTest);
      setTestimonialsOriginal(nTest);
      const nEnabled = updated?.google_reviews_enabled !== false;
      setGoogleEnabled(nEnabled);
      setGoogleEnabledOriginal(nEnabled);
      // 2026-07-13 Fase 3: refresh hero/cta/faq desde el response.
      const nHero = HERO_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: updated?.[f.key] ?? '' }), {});
      setHero(nHero);
      setHeroOriginal(nHero);
      const nCta = CTA_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: updated?.[f.key] ?? '' }), {});
      setCta(nCta);
      setCtaOriginal(nCta);
      const nFaq = Array.isArray(updated?.faq) ? updated.faq : [];
      setFaq(nFaq);
      setFaqOriginal(nFaq);
      setMeta({ updated_at: updated?.updated_at || null });
      setSavedMsg('Guardado. Los cambios aparecen en tecnyapp.com en máx. 5 minutos.');
      setTimeout(() => setSavedMsg(null), 6000);
    } catch (e) {
      let msg = e.message || 'Error al guardar';
      if (e.responseBody?.fields) {
        // El backend Zod devuelve fields como array de {field, error} o objeto.
        const f = e.responseBody.fields;
        if (Array.isArray(f) && f.length > 0) {
          msg = `${f[0].field}: ${f[0].error}`;
        } else if (typeof f === 'object') {
          const first = Object.keys(f)[0];
          msg = `${first}: ${f[first]}`;
        }
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  function descartar() {
    setContact(contactOriginal);
    setTestimonials(testimonialsOriginal);
    setGoogleEnabled(googleEnabledOriginal);
    setHero(heroOriginal);
    setCta(ctaOriginal);
    setFaq(faqOriginal);
    setError(null);
  }

  // FAQ ops — mismo patrón que testimonials (mutan array local, diff-tracking se encarga).
  function addFaq()                        { setFaq(f => [...f, emptyFaq()]); }
  function updateFaq(idx, key, value)      { setFaq(f => f.map((it, i) => i === idx ? { ...it, [key]: value } : it)); }
  function removeFaq(idx)                  { setFaq(f => f.filter((_, i) => i !== idx)); }
  function moveFaq(idx, dir) {
    setFaq(f => {
      const next = [...f];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return f;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  // Copiar link "escribir reseña" al clipboard — el mismo que Google usa para
  // que un cliente deje una review sin fricción. `placeid=` es query param
  // documentado de search.google.com/local/writereview.
  async function copyReviewLink() {
    const placeId = googleStatus?.place_id;
    if (!placeId) return;
    const url = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyMsg('¡Link copiado! Compartilo con tus clientes por WhatsApp.');
      setTimeout(() => setCopyMsg(null), 4000);
    } catch {
      setCopyMsg('No se pudo copiar. Copiá manual: ' + url);
      setTimeout(() => setCopyMsg(null), 8000);
    }
  }

  // Testimonial ops — mutan el array local, el diff-tracking se encarga.
  function addTestimonial() {
    setTestimonials(t => [...t, emptyTestimonial()]);
  }
  function updateTestimonial(idx, key, value) {
    setTestimonials(t => t.map((item, i) => i === idx ? { ...item, [key]: value } : item));
  }
  function removeTestimonial(idx) {
    setTestimonials(t => t.filter((_, i) => i !== idx));
  }
  function moveTestimonial(idx, dir) {
    setTestimonials(t => {
      const next = [...t];
      const swapWith = idx + dir;
      if (swapWith < 0 || swapWith >= next.length) return t;
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next;
    });
  }

  return (
    <div className="page">
      <PageHead
        label="Sitio público"
        title="Landing tecnyapp.com"
        subtitle="Editá Contacto y Reseñas. Los cambios aparecen en la landing en máx. 5 minutos (cache HTTP)."
        actions={
          isDirty && (
            <div className="u-flex-gap-8">
              <Btn variant="ghost" onClick={descartar} disabled={saving}>
                Descartar
              </Btn>
              <Btn onClick={guardar} disabled={saving}>
                {saving ? 'Guardando…' : `Guardar (${totalChanges})`}
              </Btn>
            </div>
          )
        }
      />

      {loading ? (
        <div className="muted u-p-32-text-center">Cargando…</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* ── SECCIÓN CONTACTO ── */}
          <Card>
            <div className="u-p-20-grid-gap-16">
              <div>
                <h3 className="u-m-0-fs-16-fw-600">Sección Contacto</h3>
                <p className="muted u-m-4-0-0-fs-13">
                  Datos que aparecen en la landing pública.
                </p>
              </div>

              {CONTACT_FIELDS.map(f => {
                const changed = (contact[f.key] || '') !== (contactOriginal[f.key] || '');
                return (
                  <div key={f.key} className="field">
                    <label className="field-label u-flex-center-gap-8" htmlFor={`sc-${f.key}`}>
                      {f.label}
                      {changed && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                       borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                          MODIFICADO
                        </span>
                      )}
                    </label>
                    <input id={`sc-${f.key}`} type={f.type} className="input"
                           placeholder={f.placeholder} pattern={f.pattern}
                           value={contact[f.key]}
                           onChange={e => setContact(x => ({ ...x, [f.key]: e.target.value }))}
                           disabled={saving} className="u-w-100" />
                    {f.hint && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{f.hint}</div>}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── SECCIÓN HERO (Fase 3) ── */}
          <Card>
            <div className="u-p-20-grid-gap-16">
              <div>
                <h3 className="u-modal-title">
                  Hero (top de la landing)
                  {dirtyHeroKeys.length > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                   borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                      {dirtyHeroKeys.length} MODIFICADO{dirtyHeroKeys.length > 1 ? 'S' : ''}
                    </span>
                  )}
                </h3>
                <p className="muted u-m-4-0-0-fs-13">
                  Título grande + subtítulo + descripción arriba de todo. Vacío → landing usa el default.
                </p>
              </div>
              {HERO_FIELDS.map(f => {
                const changed = (hero[f.key] || '') !== (heroOriginal[f.key] || '');
                return (
                  <div key={f.key} className="field">
                    <label className="field-label u-flex-center-gap-8" htmlFor={`sc-${f.key}`}>
                      {f.label}
                      {changed && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                       borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                          MODIFICADO
                        </span>
                      )}
                    </label>
                    {f.type === 'textarea' ? (
                      <textarea id={`sc-${f.key}`} className="input" rows={3} maxLength={f.maxLength}
                                placeholder={f.placeholder} value={hero[f.key]}
                                onChange={e => setHero(x => ({ ...x, [f.key]: e.target.value }))}
                                disabled={saving} className="u-w-100-resize-v" />
                    ) : (
                      <input id={`sc-${f.key}`} type={f.type} className="input" maxLength={f.maxLength}
                             placeholder={f.placeholder} value={hero[f.key]}
                             onChange={e => setHero(x => ({ ...x, [f.key]: e.target.value }))}
                             disabled={saving} className="u-w-100" />
                    )}
                    <div className="muted u-fs-11-mt-4-flex-between">
                      <span>{f.hint}</span>
                      <span>{(hero[f.key] || '').length} / {f.maxLength}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── SECCIÓN CTA FINAL (Fase 3) ── */}
          <Card>
            <div className="u-p-20-grid-gap-16">
              <div>
                <h3 className="u-modal-title">
                  CTA final
                  {dirtyCtaKeys.length > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                   borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                      {dirtyCtaKeys.length} MODIFICADO{dirtyCtaKeys.length > 1 ? 'S' : ''}
                    </span>
                  )}
                </h3>
                <p className="muted u-m-4-0-0-fs-13">
                  Bloque de conversión antes del footer. Máxima visibilidad del CTA "Empezá gratis".
                </p>
              </div>
              {CTA_FIELDS.map(f => {
                const changed = (cta[f.key] || '') !== (ctaOriginal[f.key] || '');
                return (
                  <div key={f.key} className="field">
                    <label className="field-label u-flex-center-gap-8" htmlFor={`sc-${f.key}`}>
                      {f.label}
                      {changed && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                       borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                          MODIFICADO
                        </span>
                      )}
                    </label>
                    {f.type === 'textarea' ? (
                      <textarea id={`sc-${f.key}`} className="input" rows={2} maxLength={f.maxLength}
                                placeholder={f.placeholder} value={cta[f.key]}
                                onChange={e => setCta(x => ({ ...x, [f.key]: e.target.value }))}
                                disabled={saving} className="u-w-100-resize-v" />
                    ) : (
                      <input id={`sc-${f.key}`} type={f.type} className="input" maxLength={f.maxLength}
                             placeholder={f.placeholder} value={cta[f.key]}
                             onChange={e => setCta(x => ({ ...x, [f.key]: e.target.value }))}
                             disabled={saving} className="u-w-100" />
                    )}
                    <div className="muted u-fs-11-mt-4-flex-between">
                      <span>{f.hint}</span>
                      <span>{(cta[f.key] || '').length} / {f.maxLength}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── SECCIÓN FAQ (Fase 3) ── */}
          <Card>
            <div className="u-p-20-grid-gap-16">
              <div className="u-flex-between-start-16">
                <div>
                  <h3 className="u-modal-title">
                    Preguntas frecuentes (FAQ)
                    {faqDirty && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                     borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        MODIFICADO
                      </span>
                    )}
                  </h3>
                  <p className="muted u-m-4-0-0-fs-13">
                    Aparecen en la sección FAQ de la landing. Vacío → landing muestra las 6 default.
                  </p>
                </div>
                <Btn variant="ghost" onClick={addFaq} disabled={saving || faq.length >= 20}>
                  <Icons.Plus size={14} /> Agregar pregunta
                </Btn>
              </div>

              {faq.length === 0 ? (
                <div className="muted" style={{ padding: 16, textAlign: 'center',
                     border: '1px dashed var(--hairline)', borderRadius: 8, fontSize: 13 }}>
                  Todavía no cargaste ninguna pregunta. La landing muestra su set default hardcodeado.
                </div>
              ) : (
                <div className="u-grid-gap-12-nocol">
                  {faq.map((q, idx) => (
                    <div key={q.id || q._tempId} style={{
                      padding: 14, borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'rgba(255,255,255,0.02)',
                      display: 'grid', gap: 10,
                    }}>
                      <div className="u-flex-between-center-nogap">
                        <div className="muted u-fs-12">
                          #{idx + 1} — {q.question ? q.question.slice(0, 60) : 'Sin pregunta'}
                        </div>
                        <div className="u-flex-gap-4">
                          <button type="button" className="icon-btn" onClick={() => moveFaq(idx, -1)}
                                  disabled={saving || idx === 0} title="Subir">▲</button>
                          <button type="button" className="icon-btn" onClick={() => moveFaq(idx, 1)}
                                  disabled={saving || idx === faq.length - 1} title="Bajar">▼</button>
                          <button type="button" className="icon-btn" onClick={() => removeFaq(idx)}
                                  disabled={saving} title="Eliminar">
                            <Icons.Trash size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="field">
                        <div className="muted tiny u-mb-2">Pregunta</div>
                        <input className="input" maxLength={200}
                               placeholder="Ej. ¿Necesito instalar algo?"
                               value={q.question} disabled={saving}
                               onChange={e => updateFaq(idx, 'question', e.target.value)} />
                      </div>
                      <div className="field">
                        <div className="muted tiny u-mb-2">Respuesta</div>
                        <textarea className="input" rows={3} maxLength={1000}
                                  placeholder="Ej. No. Tecny funciona desde el navegador..."
                                  value={q.answer} disabled={saving}
                                  onChange={e => updateFaq(idx, 'answer', e.target.value)}
                                  className="u-w-100-resize-v" />
                        <div className="muted tiny u-mt-2-td-right">
                          {(q.answer || '').length} / 1000
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* ── SECCIÓN GOOGLE REVIEWS ── */}
          <Card>
            <div className="u-p-20-grid-gap-16">
              <div className="u-flex-between-start-16-wrap">
                <div>
                  <h3 className="u-modal-title">
                    Reseñas de Google
                    {googleEnabledDirty && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                     borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        MODIFICADO
                      </span>
                    )}
                  </h3>
                  <p className="muted u-m-4-0-0-fs-13">
                    Integración con Google Business Profile. Las reseñas reales aparecen arriba
                    de las manuales cuando hay 3 o más en Google.
                  </p>
                </div>
                {/* Status chip */}
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                  background: googleEnabled ? 'rgba(16, 185, 129, 0.1)' : 'rgba(148, 163, 184, 0.1)',
                  border: `1px solid ${googleEnabled ? 'rgba(16, 185, 129, 0.3)' : 'rgba(148, 163, 184, 0.3)'}`,
                  color: googleEnabled ? 'var(--pos)' : 'var(--muted)',
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: googleEnabled ? 'var(--pos)' : 'var(--muted)',
                  }} />
                  {googleEnabled ? 'Conectado' : 'Pausado'}
                </div>
              </div>

              {/* Info de la integración (place_id, count, cached_at) */}
              {googleStatus?.configured ? (
                <div style={{ display: 'grid', gap: 8, padding: 12,
                              borderRadius: 6, background: 'rgba(255,255,255,0.02)',
                              border: '1px solid var(--hairline)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    <div>
                      <div className="muted tiny u-mb-2">Reseñas en Google</div>
                      <div className="u-fs-16-fw-600">
                        {googleStatus.count > 0 ? googleStatus.count : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="muted tiny u-mb-2">Rating agregado</div>
                      <div className="u-fs-16-fw-600">
                        {typeof googleStatus.rating === 'number' ? googleStatus.rating.toFixed(1) + ' ★' : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="muted tiny u-mb-2">Última carga</div>
                      <div className="u-fs-13">
                        {googleStatus.cached_at ? fmtDateTime(googleStatus.cached_at) : '—'}
                      </div>
                    </div>
                  </div>
                  {googleStatus.place_id && (
                    <div style={{ paddingTop: 8, borderTop: '1px solid var(--hairline)',
                                  display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <a href={`https://www.google.com/maps/place/?q=place_id:${googleStatus.place_id}`}
                         target="_blank" rel="noopener noreferrer"
                         style={{ fontSize: 12, color: 'var(--accent)' }}>
                        Ver listing en Google Maps →
                      </a>
                      <button type="button" onClick={copyReviewLink}
                              style={{ background: 'none', border: 'none', padding: 0,
                                       fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>
                        📋 Copiar link para pedir reseñas
                      </button>
                    </div>
                  )}
                  {googleStatus.error && (
                    <div className="muted tiny u-color-warn-hex">
                      ⚠ Último fetch falló: {googleStatus.error} (fallback usa reseñas manuales)
                    </div>
                  )}
                </div>
              ) : (
                <div className="muted" style={{ padding: 12, textAlign: 'center', fontSize: 12,
                     border: '1px dashed var(--hairline)', borderRadius: 6 }}>
                  {googleStatus === null
                    ? 'Cargando estado…'
                    : 'Integración no configurada (faltan env vars GOOGLE_PLACES_API_KEY / PLACE_ID en Railway).'}
                </div>
              )}

              {/* Toggle */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                              padding: 12, borderRadius: 6,
                              background: 'rgba(255,255,255,0.02)',
                              border: '1px solid var(--hairline)' }}>
                <input type="checkbox" checked={googleEnabled} disabled={saving}
                       onChange={e => setGoogleEnabled(e.target.checked)}
                       className="u-mt-2" />
                <div>
                  <div className="u-fs-13-fw-600">
                    Mostrar reseñas de Google en la landing
                  </div>
                  <div className="muted u-fs-11-mt-2">
                    Si lo desactivás, el backend deja de consultar a Google (ahorra API quota)
                    y la landing muestra solo las reseñas manuales de abajo. Reversible en cualquier
                    momento.
                  </div>
                </div>
              </label>

              {copyMsg && (
                <div className="muted" style={{ fontSize: 11, color: 'var(--pos)', textAlign: 'center' }}>
                  {copyMsg}
                </div>
              )}
            </div>
          </Card>

          {/* ── SECCIÓN RESEÑAS (Fase 2) ── */}
          <Card>
            <div className="u-p-20-grid-gap-16">
              <div className="u-flex-between-start-16">
                <div>
                  <h3 className="u-m-0-fs-16-fw-600">
                    Reseñas de clientes
                    {testimonialsDirty && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', marginLeft: 8,
                                     borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        MODIFICADO
                      </span>
                    )}
                  </h3>
                  <p className="muted u-m-4-0-0-fs-13">
                    Aparecen en la sección &quot;Opiniones&quot; de la landing.
                    {testimonials.length === 0 && ' Si dejás la lista vacía, la landing muestra su set default.'}
                  </p>
                </div>
                <Btn variant="ghost" onClick={addTestimonial} disabled={saving || testimonials.length >= 50}>
                  <Icons.Plus size={14} /> Agregar reseña
                </Btn>
              </div>

              {testimonials.length === 0 ? (
                <div className="muted" style={{ padding: 16, textAlign: 'center',
                     border: '1px dashed var(--hairline)', borderRadius: 8, fontSize: 13 }}>
                  Todavía no cargaste ninguna reseña. La landing muestra su set default hardcodeado.
                </div>
              ) : (
                <div className="u-grid-gap-12-nocol">
                  {testimonials.map((t, idx) => (
                    <div key={t.id || t._tempId} style={{
                      padding: 14, borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'rgba(255,255,255,0.02)',
                      display: 'grid', gap: 10,
                    }}>
                      {/* Header: avatar preview + acciones */}
                      <div className="u-flex-between-center-nogap">
                        <div className="u-flex-center-gap-10">
                          <div style={{
                            width: 32, height: 32, borderRadius: '50%',
                            background: t.color || '#4285F4', color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 700, fontSize: 14,
                          }}>
                            {(t.initial || '?').toUpperCase()}
                          </div>
                          <div className="muted u-fs-12">
                            #{idx + 1} — {t.name || 'Sin nombre'}
                          </div>
                        </div>
                        <div className="u-flex-gap-4">
                          <button type="button" className="icon-btn" onClick={() => moveTestimonial(idx, -1)}
                                  disabled={saving || idx === 0} title="Subir">▲</button>
                          <button type="button" className="icon-btn" onClick={() => moveTestimonial(idx, 1)}
                                  disabled={saving || idx === testimonials.length - 1} title="Bajar">▼</button>
                          <button type="button" className="icon-btn" onClick={() => removeTestimonial(idx)}
                                  disabled={saving} title="Eliminar">
                            <Icons.Trash size={14} />
                          </button>
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr', gap: 8 }}>
                        <div className="field">
                          <div className="muted tiny u-mb-2">Nombre</div>
                          <input className="input" placeholder="Ej. Tomás R."
                                 value={t.name} disabled={saving}
                                 onChange={e => updateTestimonial(idx, 'name', e.target.value)} />
                        </div>
                        <div className="field">
                          <div className="muted tiny u-mb-2">Inicial (1-2 chars)</div>
                          <input className="input mono" maxLength={2} placeholder="T"
                                 value={t.initial} disabled={saving}
                                 onChange={e => updateTestimonial(idx, 'initial', e.target.value.toUpperCase())} />
                        </div>
                        <div className="field">
                          <div className="muted tiny u-mb-2">Color</div>
                          <input type="color" className="input" style={{ padding: 2, height: 32 }}
                                 value={t.color || '#4285F4'} disabled={saving}
                                 onChange={e => updateTestimonial(idx, 'color', e.target.value)} />
                        </div>
                        <div className="field">
                          <div className="muted tiny u-mb-2">Tiempo</div>
                          <input className="input" placeholder="hace 3 días"
                                 value={t.time} disabled={saving}
                                 onChange={e => updateTestimonial(idx, 'time', e.target.value)} />
                        </div>
                      </div>

                      <div className="field">
                        <div className="muted tiny u-mb-2">Texto del testimonio</div>
                        <textarea className="input" rows={3} maxLength={1000}
                                  placeholder="Ej. Excelente atención, me atendieron por WhatsApp rápidamente y coordiné la visita el mismo día."
                                  value={t.text} disabled={saving}
                                  onChange={e => updateTestimonial(idx, 'text', e.target.value)}
                                  className="u-w-100-resize-v" />
                        <div className="muted tiny u-mt-2-td-right">
                          {t.text.length} / 1000
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* ── SECCIÓN EMPRESAS QUE CONFIARON (Fase 4, 2026-07-18) ──
              Card autónoma con su propio CRUD granular row-by-row.
              Renderiza sus propios mensajes de éxito/error internamente. */}
          <TrustedCompaniesCard />

          {/* Mensajes de estado (compartidos entre Contacto + Reseñas) */}
          {error && (
            <div role="alert" style={{
              padding: 10, borderRadius: 6, fontSize: 13,
              background: 'rgba(220, 38, 38, 0.08)',
              border: '1px solid rgba(220, 38, 38, 0.3)',
              color: 'var(--neg)',
            }}>
              {error}
            </div>
          )}
          {savedMsg && (
            <div role="status" style={{
              padding: 10, borderRadius: 6, fontSize: 13,
              background: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: 'var(--pos)',
            }}>
              {savedMsg}
            </div>
          )}

          {meta.updated_at && (
            <div className="muted" style={{ fontSize: 12, textAlign: 'right' }}>
              Última edición: {fmtDateTime(meta.updated_at)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
