# Resend Domain Setup — tecnyapp.com

Playbook para verificar el dominio `tecnyapp.com` (registrado en **GoDaddy**)
en Resend, para liberar el límite de "solo email del owner" del free tier.

Tiempo total: ~30 min de tu lado + 5–60 min de propagación DNS.

---

## Paso 1 — Agregar dominio en Resend (5 min)

1. Entrá a [resend.com](https://resend.com) → **Domains** (sidebar) → **Add Domain**.
2. Domain name: `tecnyapp.com`.
3. **Region**: dejá la default (US East / N. Virginia) — no necesitamos otra
   región para Argentina; el SPF/DKIM funciona igual.
4. Resend te muestra una pantalla con **3 records DNS** (uno SPF, dos DKIM).
   Dejá esa tab abierta — los necesitamos en el paso 2.

---

## Paso 2 — Agregar records DNS en GoDaddy (10 min)

1. Login en [godaddy.com](https://godaddy.com) → **My Products** → tecnyapp.com
   → **DNS** → **Manage Zones**.
2. **Agregá 3 records nuevos** (botón "Add New Record" arriba de la tabla).
   Copiá EXACTO lo que muestra Resend en su pantalla. La forma genérica de
   los records es:

   | Tipo  | Name (Host)                  | Value                                                                        | TTL    |
   |-------|------------------------------|------------------------------------------------------------------------------|--------|
   | TXT   | `send` (o `send.tecnyapp.com`) | `v=spf1 include:amazonses.com ~all`                                          | 1 hora |
   | TXT   | `resend._domainkey`          | `p=MIGfMA0GCSqGSIb3DQEB...` (string largo, copiá completo de Resend)         | 1 hora |
   | MX    | `send`                       | `feedback-smtp.us-east-1.amazonses.com` (priority **10**)                    | 1 hora |

   **Notas GoDaddy específicas:**
   - En el campo "Name", GoDaddy **NO** quiere `send.tecnyapp.com` — solo
     `send`. GoDaddy agrega el dominio automáticamente.
   - En el TXT del DKIM, el "Name" es `resend._domainkey` (sin `.tecnyapp.com`
     al final). GoDaddy puede mostrar el record como
     `resend._domainkey.tecnyapp.com` en la lista — está bien.
   - El valor del DKIM es LARGO (~400 chars). GoDaddy acepta strings largos
     en TXT, no hay que partirlo.
   - TTL default de GoDaddy es 1 hora — ok. Más bajo (5 min) acelera la
     propagación si querés iterar, pero 1h está bien.
   - **NO uses comillas** en el campo "Value" — GoDaddy las agrega solo.

3. Click **Save** en cada record. GoDaddy puede tardar 1–2 min en aplicarlos
   internamente antes de propagar.

---

## Paso 3 — Verificar en Resend (5–60 min, espera DNS)

1. Volvé a la tab de Resend (la que dejaste abierta en el paso 1).
2. Click **"Verify Records"** (o "Check status").
3. Espera. Resend chequea los 3 records. Cuando los 3 estén **verdes** ✓,
   el dominio queda **Verified**.
4. Si Resend dice "Failed" o "Pending":
   - Esperá 10 min más (DNS no propagó todavía).
   - Verificá con dig / online tool:
     ```bash
     dig TXT send.tecnyapp.com +short
     dig TXT resend._domainkey.tecnyapp.com +short
     dig MX send.tecnyapp.com +short
     ```
     Los valores deben coincidir EXACTO con lo que mostró Resend.
   - Si pasaron 2h y sigue Failed, revisar GoDaddy:
     - ¿El record está activo (no "Pending" en GoDaddy)?
     - ¿El "Name" no tiene el dominio duplicado (`send.tecnyapp.com.tecnyapp.com`)?
   - Última opción: borrar los records y rehacerlos desde cero.

---

## Paso 4 — Actualizar env vars en Railway (5 min)

Una vez que Resend marca el dominio Verified ✅:

1. Railway → **tecny-backend (prod)** → Variables.
2. Setear / actualizar:
   ```
   EMAIL_FROM = iPro Portal <noreply@tecnyapp.com>
   ```
   (Si ya existía con otro valor, sobrescribirlo. Si no existía,
   crear nueva.)
3. Railway redeploya automáticamente al guardar la variable.
4. Repetir en **tecny-backend (staging)** con el mismo valor — así staging
   también usa el dominio verificado.

---

## Paso 5 — Smoke test (5 min)

Después del redeploy:

1. **Test signup**: ir a `https://<frontend-prod>/signup`, crear una cuenta
   con un email tuyo NUEVO (no el owner de Resend — el punto es probar que
   ahora podés mandar a cualquiera).
2. **Esperar el email**. Llega de `iPro Portal <noreply@tecnyapp.com>`.
3. Click "Verificar email" → debería completar el flow.
4. Verificá Sentry / Railway logs — no debería haber errores de Resend.

**Si el email no llega**:
- Revisar carpeta de spam.
- Resend dashboard → **Logs** → buscar el email reciente. Si dice "Delivered"
  pero no llegó, es problema del cliente de email. Si dice "Bounced", el
  destinatario es inválido.
- Si dice "Failed: domain not verified", el cambio de `EMAIL_FROM` no se
  aplicó — confirmar que Railway redeployó con la var nueva.

---

## Rollback

Si algo sale mal y necesitás volver al estado pre-verificación:

1. Railway → revertir `EMAIL_FROM` a `iPro Portal <onboarding@resend.dev>`.
2. Redeploy automático.
3. Vuelve al estado free-tier limited (solo entrega al owner de Resend),
   pero el portal sigue funcional.

Los records DNS en GoDaddy podés dejarlos — no hacen daño si Resend no los
consume.

---

## Free tier limits post-verificación

Con dominio verificado:
- **100 emails/día**
- **3000 emails/mes**

Para el volumen actual del portal alcanza sobrado. Si en algún momento
crecemos > 3000/mes, upgrade a Pro ($20/mes, 50k emails). Mientras: monitor
el counter en Resend dashboard.
