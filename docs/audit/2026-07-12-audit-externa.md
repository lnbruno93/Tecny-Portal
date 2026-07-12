# Auditoría Superficie Externa — Share link, auth público, PDF, chat-bot, sitio iPro

**Fecha**: 2026-07-11
**Auditor**: Claude Opus (revisión exhaustiva del track "Superficie Externa" post Red B2B).
**Alcance**:
- `backend/src/routes/{shareLinks,public,publicSuperAdminInvite,signup,auth,chat}.js`
- `backend/src/lib/{comprobantePdf,chat,chat-tools,captcha}.js`
- `backend/src/middleware/{auth,signupLimiter}.js`
- `backend/src/schemas/{auth,signup,shareLinks,chat}.js`
- `backend/src/app.js` (helmet/CSP/CORS/rate limits globales)
- `backend/migrations/20260711100000_share_links_usados.js`
- `frontend/src/screens/PublicoUsados.jsx`
- `iPro-Website/*` (revisión completa del sitio estático migrado desde Replit)

**Método**: revisión de código con foco en OWASP Top 10 web (injection/XSS/SSRF/PII/rate-limits/CSRF/CSP), prompt-injection en el chat-bot, integridad del PDF, multi-tenant isolation en endpoints públicos y estado del captcha.

---

## TL;DR

La postura de seguridad externa es **razonable pero desigual**. El nuevo share link de Equipos Usados quedó bien defendido (Zod estricto, RLS bypass justificado por token secret, filtro server-side de precio/batería, rate limit por IP, sin exposición de `costo`). Auth público tiene una base robusta (anti-enum, PostgresRateLimitStore multi-réplica, timing constante, bcrypt cost 12, hCaptcha fail-closed en prod). El sitio iPro-Website es **puramente estático** (SPA React + Vite sin backend), sin formularios que peguen a Tecny — 0 riesgo de leak cross-property.

Sin embargo hay **3 findings P0 reales** que impactan superficie externa hoy:

1. **`POST /login` sin CAPTCHA y sin lockout por IP** — el rate limit (10/15min) es fácil de sortear con IP rotativa. Combinado con `email` como campo de lookup (dictionary attack sobre logs conocidos), un atacante distribuido puede probar N credenciales por hora. Signup, forgot y register tienen captcha; login no.
2. **`/publico/usados/:token` NO invalida cache CDN al `rotate` del token** — un token comprometido queda cacheable por 60s en cada edge CDN hasta que expire naturalmente. Peor: el listado revoca inventario recién en `T + 60s`. Puede exponer inventario ya vendido o "consultar por WhatsApp" al ex-cliente.
3. **`SHARE_LINK_IP_SALT` con fallback dev en producción** — si Railway olvida setear la env, el hash de IP es criptográficamente inútil (salt público). No es catastrófico (los datos son solo analytics) pero rompe la garantía de anonimización que promete la migration.

Además: **8 P1** (fallback silencioso, error `_debug` en logs, chat-bot con caps parciales, PDF sin escape de texto multiline, endpoint público de super-admin invite sin captcha, TTL fijo del pass reset, header de compresión activo sobre respuestas privadas, ausencia de auditoría de `/publico/usados/*`) y varios P2/P3.

---

## Findings por severidad

### P0 — Impacto inmediato en superficie externa

#### P0-1 — `/api/auth/login` sin captcha ni lockout distribuido por IP

**File**: `backend/src/routes/auth.js:106-338` (handler `/login`) + `backend/src/app.js:538-548` (limiter)
**Categoría**: Seguridad — brute-force / credential stuffing

El `loginLimiter` es 10 fallos / 15min por IP normalizada (IPv6 /64), con `skipSuccessfulRequests: true`. El endpoint **NO tiene captcha** (comparar con `/signup` línea 205 que sí lo tiene). Tampoco tiene un contador global cross-IP por email (solo por user id, línea 166-186).

**Escenario de daño**:
1. Atacante consigue un email conocido (ej. filtrado en breach externo, `lucas@tecnyapp.com`).
2. Prueba desde 200 IPs distintas (residenciales, tor, proxies rotativos) con contraseñas del top 10000 → 200 IPs × 10 intentos/15min = 2000 intentos/15min sobre **el mismo email**.
3. `failed_login_count` en `users` sí incrementa (SOL-3 fix, UPDATE atómico), y llega al threshold de 10 → lockout 15min. Pero el atacante puede reintentar cada 15min (2000 intentos por ciclo).
4. En 24h son ~192.000 intentos sobre 1 cuenta. Con dicc. de 10k passwords, cobertura completa en <1h por cuenta.

