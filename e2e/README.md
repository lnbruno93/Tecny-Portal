# E2E (Playwright)

Tests end-to-end del portal: arrancan backend + frontend, ejecutan flows reales contra Chromium y validan la UI.

## Quick start (local)

```bash
# 1. Crear la DB de E2E (una sola vez)
createdb ipro_e2e
# o, si createdb no está disponible:
psql -c "CREATE DATABASE ipro_e2e"

# 2. (opcional) Copiar el .env de e2e
cp e2e/.env.test.example e2e/.env
#   editar DATABASE_URL si el connection string no aplica

# 3. Instalar el browser de Playwright (Chromium ~150MB)
npm run e2e:install

# 4. Correr la suite
npm run e2e
```

> **NO** apuntar `DATABASE_URL` a `ipro_portal` (la DB de dev) ni a la de producción. `globalSetup` hace `TRUNCATE` de TODAS las tablas al arrancar.

## Scripts disponibles

| Script              | Hace                                                              |
|---------------------|-------------------------------------------------------------------|
| `npm run e2e`         | Corre la suite headless (modo CI).                                |
| `npm run e2e:headed`  | Abre Chromium visible — útil para debug.                         |
| `npm run e2e:ui`      | Modo UI interactivo (selector, time-travel, watch).               |
| `npm run e2e:install` | Descarga el browser Chromium si no está cacheado.                 |
| `npm run e2e:report`  | Abre el HTML report del último run (`playwright-report/`).        |

## Estructura

```
e2e/
├── .env.test.example      # template; copiar a .env (gitignoreado)
├── README.md              # este archivo
├── helpers/
│   ├── auth.js            # helper login(page, {...})
│   ├── globalSetup.js     # corre 1 vez antes de la suite (migraciones + seed)
│   ├── signup.js          # helpers para signup + verify (lee tokens de DB)
│   └── startBackend.js    # starter custom del backend (ver "Notas")
└── specs/
    ├── login.spec.js                # login feliz + error + logout
    ├── login-2fa.spec.js            # login con 2FA activo (TOTP + recovery)
    ├── signup-verify.spec.js        # signup → verify-email → portal + anti-enum
    ├── venta-retail.spec.js         # alta de venta retail
    ├── b2b-venta.spec.js            # B2B alta planilla
    ├── envio-entregado.spec.js      # envíos → entregado → venta acreditada
    ├── cobranza-masiva.spec.js      # B2B cobranza masiva
    ├── activar-2fa-ui.spec.js       # activar 2FA desde UI Config
    ├── editar-venta.spec.js         # edición de venta retail
    └── dashboard-venta.spec.js      # dashboard refleja venta nueva
```

## Variables de entorno

Lo siguiente debe estar en `e2e/.env` (local) o en el `env` del job CI:

| Variable               | Default                                                                            |
|------------------------|------------------------------------------------------------------------------------|
| `DATABASE_URL`         | `postgresql://lucasbruno@localhost:5432/ipro_e2e`                                  |
| `JWT_SECRET`           | `e2e_test_jwt_secret_min_32_chars_padding_xyz` (≥32 chars)                         |
| `TWOFA_ENCRYPTION_KEY` | 64 hex chars (32 bytes) — generar con `openssl rand -hex 32`                       |
| `PORT`                 | `3001` (backend; cambiar requiere ajustar el config Playwright)                    |

## Notas de diseño

### Por qué hay `startBackend.js` en lugar de `node server.js`

`backend/server.js` corre `dotenv.config({override:true})` cuando `NODE_ENV !== 'production'`. Eso pisa `DATABASE_URL` con el `backend/.env` de desarrollo (apunta a `ipro_preview`) — un test corriendo contra esa DB sería catastrófico.

El starter custom monkey-patchea el módulo `dotenv` (interceptando `Module._resolveFilename` para cualquier `require('dotenv')`, sea desde el root o desde `backend/node_modules`) para que sea no-op antes de cargar `server.js`. Es feo pero localizado en un solo archivo y NO requiere cambios en backend/.

Solución limpia para el futuro: agregar un flag tipo `SKIP_DOTENV=1` en `server.js` y eliminar el monkey-patch.

### Por qué solo Chromium

El portal solo se usa en Chrome/Edge (desktop) y Chrome móvil. Sumar Firefox/WebKit triplica el tiempo de CI sin agregar señal real. Cuando haya un bug específico de un browser distinto lo sumamos puntualmente.

### Por qué `globalSetup` re-implementa el SQL de `backend/tests/helpers/setup.js`

Importar el helper de Jest desde Playwright es factible pero acopla los dos lifecycles (Jest hace dotenv con `setupFiles`). Replicar el bloque SQL (~40 líneas) es más simple y explícito. **Deuda**: si el schema cambia, hay que tocar AMBOS archivos. Marcado con comentario en `globalSetup.js`.

### Por qué la suite corre serial (`workers: 1`)

Todos los tests pegan a la misma DB compartida. Paralelizar requeriría una DB por worker (factible pero overkill para 3 tests). Cuando la suite crezca >20 tests revisamos.

## Troubleshooting

- **"Failed to fetch" en el login**: backend caído o `CORS_ORIGIN` no incluye `localhost:5173`. El config Playwright ya lo setea — si lo desactivás explícitamente, va a romper.
- **Timeout esperando `/inicio`**: el helper navega a `/` (NO a `/login`), porque el redirect a `/inicio` solo dispara desde la `index Route`. Si cambiás esto, revisá la asunción.
- **"A Store instance must not be shared"**: `NODE_ENV` no llegó como `'test'` al backend. Verificá `playwright.config.js` → `SHARED_ENV` y que `startBackend.js` esté siendo invocado.
- **Migrations fail**: la DB `ipro_e2e` no existe. Correr `createdb ipro_e2e`.
