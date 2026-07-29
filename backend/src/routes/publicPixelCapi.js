/**
 * publicPixelCapi.js — Meta Conversions API (CAPI) proxy.
 *
 * Endpoint público que recibe eventos del cliente (landing tecnyapp.com)
 * y los forwardea al Meta Graph API con el CAPI Access Token server-side.
 *
 * ── POR QUÉ EXISTE ────────────────────────────────────────────────────
 * El Meta Pixel client-side pierde ~30% de eventos por:
 *   1. iOS 14 App Tracking Transparency (ATT) — Safari/Chrome iOS suele
 *      bloquear cookies de terceros.
 *   2. Adblockers (uBlock, AdBlock Plus, Brave Shield) — bloquean fbevents.js.
 *   3. Timeouts / navegaciones rápidas antes que el Pixel dispare.
 *
 * CAPI (server-side) cubre esos gaps porque:
 *   - El request va desde nuestro backend, no del browser del user.
 *   - No lo puede bloquear un adblock.
 *   - Runs incluso si el user cierra el tab.
 *
 * DEDUP: cada event_id enviado al Pixel client-side ALSO se envía server-
 * side con el MISMO event_id. Meta dedupea automáticamente por (event_name,
 * event_id) — evita double counting.
 *
 * ── SEGURIDAD ─────────────────────────────────────────────────────────
 * Endpoint PÚBLICO (sin auth), pero:
 *   - Rate limit: 60 req/min/IP (permisivo para uso legítimo, restrictivo
 *     contra abuse spam).
 *   - Payload máximo 4 KB (Meta acepta batch pero acá aceptamos 1 event/req).
 *   - Whitelist de event_name (solo los que la landing puede disparar).
 *   - CAPI token vive en env var `META_CAPI_ACCESS_TOKEN` (Railway),
 *     NUNCA en response.
 *   - Si el token no está seteado, el endpoint responde 200 pero NO envía
 *     a Meta — permite deployar sin token y activarlo después sin cambiar código.
 *
 * ── SCHEMA ────────────────────────────────────────────────────────────
 * POST /api/public/pixel-capi
 * Body:
 *   {
 *     event_name: 'Lead' | 'Schedule' | 'Contact' | 'ViewContent' | 'PageView',
 *     event_id: string (UUID, mismo que Pixel client),
 *     event_time: number (unix seconds, opcional — default now),
 *     custom_data: { content_name?, content_category?, ... } (opcional)
 *   }
 *
 * Response: siempre 200 { ok: true } salvo rate limit (429) o payload
 * inválido (400). NO exponemos errores upstream de Meta — silent-fail para
 * no leakear detalles del token o del setup.
 */

const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const logger = require('../lib/logger');

// ──────────────────────────────────────────────────────────────────────────
// Whitelist de eventos aceptados. Cualquier otro devuelve 400 SIN forwarder
// a Meta — evita que un atacante inyecte eventos custom que pollute los
// reports de Meta ADS Manager.
// ──────────────────────────────────────────────────────────────────────────
const ACCEPTED_EVENTS = new Set([
  'PageView',
  'Lead',
  'Schedule',
  'Contact',
  'ViewContent',
  'CompleteRegistration', // reservado para el flujo signup (F4c futuro)
]);

const MAX_PAYLOAD_BYTES = 4 * 1024; // 4 KB

const PIXEL_ID = process.env.PUBLIC_META_PIXEL_ID || process.env.META_PIXEL_ID || '2418492122007058';
const CAPI_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const CAPI_URL = `https://graph.facebook.com/v18.0/${PIXEL_ID}/events`;