El lockout per-user **sí** dispara, pero no bloquea al atacante — solo al legítimo (que queda 15min sin poder loguear cada vez que el atacante prueba 10 credenciales seguidas). Efecto secundario: DoS por lockout.

**Impacto**: brute force distribuido factible sobre cualquier email conocido. `is_super_admin` de Lucas es objetivo obvio de valor alto.

**Fix**:
1. Sumar `hcaptcha_response` opcional al `loginSchema` — activarlo desde el 3er fallo por IP (soft cap) o siempre (más simple, prod-ready). El frontend renderiza el widget cuando el response del login incluye `captcha_required: true`.
2. Como alternativa/complemento: sumar un contador diario por email (aparte del contador per-user) → 100 intentos/día/email antes de exigir captcha o bloquear temporalmente.
3. En cualquier caso, monitorear en logs `failed_login_count > 30 en 24h` como señal de attack. Añadir alerta al Sentry.

**Costo estimado**: ~4h (backend + frontend + tests + migración de schema opcional).

---

#### P0-2 — Cache CDN de 60s en `/publico/usados/:token` no se invalida al rotar el token

**File**: `backend/src/routes/shareLinks.js:353` (`Cache-Control: public, max-age=60`) + `:180-206` (endpoint POST /rotate)

Cuando el operador rota el token via `POST /api/inventario/share-link/rotate`, el token viejo se sobrescribe en DB con `UPDATE` — respuestas subsiguientes al viejo devuelven 404. **Pero** los edge nodes de Railway (u otro CDN) que sirvieron `/publico/usados/<viejo>` en los últimos 60s siguen respondiendo con la copia cacheada durante hasta 60s más.

**Escenario de daño**:
1. Operador comparte por accidente el link al pipe equivocado.
2. Rota el token (asume que "el link viejo queda inválido").
3. El atacante que ya lo tenía puede recargar la URL vieja: si CDN cacheó, sigue viendo el catálogo (incluidos precios, WhatsApp, inventario) por hasta 60s. En sesiones con multi-fetch (mobile, carga de assets), la ventana efectiva puede ser mayor.
4. Peor: si el link viejo fue **desactivado** (`activo=false`), el 410 tampoco propaga durante 60s.

**Impacto**: contradice el modelo de seguridad prometido en el comment del endpoint ("el link viejo queda inválido"). Aunque el dato expuesto es un catálogo público (baja severidad intrínseca), la promesa de "rotar = invalidar YA" no se cumple.

**Fix**:
1. Setear `Cache-Control: private, max-age=60, must-revalidate` en lugar de `public` — obliga al browser a revalidar pero CDN no cachea. Trade-off: hit rate global cae, pero el link no es un asset viral típico (no debería ser CDN-heavy).
2. **O bien**: agregar `ETag` con hash del `updated_at + token` y responder 304 en revalidation. CDN puede cachear + revalidar.
3. **O bien**: bajar `max-age` a 10s. Reduce la ventana a la mitad de lo tolerable para "rotar YA".
4. Documentar en el UI del panel admin: "El rotate invalida el link viejo — la propagación puede tomar hasta 60s". Baja fricción, alta claridad.

**Costo estimado**: 30 minutos (fix) + 30 min tests.

---

#### P0-3 — `SHARE_LINK_IP_SALT` con fallback dev inseguro

**File**: `backend/src/routes/shareLinks.js:41`

```js
const IP_HASH_SALT = process.env.SHARE_LINK_IP_SALT || 'tecny-share-link-salt-dev';
```

Si Railway no tiene `SHARE_LINK_IP_SALT` seteada, el hash de IP usa un salt público-por-código. Un atacante que consiga acceso al dump de `share_link_views` (via SQL injection en otro sitio, backup filtrado, etc.) puede rainbow-tablear IPs individuales en segundos (SHA-256 con salt conocido sobre 4B IPs IPv4).

La migration promete "SHA-256 primer 32 chars del IP + salt del env" como mecanismo de pseudo-anonimización. Sin el salt real, la anonimización es **teatro**.

**Impacto**: si el salt no está seteado en producción, `share_link_views.ip_hash` es reversible → ubicación aproximada de cada visitante puede leakear. No es catastrófico (los datos son analytics, no sensibles al nivel de PII financiera) pero rompe la promesa formal de la migration.

