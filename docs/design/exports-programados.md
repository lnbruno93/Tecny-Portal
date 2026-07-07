# Exports Programados por Email

**Estado**: 🛠 DISEÑO — feature de bajo riesgo, alto valor.
**Fecha**: 2026-07-06.
**Origen**: hoy los users descargan XLSX manualmente cada fin de mes. Contadores piden data en fechas fijas. Feature que los usuarios existentes usarían inmediatamente.
**Effort estimado**: 3-4 días. F1 ≈ 1.5 días schema + cron + generator, F2 ≈ 1 día UI, F3 ≈ 1 día email delivery + tests + docs.

---

## 1. Motivación

### 1.1 Qué resolvemos

Ritual del fin de mes que todos los tenants viven:
1. Contador llama: "necesito el XLSX de ventas del mes".
2. Alguien entra al portal, va a Ventas, filtra por mes, exporta, descarga.
3. Repite para egresos, cajas, comprobantes.
4. Adjunta 4 XLSX en email al contador.
5. Contador procesa y re-envía correcciones si algo no cierra.

Y todos los meses lo mismo. Data disponible desde hace 30 días pero requiere accion humana.

### 1.2 Qué proponemos

Sistema de **exports programados**:
- User elige qué exportar (ventas, egresos, comprobantes, stock snapshot).
- Elige frecuencia (mensual, semanal, día del mes).
- Elige destinatarios (emails, no requiere que sean users del portal — el contador NO tiene cuenta).
- Cron nightly evalúa qué exports disparar hoy.
- Genera XLSX (o ZIP con múltiples XLSX si eligió varios).
- Envía por email via Resend (ya integrado en el portal).

### 1.3 Por qué importa

- **Reduce trabajo manual repetitivo** — feature que "se instala una vez y funciona para siempre".
- **Aumenta retention**: users que setean exports automáticos dependen del portal para su flujo contable → churn más bajo.
- **Habilita "contador como stakeholder"**: el contador recibe data del portal aunque no tenga cuenta → el contador presiona al cliente para seguir usando Tecny.
- **Value prop concreto en signup**: "Setealo una vez, dejá de exportar a mano". Landing bullet fácil de comunicar.

### 1.4 Por qué es proyecto serio (aunque simple)

- **Tiempo del cron** — mucha carga en un solo momento (medianoche) puede saturar. Escalar horizontal + jitter.
- **Delivery reliability**: si Resend cae, no enviar duplicados al re-intentar.
- **File size**: 6 meses de ventas de un tenant grande → XLSX de 50 MB. Attachments enormes en email fallan. Cambiar a link temporal (R2 signed URL).
- **PII**: exports contienen contactos, saldos, ventas → si el email del contador se comprometió, los exports comprometen data. Encriptar? Password? Consideración legal.

---

## 2. Diseño

### 2.1 Componentes

```
┌────────────────────────────────────────────────────────────┐
│ UI: Config → tab "Exports automáticos"                     │
│  - Lista de exports configurados                           │
│  - Crear nuevo: form con qué + cuándo + a quién            │
│  - Historial: "último envío 2026-06-30 ✓" o "falló ✗"     │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│ BACKEND                                                     │
│                                                             │
│  Migration: exports_scheduled                              │
│                                                             │
│  Endpoints CRUD /api/exports-scheduled                     │
│                                                             │
│  Cron nightly (03:00 ART = después del día calendario ART) │
│    for each active export:                                 │
│      if scheduled_for_today:                               │
│        generateExport(export)                              │
│                                                             │
│  lib/exportGenerator.js                                    │
│    generateVentas(tenantId, from, to) → xlsx.Buffer        │
│    generateEgresos(...) → xlsx.Buffer                      │
│    generateComprobantes(...) → xlsx.Buffer + zip PDFs      │
│                                                             │
│  lib/exportEmail.js                                        │
│    sendExport(export, files)                               │
│      → si sum(files.size) > 15 MB: subir a R2 signed URL   │
│      → email HTML con link                                 │
│      → attach XLSX si < 15 MB                              │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Schema

```sql
CREATE TABLE exports_scheduled (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       INT REFERENCES users(id),   -- quién creó
  name          TEXT NOT NULL,              -- "Cierre mensual contador"
  content       TEXT[] NOT NULL,            -- ['ventas','egresos','comprobantes']
  frequency     TEXT NOT NULL,              -- 'monthly' | 'weekly' | 'daily'
  day_of_month  INT,                        -- 1-31 (para monthly)
  day_of_week   INT,                        -- 0-6 (para weekly, 0=Sunday)
  recipients    TEXT[] NOT NULL,            -- ['contador@example.com']
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  period_days   INT NOT NULL DEFAULT 30,    -- cuántos días atrás incluir
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at   TIMESTAMPTZ,
  last_status   TEXT,                       -- 'success' | 'error'
  last_error    TEXT
);

