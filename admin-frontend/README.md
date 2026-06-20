# Tecny Admin Console

App separada del portal de usuarios — corre en `admin.tecnyapp.com` para que
Lucas (super-admin) gestione tenants del SaaS Tecny.

Es una SPA Vite + React 19 + react-router-dom v7, sin librería UI extra. El
backend es el mismo de prod (`tecny-backend-production.up.railway.app`); los
endpoints viven bajo `/api/super-admin/*` y solo responden si el JWT del user
tiene `is_super_admin = true`.

## Desarrollo local

```bash
cd admin-frontend
npm install
npm run dev
```

Por defecto levanta en `http://localhost:5174` (port elegido para no chocar con
el portal en 5173).

## Variables de entorno

| Variable        | Default                                              | Notas                                                                  |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `VITE_API_URL`  | `https://tecny-backend-production.up.railway.app`    | Base URL del backend. Debe arrancar con `http://` o `https://`.        |

Si la URL está seteada sin protocolo, el módulo `lib/api.js` lanza error al
cargar (replica del hardening del portal — bug 2026-06-19, ver comentario en
`frontend/src/lib/api.js`).

Crear `.env.local` para overridear en dev:

```
VITE_API_URL=http://localhost:3001
```

## Scripts

| Script            | Qué hace                                          |
| ----------------- | ------------------------------------------------- |
| `npm run dev`     | Vite dev server con HMR.                          |
| `npm run build`   | Bundle de producción a `dist/`.                   |
| `npm run preview` | Sirve el build localmente.                        |
| `npm test`        | Vitest run (no watch).                            |

## Estado actual (Fase 3)

Incluye:
- Login + ProtectedRoute con gate de `is_super_admin`.
- `/tenants` — lista filtrable por plan / estado / search debounced.
- Placeholders en `/tenants/:id` y `/metrics` (Fase 4).

Pendiente (Fase 4):
- Detalle de tenant + acciones (extender trial, suspender, reactivar, cambiar plan).
- Dashboard de métricas globales (MRR, signups, churn, conversion).
- Tab de actividad por tenant (ventas, cajas, bot, alertas, audit).

## Deploy

Pendiente — se va a configurar como site Netlify separado apuntando a
`admin.tecnyapp.com`. El bundle no debe servirse jamás desde el dominio del
portal de usuarios (boundary de seguridad).