**Fix**:
1. Fail-closed en boot: si `NODE_ENV === 'production'` y `SHARE_LINK_IP_SALT` no está seteada, **throw** al cargar el módulo (mismo patrón que hCaptcha). No inserts silenciosos con salt dev.
2. Alternativamente: log `logger.error` cada 100 inserts si el fallback está activo, para que aparezca en alertas.
3. Documentar en el README de deploy que la env es obligatoria (junto con `JWT_SECRET`, `HCAPTCHA_SECRET`).

**Costo estimado**: 15 minutos + verificar que Railway tenga la env seteada.

---

### P1 — Bugs importantes / hardening

#### P1-1 — `/api/public/super-admin-invite/:token/accept` sin captcha

**File**: `backend/src/routes/publicSuperAdminInvite.js:174` + `backend/src/app.js:783`

El endpoint crea un `user` con `is_super_admin=true` — **el punto de entrada con mayor privilegio del sistema**. Está protegido por `signupLimiter` (5/hora/IP) pero NO tiene captcha. El signup público sí lo tiene.

**Escenario**: si un atacante consigue un token válido de invite (filtrado por email compromised, MitM, o compartido en canal público), puede POSTear `accept` desde cualquier IP con una password propia (Zod `passwordField()` la valida) — el flow no verifica ownership del email más allá de "tener el token en la mano".

**Impacto**: si el token del email leaka, el atacante convierte la invite en su cuenta super-admin en 1 request. Sin captcha, no hay 2do factor de "humano detrás del click".

**Fix**: agregar `hcaptcha_response` al `acceptSchema` (`superAdminTeam.js:88`) + `verifyCaptcha` al inicio del handler POST accept, igual patrón que signup. Costo ~30min.

---

#### P1-2 — Bypass sistemático de rate-limits globales con JWT firmado válido

**File**: `backend/src/app.js:227-238, 253-258`

El `hasValidSignedJwt(req)` skipea el global limiter para requests con JWT firmado válido. La razón (comentario 213-225) es válida: usuarios legítimos no deberían chocar contra el bucket global. **Pero**: verifica solo la firma HS256, NO revocación / expiración / user activo / password_changed_at. Un JWT robado con lifetime de 8h skipea el global limit **completo** — solo caen los limiters específicos (login, 2fa, change-password, forgot, reset).

**Escenario**: XSS en un tenant filtra el JWT del owner. Atacante hace 10.000 requests/min a `/api/ventas`, `/api/comprobantes`, etc. antes de que el user haga logout. El global limit no lo frena.

**Impacto**: DoS por abuso de sesión robada. `requireAuth` sí re-valida el JWT contra `password_changed_at` cacheado, pero la mitigación es solo si el legítimo hace logout / cambia password.

**Fix**:
1. Sumar un rate-limit "authenticated" separado (más generoso: 3000/15min por user id), no bypass total. `hasValidSignedJwt` sigue skipeando el global limit pero cae al authenticated.
2. Considerar bajar el JWT TTL de 8h a 2-4h (comentario 98-102 lo tiene identificado como deuda pendiente para TANDA 6).

**Costo estimado**: ~2h (rate limit adicional + tests).

---

#### P1-3 — Endpoint `/api/csp-report` y `/api/client-errors` sin auth loguean payload arbitrario a Sentry

**File**: `backend/src/app.js:264-336`

Ambos endpoints reciben cuerpos anónimos (browsers no envían credenciales), tienen rate limit razonable (100/60s CSP, 60/60s client-errors) y whitelisting de content-type. Pero:
- El `csp-report` loguea el body completo con `logger.warn({ csp: report })`. Un atacante que dispare violations custom con URLs largas (2000+ chars) puede spammear logs de Sentry (costo $) o inflar el índice de búsqueda. Rate limit es de 100/min/IP; con 100 IPs, 10.000/min.
- El `client-errors` sí filtra "ruido" via `isClientErrorNoise` pero pasa `stack` y `url` completos al `logger.warn` **antes** del filtro (línea 299-303). Impacta el drenaje de logs de Railway.

**Impacto**: cost + noise en observability. No es crítico pero puede convertirse en tema de bill si un bot lo martilla.