CREATE TABLE exports_history (
  id            BIGSERIAL PRIMARY KEY,
  scheduled_id  BIGINT NOT NULL REFERENCES exports_scheduled(id) ON DELETE CASCADE,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL,              -- 'success' | 'error'
  error_message TEXT,
  files_meta    JSONB,                      -- [{ name, size, url_expiry }]
  emails_sent   INT NOT NULL DEFAULT 0
);
```

RLS con FORCE. Índice `(tenant_id, active) WHERE deleted_at IS NULL`.

### 2.3 Cron

Reutiliza `node-cron` que ya está en el portal (misma infra que `chatCleanupJob`). Corre a las 03:00 ART (ya pasó cierre del día calendario, backups nightly ya se hicieron, backend idle).

```js
cron.schedule('0 3 * * *', async () => {
  const today = getArgentinaDate();
  const dueExports = await db.query(
    `SELECT * FROM exports_scheduled
      WHERE active = true
        AND (
          (frequency = 'daily') OR
          (frequency = 'weekly' AND day_of_week = $1) OR
          (frequency = 'monthly' AND day_of_month = $2)
        )
        AND (last_run_at IS NULL OR last_run_at < $3)`,
    [today.dayOfWeek, today.dayOfMonth, today.startOfDay]
  );

  for (const exp of dueExports.rows) {
    await runExport(exp).catch(err => {
      // log + retry mañana automáticamente
    });
  }
});
```

Jitter: dispersar tenants en un window de 30 min para no saturar (`setTimeout(random(0, 30 * 60 * 1000))`).

### 2.4 Generators

Cada tipo de export tiene su propio generator que devuelve un Buffer XLSX. Estos ya existen mayormente — el portal tiene botones "Exportar" en varias pantallas. Extraer a `lib/exports/*.js` reutilizable:

```
lib/exports/
  ventas.js       — GET /api/ventas + xlsx build (extraído del route actual)
  egresos.js
  comprobantes.js — incluye ZIP con PDFs de venta_comprobantes
  stock.js        — snapshot de productos
  cajas.js        — historial + saldos actuales
```

### 2.5 Delivery

- Si sum(files.size) < 15 MB: attach al email.
- Sino: subir a R2 con signed URL de 7 días de expiración. Email con link + password (autogenerado, mostrado al owner en portal).
- Template email con headers Tecny + resumen ("Ventas del período 2026-06-01 a 2026-06-30: 42 ventas por USD 15200").
- BCC al owner del tenant (audit trail).

### 2.6 UI

```
┌───────────────────────────────────────────────────────────┐
│ Config → Exports automáticos                              │
│                                                            │
│ [+ Nuevo export]                                          │
│                                                            │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Cierre mensual contador                              │ │
│ │ Ventas + Egresos + Comprobantes                     │ │
│ │ Todos los días 1 del mes                            │ │
│ │ → contador@estudio.com.ar                           │ │
│ │ Último envío: 2026-06-01 ✓                          │ │
│ │ [Editar] [Enviar ahora] [Pausar]                    │ │
│ └──────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

Modal "Nuevo export":
1. Nombre.
2. Qué incluir (checkboxes con preview de columnas).
3. Cuándo (frequency + día).
4. A quién (emails separados por coma, validar).
5. Rango de días atrás (default 30, editable).
6. Botón "Enviar de prueba ahora" para test.

---

## 3. Fases

### F1 — Schema + generators + cron (1.5 días)
- Migration.
- Refactor de generators actuales a `lib/exports/*.js` (los que ya existen).
- `lib/exportRunner.js` que orquesta 1 export.
- `jobs/exportsJob.js` cron nightly.
- Tests unitarios: cada generator devuelve XLSX válido con las filas esperadas.

### F2 — UI (1 día)
- Pantalla "Exports automáticos" en Config.
- CRUD endpoints.
- Modal de creación con validación.
- Botón "Enviar ahora" para test manual.

### F3 — Delivery + docs (1 día)
- Integración con Resend (ya está en portal para email verification).
- Signed URL R2 para archivos grandes.
- Template email HTML polished.
- Docs de usuario ("Cómo configurar un export").
- RUNBOOK ops: cómo debuggear un export que falla.

---

## 4. Riesgos + trade-offs

### 4.1 Cron congestion
100 tenants × 3 exports = 300 exports a las 03:00 ART. Sin jitter, saturan CPU + DB + email. Con jitter en window 30 min → 10 exports/min promedio, manejable.

Si crecemos a 1000 tenants, mover a job queue (Redis Streams + workers).

### 4.2 File size explosion
6 meses de un tenant grande → XLSX 100 MB, ZIP comprobantes → 500 MB. Email attachments fail.
- Regla: XLSX > 15 MB → link R2 obligatorio.
- Warning en UI: "Este export estimado 25 MB, se enviará como link".

### 4.3 PII / seguridad
- Recipients emails van en plain text. Si el email del contador se hackea, los últimos 30 días de la empresa quedan expuestos.
- Mitigation: link R2 con password autogenerado. El owner recibe el password en la UI del portal (NO por email). Debe compartirlo por canal separado con el contador.
- Alternativa: encriptar XLSX con password (usando openssl o exceljs plugin) → el password lo comunica el owner offline.
- Consultar con Lucas si es aceptable no encriptar en F1 (simplicidad) o incluir desde el vamos.

### 4.4 Delivery failure handling
- Resend down → retry mañana en el próximo cron.
- Recipient rechaza (buzón lleno): registrar bounce, notificar al owner.
- Email marcado como spam por Google: no lo sabemos. Mitigation: DMARC/DKIM ya está configurado en tecnyapp.com.

### 4.5 Cambio de columnas del export
Si mañana agregamos columna "descuento" a ventas, el XLSX cambia. Contadores automatizados esperando N columnas se rompen.
- Regla: solo AGREGAR columnas al final. NUNCA renombrar ni quitar.
- Versioning de exports (export.version=v1, v2 diferente shape) — deferido.

### 4.6 Timezone confusion
"Del 1 al 30" en ART != UTC. Cron corre en UTC de Railway. Todos los exports deben usar `America/Argentina/Buenos_Aires` para calcular ranges. Reutilizar helpers existentes de `chatCleanupJob`.

---

## 5. Tests

- Generator: producir XLSX con N filas mockeadas → validar shape.
- Cron: dado 3 exports pending, corre los 3.
- Delivery small file: attach en email.
- Delivery large file: sube a R2, email con link.
- Failure: Resend error → status='error', reintenta mañana.
- RLS: tenant A no ve exports_scheduled de tenant B.

---

## 6. Métricas de éxito

- **30 tenants con al menos 1 export activo** a 3 meses.
- **Retention diferencial**: tenants con exports auto tienen churn -50% vs tenants sin (a validar).
- **99% delivery success rate** (excluyendo fallas del email del recipient).
- **NPS bump**: preguntar a users con exports "¿te ahorra tiempo?" — target ≥ 8/10.

---

## 7. Deferrable a fase 2

- **Exports personalizables**: user elige columnas específicas.
- **Filtros avanzados**: exportar solo B2B, solo ventas > $X, solo de un vendedor.
- **PDF summary**: acompañar XLSX con PDF ejecutivo de KPIs del período.
- **Integración directa con contabilidad**: en vez de email, POST a API del contador (Tango, Bejerman, etc.).
- **Templates**: "cierre mensual contador", "backup semanal ops" — plantillas pre-configuradas.
- **Google Drive / Dropbox** delivery target.
