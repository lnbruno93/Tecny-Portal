# Desarrollo local — tests de integración con Postgres

**TL;DR:** una vez configurado, correr backend tests localmente toma **3-4 segundos** en vez de los 6-8 minutos del CI.

```bash
# One-time (ya hecho para Lucas — próxima Mac nueva sigue estos pasos):
brew install --cask orbstack             # Docker liviano para Mac
brew services stop postgresql@16          # si tenés PG nativo, apagarlo
cp backend/.env.test.example backend/.env.test  # config test-only

# Cada vez que arrancás a codear (en el root del repo):
docker compose up -d --wait               # levanta Postgres 16 (5-10s primera vez, <1s después)

# Correr tests locales tantas veces como quieras:
cd backend
npm test                                  # jest --runInBand contra el PG local
npx jest tests/clasesProducto.test.js     # o filtrar por archivo específico

# Al terminar de laburar:
docker compose down                       # apaga PG (data preservada en volumen)

# Reset completo si algo se corrompió:
docker compose down -v                    # -v borra el volumen (drop DB)
docker compose up -d --wait               # empezás de cero
```

## Cómo funciona

- **`docker-compose.yml`** (repo root) — levanta un contenedor `tecny-postgres-test`
  con Postgres 16, mismos user/pass/db que el CI (`ipro:testpass@ipro_test`).
  Ver comentarios adentro del archivo para el detalle.
- **`backend/.env.test`** — cargado por `tests/helpers/setEnv.js` antes de Jest.
  Apunta a `localhost:5432` con las credenciales del container.
  **No se commitea** (está en `.gitignore`) — hay un `.env.test.example`
  con el mismo contenido para que cualquier dev lo copie.
- **`backend/tests/helpers/setup.js`** — al arrancar cada suite, corre
  `npm run migrate` (crea/actualiza el schema) + limpia data + crea admin
  user de prueba. Idempotente: la primera corrida crea el schema, las
  siguientes solo aplican migrations nuevas.

## Scripts útiles (backend/package.json)

| Script | Qué hace |
|---|---|
| `npm test` | Solo Jest. Requiere PG ya levantado y `.env.test` presente. |
| `npm run test:local` | Levanta PG (con `docker compose --wait`) + Jest. Uso típico. |
| `npm run test:local:down` | Apaga el container. |
| `npm run test:local:reset` | Borra volumen + relevanta. Uso: DB corrupta / schema inconsistente. |

## Troubleshooting

### `error: role "ipro" does not exist`
Tenés Postgres nativo corriendo en el puerto 5432 que atrapa las conexiones antes que el Docker.
Solución:
```bash
brew services stop postgresql@16      # si es Homebrew
# o cerrar Postgres.app si es la app oficial
```

### `Connection refused` en `localhost:5432`
El container no está corriendo. Verificá con:
```bash
docker ps                              # tecny-postgres-test debe aparecer con Status "Up ... (healthy)"
docker compose up -d --wait            # levantarlo si no está
```

### Tests fallan con datos residuales
La suite `setup.js` limpia data al arrancar, pero si algo raro pasó:
```bash
docker compose down -v && docker compose up -d --wait
```

### Necesito correr un solo test
```bash
cd backend
npx jest tests/clasesProducto.test.js                    # un archivo
npx jest -t "GET con filtro"                             # tests con "GET con filtro" en el nombre
npx jest tests/clasesProducto.test.js -t "GET con filtro"  # combinar
```

## Diferencias con el CI

- **Orchestrator distinto** — CI usa GitHub Actions service containers, local usa `docker compose`. Es agnóstico: solo importa que Postgres responda en la connection string.
- **E2E local vs CI** — CI usa una DB separada `ipro_e2e` para Playwright. Localmente reusamos `ipro_test` (raro que un dev necesite E2E completo local). Si hace falta, se puede agregar un segundo service en el `docker-compose.yml`.
- **Migrations** — mismo `node-pg-migrate up`, mismo path.

## Beneficio medido

Con este setup, PR #530 (F3.c-1) hubiera cerrado en 1 intento en vez de 2 —
los 4 tests que fallaron en CI hubieran fallado local también, se hubieran
fixeado antes del push, y ahorraríamos ~15 min de ciclo CI.

## Historia

Setup implementado el 2026-07-09 tras jornada del 2026-07-08 donde varios
PRs iteraron 2-3 veces por errores que se cazan localmente (Zod `.partial()`
sobre refined schemas, `SET LOCAL` dinámico, PG_TYPES faltante, tests con
supuestos país-específicos).