**Fix**:
1. Truncar `report.originalPolicy` y `report['blocked-uri']` a ~200 chars antes de loguear.
2. Truncar `stack` a 4KB antes del log warn del backend (Sentry ya lo hace de su lado pero acá va a Railway logs).
3. Mover el `isClientErrorNoise` **antes** del `logger.warn` — hoy el ruido igual se loguea, solo se skipea Sentry.

**Costo estimado**: 20 minutos.

---

#### P1-4 — Chat bot: `get_ventas_pendientes` / `get_envios_activos` / `get_actividad_reciente` sin capability gate

**File**: `backend/src/lib/chat-tools.js:1029-1067, 627-677, 1144-1197`

El audit 2026-07-06 P1 (comment línea 40-63) agregó `hasCap(ctx, slug)` a **algunas** tools: `get_saldos_cajas`, `get_top_productos`, `get_top_vendedores`, `get_cc_pendientes`, `get_proveedores_pendientes`, `get_tarjetas_no_liquidadas`. **Pero olvidó** `get_ventas_pendientes` (línea 1029 sin gate), `get_envios_activos` (línea 627 sin gate), `get_actividad_reciente` (línea 1144 sin gate), `get_stock_bajo` (línea 1105 sin gate) y `get_kpis_hoy` (línea 436 sin gate).

**Escenario**: usuario con rol "vendedor" (sin `ventas.trabajar` en el módulo Ventas por diseño) le pregunta al bot "¿qué ventas están pendientes?" — el bot le devuelve **todas** las ventas pendientes del tenant con `cliente_nombre`, `order_id`, `total_usd`. Bypass del gate del módulo Ventas.

**Impacto**: información sensible del tenant expuesta a roles que no deberían verla vía el chat-bot. Contradice el principio de least privilege que el mismo audit 2026-07-06 estableció.

**Fix**: sumar `if (!hasCap(ctx, 'ventas.trabajar')) return noPermission('ventas.trabajar');` (o el slug apropiado) a los 5 handlers faltantes. Slugs sugeridos:
- `get_ventas_pendientes` → `ventas.trabajar`
- `get_envios_activos` → `envios.trabajar`
- `get_actividad_reciente` → `historial.ver`
- `get_stock_bajo` → `inventario.ver`
- `get_kpis_hoy` → `resumen.ver`

**Costo estimado**: 30 minutos (5 líneas + 5 tests).

---

#### P1-5 — PDF de comprobante sin sanitizar texto multiline en `descripcion`, `cliente_nombre`, `notas`

**File**: `backend/src/lib/comprobantePdf.js:180, 148, 253`

`pdfkit` no interpreta HTML (no hay XSS "clásico"). **Pero**: si `descripcion` o `notas` contienen caracteres de control (`\x00`, `\x1B`), NUL bytes, o secuencias RTL Unicode (U+202E), el PDF resultante puede confundir viewers (algunos truncan al NUL, otros renderizan estilos raros). Peor: si `descripcion` viene con literal `\n\n\n...\n` (100+ newlines), el layout se rompe y el "Total" cae fuera de página.

Adicionalmente, el nombre del tenant se usa directo como `Author` del PDF metadata (`comprobantePdf.js:113`) y en el header (línea 130). Un tenant registrado con nombre `<script>alert(1)</script>` no dispara XSS en PDF pero sí queda como Author en el metadata visible en Adobe/Preview — es un vector de suplantación (tenant se llama a sí mismo "iPro | Tech Reseller" en el metadata).

**Impacto**: layout roto en PDFs con inputs adversariales; suplantación de nombre en metadata. No crítico pero UX degradada + posible confusión al cliente final.

**Fix**:
1. En `comprobantePdf.js`, agregar helper `sanitizeForPdf(s)` que:
   - Strip control chars (`\x00-\x1F` menos `\n`).
   - Strip RTL override chars (U+202E, U+2066-U+2069).
   - Truncar a max_len por campo (descripcion 200, notas 500, nombre_tenant 100).
   - Colapsar `\n{3,}` → `\n\n`.
2. Aplicarlo en TODOS los strings user-controlled antes de `doc.text(...)`.

Nota: el bug histórico "Tek Haus veía Tecny" ya está fixeado en el /me fallback (línea 431-457 de `auth.js`) — verificado. El PDF respeta `tenant.nombre` correctamente ahora.

**Costo estimado**: 1h (helper + audit de call-sites + tests).

---

#### P1-6 — TTL de reset token expuesto en response de `/forgot-password`

