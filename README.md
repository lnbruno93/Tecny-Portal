# Tecny Portal

<!-- Auditoría 2026-06-30 Q-04: rebrand iPro Tech/Celnyx/iPro Portal → Tecny -->
Portal de administración interna de **Tecny** — POS, ERP y cuentas corrientes
para una operación de venta de equipos y accesorios.

| Stack | Tecnología |
|-------|------------|
| Frontend | React 19 + Vite 8 + PWA (Netlify) |
| Backend | Node 20 + Express + Pino + Zod (Railway) |
| DB | PostgreSQL (Railway managed) |
| Auth | JWT HS256 + permisos por módulo |

> Sistema en producción con usuarios reales. Datos sensibles.
> **Calidad > velocidad** es regla del proyecto. Tests + audit logs + soft-deletes son no-negociables.

## Quick start

```bash
# Clonar
git clone https://github.com/lnbruno93/iPro-Portal.git
cd iPro-Portal

# Backend
cd backend
npm ci
cp .env.example .env       # editá DATABASE_URL, JWT_SECRET (≥32 chars), CORS_ORIGIN
npm run migrate            # aplica migraciones a tu DB local
npm run dev                # → http://localhost:3001 (health: /health)

# Frontend (en otra terminal)
cd ../frontend
npm ci
cp .env.local.example .env.local   # ajustá VITE_API_URL si tu backend no es :3001
npm run dev                # → http://localhost:5173
```

## Tests

```bash
# Backend — requiere Postgres corriendo (ver setup abajo)
cd backend && npm test                # Jest + supertest + DB real
cd backend && npm run test:local      # levanta PG con docker compose + jest

# Frontend
cd frontend && npm test -- --run      # Vitest single-run
cd frontend && npm test               # Vitest watch

# E2E (Playwright) — desde el root
npm run e2e:install   # primera vez: descarga Chromium
npm run e2e           # corre la suite (arranca backend+frontend automáticamente)
npm run e2e:headed    # con browser visible (debug)
```

**Setup de Postgres local para tests:** ver [`docs/LOCAL_DEV.md`](./docs/LOCAL_DEV.md).
Corren en ~3-4 segundos vs 6-8 minutos del CI — recomendado para cazar errores antes del push.

Ver [`e2e/README.md`](./e2e/README.md) para setup completo del E2E (DB dedicada, variables, troubleshooting).

## Deploy

- **Backend**: push a `main` → Railway auto-deploya. Health check `GET /health`.
- **Frontend prod**: push a `main` → Netlify build de `frontend/` y publish `dist/`.
- **Frontend staging**: push a `staging` (force-push permitido) → deploy preview de Netlify.

## Documentación

Índice completo en [`docs/README.md`](./docs/README.md). Atajos:

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — **empezá acá** si llegás cold al proyecto. Módulos, tablas, patrones, decisiones durables.
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — "tengo X síntoma, qué hago".
- [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) — deploys, rollbacks, backups.
- [`docs/DISASTER_RECOVERY.md`](./docs/DISASTER_RECOVERY.md) — escenarios de pérdida de datos + recovery.
- [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) — Sentry, /health, UptimeRobot, cron invariantes.
- [`docs/LOAD_BASELINE.md`](./docs/LOAD_BASELINE.md) — autocannon scenarios + cómo medir regresión.
- [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md) — endpoints.
- [`docs/STAGING.md`](./docs/STAGING.md) — flujo de staging.
- [`docs/STORAGE.md`](./docs/STORAGE.md) — política de archivos / blobs.
- [`docs/FEATURE_FLAGS.md`](./docs/FEATURE_FLAGS.md) — sistema on/off de flags + lifecycle.
- [`ONBOARDING.md`](./ONBOARDING.md) — guía técnica histórica (parcial; ARCHITECTURE es el nuevo punto de entrada).

## Módulos en producción

Inicio · Inventario (con Desglose 360) · Ventas · Cuentas CC · Envíos · Cotizador · Usados · Financiera · Proveedores | Compras · Egresos · Cambios de Divisa · Tarjetas de Crédito · Cajas · 360 & Capital · Proyectos · Contactos · Historial · Usuarios · Config.

## Seguridad

- No commitees `.env`, `.env.test`, `.env.local`. Verificá `.gitignore` antes de cada add.
- `JWT_SECRET` debe tener ≥ 32 caracteres (validado al boot).
- Audit logs con redacción PII para todas las mutaciones críticas.
- Soft-delete en todas las entidades de negocio (`deleted_at IS NULL`).
