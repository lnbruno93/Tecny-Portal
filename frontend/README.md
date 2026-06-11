# iPro Portal — Frontend

SPA del portal de operaciones de iPro (B2B reseller de celulares + accesorios
en Argentina). Lleva inventario, ventas, cajas, cuentas corrientes, financiera,
proveedores, proyectos, tarjetas, cambios de divisa, conciliación y alertas.

> Documentación principal del repo: [`/README.md`](../README.md) — arquitectura,
> backend, stack, deploy. Este README es solo del frontend.

## Stack

- **React 19** + **Vite 8** (SWC) — build rápido, HMR.
- **React Router 7** — routing client-side.
- **Vitest** + Testing Library — 268+ tests unitarios + de integración.
- **ESLint** — calidad de código. NO usamos Prettier (decisión durable
  — ver `ARCHITECTURE.md §8`).
- **Sentry server-side** vía `lib/reportError.js` → `/api/client-errors`.
  NO usamos `@sentry/react` por bundle size (decisión durable).
- **vite-plugin-pwa** — instalable como PWA en desktop y mobile.

## Estructura

```
src/
├── App.jsx                  # router root + layout
├── main.jsx                 # entrypoint (createRoot)
├── styles.css               # CSS global (~1700 líneas, design system)
├── contexts/                # AuthContext, ToastContext, PageActionsContext, ConfirmModal
├── components/              # Icons, EditableCell, CajaSelectHint, TcWarning, ScrollFadeX…
├── lib/                     # api wrapper, format, money, friendlyError, useModal, xlsx…
└── screens/                 # 17 pantallas, una por módulo: Ventas, Inventario, Cajas, …
```

## Setup local

Requiere Node 20+. El backend tiene que estar corriendo en `localhost:3001`
(ver `/backend/.env.example` o `/README.md` del repo).

```bash
npm install
npm run dev          # Vite dev server en http://localhost:5173
```

Si querés apuntar a un backend remoto en lugar del local, creá un `.env.local`:

```
VITE_API_URL=https://api.tu-staging.com
```

## Scripts

| Comando             | Qué hace                                                     |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | Vite dev server con HMR.                                     |
| `npm run build`     | Build de producción a `dist/` + cleanup de sourcemaps.       |
| `npm run preview`   | Sirve el build de `dist/` localmente.                        |
| `npm test`          | Vitest en modo single-shot (`vitest run`).                   |
| `npm test -- --watch` | Vitest en modo watch (HMR de tests).                       |
| `npm run lint`      | ESLint sobre `src/`.                                         |

## Convenciones del proyecto

- **Voseo rioplatense en UI**: "tocá", "guardá", "creá" — no "haga click",
  "guarde", "cree". Sí usamos "click" en comentarios técnicos cuando se
  refiere específicamente al input de mouse.
- **Helpers compartidos en `lib/`**: cualquier función que se repita en
  2+ screens va a `lib/` (ver `format.js`, `money.js`, `friendlyError.js`,
  `dateRange.js`, `inputUtils.js`, `useModal.js`).
- **Modales con `useModal`**: Esc para cerrar + focus trap + body scroll
  lock. Patrón establecido — todo nuevo modal debe usarlo.
- **Errores al usuario**: `toast.error(err)` — el helper interno corre
  `friendlyError()` que neutraliza casos crípticos (`NO_AUTH`, TypeError).
- **CSS**: variables CSS-custom en `styles.css` (no theme-provider). Usar
  `clamp()` para tamaños fluidos en mobile/desktop antes que `@media`.

## Deploy

Build + deploy automático a Netlify desde `main` (CI). El SHA del commit se
inyecta en runtime para que Sentry resuelva sourcemaps por release.

```bash
npm run build        # local — verifica que el build cierre sin errores
```

Variables de entorno de producción están en Netlify (`VITE_API_URL`,
`VITE_SENTRY_DSN`).

## Tests

```bash
npm test -- --run             # corre TODOS
npm test Ventas               # corre solo los que matchean 'Ventas'
npm test -- --coverage        # con reporte de cobertura
```

Mocks de `lib/api` se hacen con `vi.mock('../lib/api', () => ({…}))` en cada
suite — ver `Financiera.test.jsx` o `Login.test.jsx` como referencia.