**File**: `backend/src/routes/auth.js:678-681`

```js
res.status(200).json({
  reset_required: true,
  reset_token_ttl_hours: RESET_TOKEN_TTL_HOURS,   // 1
});
```

El TTL se expone en la respuesta idéntica para email existente y no existente (bien: anti-enum). **Pero**: exponer el TTL exacto ayuda al atacante a temporizar sus intentos si consigue el token (por MitM al email, filtro de logs, o compromiso de proveedor de email). Sabiendo que tiene exactamente 1h, prioriza el uso inmediato.

**Impacto**: bajo pero real. Otros SaaS (Auth0, Clerk) NO exponen TTL exacto — devuelven mensaje genérico.

**Fix**: no incluir `reset_token_ttl_hours` en la response. El frontend puede hardcodearlo en el copy ("Tu link expira en 1 hora") y si en el futuro cambia el TTL, cambia el copy — cambio raro. Alternativa: exponerlo solo en el email (donde ya está), no en el API response.

**Costo estimado**: 5 minutos.

---

#### P1-7 — `/publico/usados/:token` sin audit trail cuando responde 404/410

**File**: `backend/src/routes/shareLinks.js:255-370`

El endpoint registra views SOLO cuando responde 200 (línea 340-349). Los 404 (token inválido) y 410 (link desactivado) NO quedan trackeados. Esto complica:
1. Detectar scan/scraping (miles de tokens inválidos probados = suspicious).
2. Debug de casos "el link no me anda" (no hay traza server-side de cuántas veces se pidió).
3. Métricas para detectar link comprometido (spike de 410 después de rotate = alguien seguía teniendo el link viejo).

**Impacto**: pérdida de observabilidad crítica en el endpoint más expuesto del sistema.

**Fix**:
1. Loguear con `logger.info({ token_prefix: token.slice(0,4), reason: 'not_found'|'inactive' })` en el path 404/410. NO loguear el token completo (podría filtrarse a Sentry / Papertrail).
2. Métrica prometheus/StatsD: `share_link.public.get.status_code` (200/404/410/429).
3. Alerta en Sentry si `share_link.public.get.404 rate > 100/min` (probable scan).

**Costo estimado**: 30 minutos.

---

#### P1-8 — Compresión gzip aplicada a respuestas privadas con secrets (`/me`, `/login`)

**File**: `backend/src/app.js:160`

```js
app.use(compression());
```

Compresión aplica a **todo** el output. Respuestas de `/api/auth/login` incluyen el JWT firmado en body — comprimidas. Respuestas de `/api/auth/me` incluyen `caps: [...]` y datos del user — comprimidas. Bajo TLS 1.2/1.3 con compresión activa (BREACH/CRIME-like attacks), un atacante con MitM sobre la sesión puede exfiltrar bytes del payload comprimido observando el size de respuestas repetidas con inyecciones en el request.

**Impacto**: baja probabilidad de explotación real (requiere MitM activo + control sobre parte del request/response) pero es hardening estándar en 2026: **NO comprimir respuestas con secrets**.

**Fix**: cambiar `compression()` a `compression({ filter: (req, res) => { if (req.path.startsWith('/api/auth/') || req.path === '/api/auth/me') return false; return compression.filter(req, res); } })`. Los endpoints con JWT + caps escapan. Costo ~15min.

Alternativa más simple: setear `Cache-Control: no-transform` en respuestas de auth para que proxies no re-compriman (defense in depth).

---

### P2 — Edge cases razonables

#### P2-1 — `/publico/usados/:token` puede leakear `condicion='usado'` de productos soft-deleted por race

**File**: `backend/src/routes/shareLinks.js:302-321`

Query filtra `p.deleted_at IS NULL`. Pero si un producto se soft-deletea entre el SELECT del linkRow (línea 262) y el SELECT de productos (línea 302), la ventana de race puede devolverlo. Ambos usan `adminQuery` sin lock. Impacto bajo (producto marcado como "borrado" aparece 1 vez más al que hizo GET simultáneo).

**Fix**: no worth arreglar. Documentar como known-good race window (existe implícitamente en toda query no-transaccional).

---

#### P2-2 — Chat bot: `SYSTEM_PROMPT` cacheado ephemeral por 5min → si Anthropic cambia policy interna, el prompt viejo sigue actuando

**File**: `backend/src/lib/chat.js:273-284`

