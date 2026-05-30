# iPro Portal

Portal de administración interna de **iPro Tech / Celnyx** — POS, ERP y cuentas corrientes
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
# Backend
cd backend && npm test                # Jest + supertest + DB real de tests

# Frontend
cd frontend && npm test -- --run      # Vitest single-run
cd frontend && npm test               # Vitest watch
```

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
- [`ONBOARDING.md`](./ONBOARDING.md) — guía técnica histórica (parcial; ARCHITECTURE es el nuevo punto de entrada).

## Módulos en producción

Inicio · Inventario (con Desglose 360) · Ventas · Cuentas CC · Envíos · Cotizador · Usados · Financiera · Proveedores | Compras · Egresos · Cambios de Divisa · Tarjetas de Crédito · Cajas · 360 & Capital · Proyectos · Contactos · Historial · Usuarios · Config.

## Seguridad

- No commitees `.env`, `.env.test`, `.env.local`. Verificá `.gitignore` antes de cada add.
- `JWT_SECRET` debe tener ≥ 32 caracteres (validado al boot).
- Audit logs con redacción PII para todas las mutaciones críticas.
- Soft-delete en todas las entidades de negocio (`deleted_at IS NULL`).