// Rate limit: 60 req/min/IP normalizado a /64 (IPv6-safe, ver comentario
// en app.js:signupLimiter). Landing puede disparar 3-5 eventos por visita
// (PageView + Lead + Contact + Schedule + ViewContent), 60 es holgado
// para uso legítimo mientras bloquea spam.
const capiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'rate-limit' },
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/public/pixel-capi
// ──────────────────────────────────────────────────────────────────────────
router.post('/', capiLimiter, async (req, res) => {
  // Validación básica del payload (defense in depth — el express.json de
  // app.js ya limita a XX KB, pero acá hardcap explícito).
  const { event_name, event_id, event_time, custom_data } = req.body || {};

  if (typeof event_name !== 'string' || !ACCEPTED_EVENTS.has(event_name)) {
    return res.status(400).json({ ok: false, error: 'event_name inválido' });
  }
  if (typeof event_id !== 'string' || event_id.length < 8 || event_id.length > 128) {
    return res.status(400).json({ ok: false, error: 'event_id inválido' });
  }
  const eventTimeUnix = typeof event_time === 'number' && event_time > 0
    ? Math.floor(event_time)
    : Math.floor(Date.now() / 1000);
  const customData = (custom_data && typeof custom_data === 'object') ? custom_data : {};

  // Payload size check (JSON.stringify aproximado).
  if (JSON.stringify(req.body).length > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ ok: false, error: 'payload demasiado grande' });
  }

  // Si CAPI_TOKEN no está seteado (dev local, o Railway sin configurar aún),
  // respondemos 200 pero NO forwardeamos. Permite:
  //   - Landing prod puede disparar CAPI events sin errores 5xx en Sentry.
  //   - Deployar el endpoint antes de que Lucas configure el token.
  //   - Setear el token después sin código cambiar.
  if (!CAPI_TOKEN) {
    return res.json({ ok: true, forwarded: false, reason: 'token no configurado' });
  }

  // Meta CAPI recomienda estos user_data fields cuando disponibles — mejora
  // el matching de eventos (mejores audiencias custom, mejor optimization).
  //
  // fbp/fbc son cookies que el Pixel client-side setea automáticamente.
  // El cliente puede leerlas y enviarlas en el body si quiere mejor matching;
  // si no vienen, Meta hace best-effort matching solo con IP + User-Agent.
  const userData = {
    client_ip_address: req.ip,
    client_user_agent: req.get('User-Agent') || '',
  };
  const bodyFbp = req.body?.fbp;
  const bodyFbc = req.body?.fbc;
  if (typeof bodyFbp === 'string' && bodyFbp.length > 0) userData.fbp = bodyFbp;
  if (typeof bodyFbc === 'string' && bodyFbc.length > 0) userData.fbc = bodyFbc;

  const eventSourceUrl = req.body?.event_source_url;
  const payload = {
    data: [{
      event_name,
      event_time: eventTimeUnix,
      event_id,
      action_source: 'website',
      event_source_url: typeof eventSourceUrl === 'string' ? eventSourceUrl : 'https://tecnyapp.com/',
      user_data: userData,
      custom_data: customData,
    }],
  };

  try {
    // fetch nativo (Node 18+). AbortController para timeout 5s — CAPI
    // suele responder <500ms, si tarda más asumimos issue temporal y no
    // bloqueamos el response al client.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `${CAPI_URL}?access_token=${encodeURIComponent(CAPI_TOKEN)}`;
    const metaRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!metaRes.ok) {
      // Log del error para debugging pero NO exponer al client. Meta puede
      // devolver 4xx si el token está mal, event_name no permitido, etc.
      const errText = await metaRes.text().catch(() => '');
      logger.warn({
        status: metaRes.status,
        event_name,
        event_id,
        meta_response: errText.slice(0, 500),
      }, 'CAPI forward failed');
      // Siempre 200 al cliente — el Pixel client-side ya se disparó,
      // el fail server-side es "silent" (solo pierde dedup boost).
      return res.json({ ok: true, forwarded: false, reason: 'upstream error' });
    }

    return res.json({ ok: true, forwarded: true });
  } catch (err) {
    // Timeout o network error — log + fail-open (mismo criterio arriba).
    logger.warn({
      err: err.message,
      event_name,
      event_id,
    }, 'CAPI forward exception');
    return res.json({ ok: true, forwarded: false, reason: 'exception' });
  }
});

module.exports = router;