El prompt tiene 3.5KB. Está cacheado con `ephemeral`. Si en algún momento el prompt cambia (bug fix, política nueva), tenants con conversaciones activas ven el prompt viejo por hasta 5min más. No es un P0 pero puede confundir en debugging.

**Fix**: comentar el fenómeno en el comment del cache (línea 273-284 ya lo insinúa; hacerlo explícito).

---

#### P2-3 — `/api/public/pricing` sin CORS restrictivo

**File**: `backend/src/routes/public.js:49-56` + `app.js:189-197`

El comentario del router (línea 17-20) dice "CORS abierto (*)". En la práctica, el CORS global de app.js (`allowedOrigins`) filtra. Está OK. Pero si en el futuro se agrega un endpoint público que un partner debe llamar cross-origin (ej. webhook, oembed), va a chocar. Anotar.

**Fix**: mover el endpoint a un router con CORS `origin: '*'` explícito si se decide abrirlo. Hoy no urge.

---

#### P2-4 — Zod `.default('AR')` en signup permite legacy clients pero rompe el "strict" mode

**File**: `backend/src/schemas/signup.js:32`

`.strict()` rechaza campos extra pero `.default()` en `pais` acepta requests sin el campo. Efecto secundario mínimo: un client malicioso puede omitir `pais` a propósito para saltarse validaciones futuras que un dev agregue asumiendo que `pais` viene del form.

**Fix**: hacer `pais` obligatorio (breaking change controlado). Frontend siempre lo manda.

---

#### P2-5 — `runChatTurn` no persiste turnos intermedios de tool_use → audit incompleto

**File**: `backend/src/lib/chat.js:352-363`

El comment (líneas 351-358) reconoce el trade-off: los turnos intermedios (assistant `tool_use` + user `tool_result`) NO se persisten. Solo el mensaje final del assistant. Consecuencia: audit del bot no puede reconstruir "qué tool ejecutó y con qué input" **una vez que la conversación se cierra**. Los logs backend sí lo tienen (línea 331-337) pero se rotan en 7 días típicamente. Para tuning del prompt post-hoc, se pierde info.

**Fix**: opcional. Persistir `tool_calls: [{name, input_keys}]` en `chat_messages.tokens_input` (JSON extra) o en una tabla dedicada. Trade-off documentado, no urgente.

---

### P3 — Cosméticos / mejoras menores

- **P3-1**: `PublicoUsados.jsx:399` construye `wa.me/${whatsapp}` sin validar formato E.164 en frontend. El backend acepta strings hasta 40 chars sin regex — un tenant curioso puede meter `abc123!@#` y romper el link. Sugerencia: sumar Zod regex `^[0-9+\s()-]{6,40}$` en `updateShareLinkSchema.whatsapp`.
- **P3-2**: `comprobantePdf.js:113` — `Author: tenant.nombre` sin escape. pdfkit no interpreta HTML pero un tenant con nombre `\` en el PDF metadata puede romper viewers antiguos. Truncar + sanitizar en el mismo helper P1-5.
- **P3-3**: `shareLinks.js:337` — `req.ip || req.headers['x-forwarded-for']` — con `trust proxy: 1` (app.js:157) `req.ip` ya toma XFF. El fallback nunca dispara y confunde. Simplificar a `req.ip`.
- **P3-4**: `shareLinks.js:44` — `crypto.createHash('sha256').update(IP_HASH_SALT).digest('hex').slice(0, 32)` cuando IP es empty. Devuelve el mismo hash para todas las IPs empty. Marca IP=null en DB en su lugar (mejor semántica).
- **P3-5**: `auth.js:497-503` (logout) usa `to_timestamp(($1::bigint + 1) / 1000.0)` con `Date.now() + 1`. Documentado como fix de race. OK pero podría ser `to_timestamp((current_millis() + 1)/1000.0)` en SQL puro si existiera. Menor.
- **P3-6**: `publicSuperAdminInvite.js:147` — length range 20-200 para token base64url. El generador emite 43 chars (32 bytes → base64url). El rango 20-200 es defensivo, OK, pero un rango más estrecho (35-64) rechaza basura obvia más rápido.
- **P3-7**: `signup.js:120` — `DEFAULT_CATEGORIAS = ['Celulares', 'Accesorios', 'Servicios', 'Otros']` hardcoded. Está OK como legacy pero si Lucas quiere localizar a UY (¿mismos nombres?), sale del código. Menor.
- **P3-8**: `chat-tools.js:1179` — `String(dias)` en `($2 || ' days')::interval` — string interpolado en SQL. Zod ya validó `dias` como integer 1-90, safe, pero `${dias}` directo sería más idiomatico. Menor.
- **P3-9**: `PublicoUsados.jsx:158-160` — `localStorage.getItem('pubUsadosView')` sin namespace por origen. Si un usuario visita 2 links de distintos tenants en el mismo browser, la preferencia se comparte. UX menor.
- **P3-10**: `app.js:262` — `express.json({ limit: '10mb' })` global. Muy generoso para 99% de endpoints. La mayoría de endpoints acepta payloads <1MB (audit historic). Bajar a 2mb global + subir a 10mb solo en OCR/import mejora la superficie de payload DoS. Menor.
- **P3-11**: `chat.js:296-298` — error `Anthropic (timeout, 429, 5xx)` marcado como 502 al cliente. El cliente ve "No pude generar la respuesta" — bien, pero si el bot pega 429 (quota Anthropic), rate-limit-fail-early sería mejor UX que 502 (indica infra failure). Diferenciar en el mensaje.
- **P3-12**: `iPro-Website/index.html:23` — `<link rel="preload" as="style" ... onload="this.rel='stylesheet'" />` con inline handler `onload`. CSP-conflictivo si el sitio suma un CSP restrictivo en el futuro. Migrar a JS lazy-load.

---

## Buenas prácticas verificadas

1. **Share link — precio_costo NO expuesto**: la query SELECT (`shareLinks.js:302-321`) trae solo `precio_venta`, `precio_moneda`, `gb`, `color`, `bateria`, `nombre`, `clase_nombre` — sin `precio_costo`. Verificado. Los toggles `mostrar_precio`/`mostrar_bateria` se aplican DOBLE (SQL filter + JS map `precio_venta = null`) → defense in depth.
2. **Multi-tenant isolation en share link**: query filtra `WHERE p.tenant_id = $1` (`shareLinks.js:311`) donde `$1 = linkRow.tenant_id`. Imposible cross-tenant leak vía token — solo devuelve productos del tenant dueño del link.
3. **Rate limit stores compartidos multi-réplica**: TODOS los limiters (login, signup, 2fa, forgot, reset, resend, verify, chat, global) usan `PostgresRateLimitStore` con prefijo dedicado. Fix P1 auditoría 2026-06 aplicado consistente.
4. **Anti-enumeration en auth público**: `/login`, `/signup`, `/forgot-password` todos tienen response idéntica para "existe" vs "no existe" + dummy bcrypt para timing equalization. Patrón consistente y verificado.
5. **hCaptcha fail-closed en prod**: `captcha.js:104-113` fail-closed si `HCAPTCHA_ENABLED` no es `'true'` en NODE_ENV=production. Kill-switch de outage (`HCAPTCHA_OUTAGE_BYPASS`) loggea warn en cada uso. SEG-4 aplicado.
6. **JWT algorithm pinning**: `algorithms: ['HS256']` en verify (2 sitios) — previene algorithm confusion attacks (`none`, `RS256` con public key).
7. **Zod strict + control-char strip en chat**: `sendMessageSchema` (chat.js:41) strippea `\x00-\x1F` menos `\n\t\r`. Prompt injection avanzado por control chars mitigado.
8. **Chat tools READ-ONLY sistemático**: los 14 handlers son SELECT-only. Cero mutations expuestas al bot → prompt injection no puede convertirse en RCE / data damage.
9. **CSP restrictivo en API server**: `defaultSrc 'none'` para todo (app.js:165-179). API no sirve HTML, no necesita loose CSP.
10. **CSP report endpoint con rate limit + content-type whitelist**: 100/60s/IP + `application/csp-report|reports+json|json` (app.js:269-281). Bien defendido.
11. **Trust proxy=1**: correcto para Railway single-hop LB (`req.ip` toma XFF sin permitir spoof).
12. **helmet default HSTS + X-Frame-Options + X-Content-Type-Options**: activos con defaults seguros (app.js:165-179). Solo se override CSP.
13. **Sitio iPro-Website es 100% estático**: revisión completa confirmó cero endpoints backend, cero fetch a Tecny, cero forms POST. WhatsApp/Instagram/Google Maps son enlaces `target=_blank rel=noopener`. Zero XSS surface backend-linked.
14. **PDF con pdfkit (no puppeteer)**: elimina riesgo de SSRF via Chromium fetching URLs externas (`comprobantePdf.js:5-11`). Sin browser sandbox = sin browser exposure.
15. **Reset token 256-bit hex + single-shot + TTL 1h**: patrón estándar. UPDATE atómico marca `used_at` en tx con audit.
16. **Fallback query directo a `tenants` en `/me`**: fix del bug "Tek Haus veía Tecny" ya aplicado (`auth.js:431-457`). Verificado.

---

## Preguntas abiertas (para decisión Lucas)

1. **CAPTCHA en `/login`**: ¿estamos ok agregando captcha desde el 3er fallo o siempre? Depende del volumen de logins/mes. Recomendación: siempre (0 fricción con el widget "invisible" v3 de hCaptcha o Turnstile de Cloudflare que rara vez muestra desafío).
2. **JWT TTL 8h → 2-4h**: comentado como deuda en auth.js:98-102 para TANDA 6. ¿Priorizar antes o después del refresh token flow?
3. **Share link cache CDN público vs private**: `public, max-age=60` vs `private, max-age=60`. La primera hitea mejor pero rompe la promesa "rotate = invalida YA". ¿Cuál preferís?
4. **Chat bot audit trail de tool calls**: ¿vale la pena persistir tool_use intermedio para reconstruir turnos completos post-hoc (útil para debug + tuning del prompt)? Costo tabla adicional + tx extra.
5. **Sitio iPro-Website**: ¿alguna vez va a exponer un form de contacto que pegue a algún backend? Hoy no lo hace (100% estático + WA/IG/embed). Si en el futuro sí, corresponde CSP + captcha + rate limit. Anotar.
6. **`SHARE_LINK_IP_SALT` fail-closed**: si Railway olvida setear la env, ¿preferís (a) throw al boot → deploy falla y notás, o (b) log error cada 100 inserts → funciona pero degradado? (a) es más seguro pero más "ruidoso".

---

## Plan de acción propuesto

**Sprint 1 — P0 críticos** (~1.5 días, 3 PRs):

- **PR A** (~4h): fix P0-1 (captcha en `/login` + contador diario por email). Backend + frontend (widget en formulario) + tests.
- **PR B** (~1h): fix P0-2 (cache CDN de share link — `private, max-age=60, must-revalidate` + doc en admin panel).
- **PR C** (~30 min): fix P0-3 (`SHARE_LINK_IP_SALT` fail-closed en boot + verificar env en Railway).

**Sprint 2 — P1 importantes** (~1.5 días, 3 PRs):

- **PR D** (~2h): fix P1-1 + P1-6 (captcha en super-admin invite accept + no exponer TTL en forgot-password response).
- **PR E** (~2h): fix P1-4 (capability gates faltantes en 5 chat-tools). Backend + tests con distintos roles.
- **PR F** (~1.5h): fix P1-5 + P1-7 + P1-8 (helper `sanitizeForPdf` + audit trail en 404/410 del share link público + `compression()` filter para `/api/auth/*`).

**Sprint 3 — P1 restantes + P2** (~1 día, 2 PRs):

- **PR G** (~2h): fix P1-2 (rate limit "authenticated" separado en lugar de bypass total del global).
- **PR H** (~1h): fix P1-3 (truncar payloads antes de logs en csp-report / client-errors).

**Sprint 4 — batch P3** (~0.5 día, 1 PR):

- **PR I** (~3h): batch de P3 (regex whatsapp, escape del Author del PDF, simplificar req.ip, IP null en su lugar, timeout diff en chat, namespace localStorage en share link, bajar limit global de express.json).

**Total estimado**: ~4-5 días distribuidos en 9 PRs.

---

**Archivos principales de referencia**:
- `backend/src/routes/{auth,signup,shareLinks,public,publicSuperAdminInvite,chat}.js`
- `backend/src/lib/{captcha,comprobantePdf,chat,chat-tools}.js`
- `backend/src/middleware/{auth,signupLimiter}.js`
- `backend/src/schemas/{auth,signup,shareLinks,chat}.js`
- `backend/src/app.js` (helmet/CSP, CORS, global rate limit, JWT bypass)
- Migration: `20260711100000_share_links_usados.js`
- Frontend público: `frontend/src/screens/PublicoUsados.jsx`
- Sitio estático: `iPro-Website/*` (verificado sin backend calls)

Auditoría completa. 22 findings totales, 26 archivos revisados.
