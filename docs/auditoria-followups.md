# Auditoría hiper-exhaustiva — Follow-ups

Resumen de los hallazgos de la auditoría 2026-05 que NO se atacaron en las TANDAs
0-5 y quedan como deuda explícita. Cada uno tiene severidad (LOW / NIT), área y
trabajo concreto sugerido. El criterio para diferir fue: no bloquean operaciones,
no comprometen integridad, no son riesgo de seguridad. Se atacarán en oleadas
incrementales sin urgencia.

> Histórico de lo que SÍ se atacó:
> - TANDA 0: 10 BLOCKERs (hot-fix antes de seguir)
> - TANDA 1: HIGH de concurrencia + seguridad (H-01..H-08)
> - TANDA 2: Performance crítica (P-01..P-05)
> - TANDA 3: Tests críticos faltantes (T-01..T-04)
> - TANDA 4: Hygiene & DX refactors (R-01..R-06)
> - TANDA 5: UX & MEDIUMs restantes (M-01..M-13)

---

## Backend

### LOW-B1 · Logs de sync de contactos ruidosos en tests
**Dónde:** `backend/src/lib/contactosSync.js`
**Por qué:** Cada vez que un test crea un proveedor con nombre+apellido que ya
existe en `contactos`, el best-effort sync escupe un error 23505 al logger. No
rompe nada (es catch-and-log) pero ensucia la salida de tests.
**Fix:** Detectar el código `23505` en el catch y degradar a `level: 30` (info)
o suprimirlo si `process.env.NODE_ENV === 'test'`.

### LOW-B2 · Soft-delete sin compactación periódica
**Dónde:** Tablas con `deleted_at`: caja_movimientos, items_movimiento_cc,
proveedor_movimientos, productos, etc.
**Por qué:** Soft-deletes nunca se purgan. Al año vamos a tener decenas de
miles de filas "fantasma" que solo cuentan para los índices.
**Fix:** Migración + job periódico que hard-delete rows con
`deleted_at < NOW() - INTERVAL '6 months'` y ref_id ya no referenciada.
Hacerlo después de definir política de retención formal.

### NIT-B3 · `SELECT FOR UPDATE` sin `ORDER BY id` en algunos paths
**Dónde:** Buscar `FOR UPDATE` en routes/, identificar los que iteran sobre
arrays sin ordenar primero.
**Por qué:** Riesgo teórico de deadlock entre 2 sesiones que lockean los mismos
ids en orden inverso. En la práctica es muy improbable con el volumen actual
pero la disciplina es barata.
**Fix:** Auditar y agregar `ORDER BY id` antes de cada `FOR UPDATE` masivo.

---

## Frontend

### MEDIUM-F1 · `blockInvalidNumberKeys` solo aplicado a 3 modales (#M-11 follow-up)
**Dónde:** `frontend/src/screens/` — `Ventas.jsx`, `Envios.jsx`,
`Inventario.jsx`, `Usados.jsx`, `Proveedores.jsx`, `Tarjetas.jsx`. Hay ~25
inputs `type="number"` sin el handler.
**Por qué:** El usuario sigue pudiendo tipear 'e' o '+' y borrar silenciosamente
una cifra de monto. En M-11 atacamos los 3 modales spreadsheet (mayor riesgo
por velocidad de tipeo) y diferimos el resto.
**Fix:** Para cada archivo, agregar
```js
import { blockInvalidNumberKeys } from '../lib/inputUtils';
```
y reemplazar `<input type="number"` por
`<input type="number" onKeyDown={blockInvalidNumberKeys}`.
Sed listo para usar:
```bash
sed -i '' 's/<input type="number"/<input type="number" onKeyDown={blockInvalidNumberKeys}/g' <archivo>
```
Verificar el import después.

### LOW-F2 · Loading state de PDF solo en Ventas (#M-12 follow-up)
**Dónde:** `frontend/src/components/CompraProveedorModal.jsx` y otros lugares
que generan PDF / Excel.
**Por qué:** En Ventas se atacó porque el modal "éxito" es el más recurrente.
Otros generadores (export Excel, futuros comprobantes B2B) podrían heredar
el patrón.
**Fix:** Cuando se agregue PDF a B2B o Cobranzas, reusar el patrón
`pdfLoading` state + `disabled` + "Generando…".

### LOW-F3 · `<input type="number">` no acepta coma como decimal
**Dónde:** Todos los inputs numéricos.
**Por qué:** Usuarios LATAM a veces tipean "1,50" en vez de "1.50". El input
HTML lo trata como inválido y queda vacío.
**Fix:** Considerar un componente `<NumberInput>` que en `onChange` reemplace
coma por punto antes de pasar al state. O dejar como está y entrenar a los
usuarios (tradeoff).

### NIT-F4 · `scroll-fade-x` no detecta si hay realmente overflow
**Dónde:** `frontend/src/styles.css` — utility introducida en #M-09.
**Por qué:** El gradient se muestra siempre, incluso cuando los tabs entran
en pantalla (lo que es visualmente innecesario aunque inofensivo).
**Fix:** Wrapper componentizado con ref + `ResizeObserver` que toggle una
clase `.has-overflow`. Solo si visualmente molesta — por ahora es sutil.

### NIT-F5 · `applyDefaultsToEmpty` del hook compartido sigue sin ser usado
**Dónde:** `frontend/src/lib/useSpreadsheetRows.js`.
**Por qué:** El hook ofrece `applyDefaultsToEmpty` pero los 3 modales
(Compra, Cobranza, VentaB2B) siguen con su propia versión inline. En M-10
fixeé las 3 implementaciones pero no migré al hook compartido para no
mezclar fixes con refactor.
**Fix:** Migrar los 3 modales a usar `useSpreadsheetRows.applyDefaultsToEmpty`
(R-01 follow-up). Requiere también consolidar `mkRow`/`isUsedRow`.

---

## Tests

### LOW-T1 · Cobertura de `cobranzaMasiva` solo cubre happy path
**Dónde:** `backend/tests/cuentas.test.js`.
**Por qué:** Tenemos tests del flujo OK pero no del rollback por cliente
inválido en posición N>0, ni de race con cobranzas concurrentes sobre el
mismo cliente.
**Fix:** Agregar 2-3 tests adicionales que ejerciten los caminos de error.

### NIT-T2 · Tests de modales spreadsheet (frontend)
**Dónde:** `frontend/src/components/` — no hay tests para
CompraProveedorModal/CobranzaMasivaModal/VentaB2BModal.
**Por qué:** Son los componentes más complejos (planilla + defaults +
parser de clipboard + cálculo total). Los movemos sin tests E2E.
**Fix:** Setup de @testing-library/react + Vitest + tests de smoke (render,
addRow, isUsedRow, totalUsd). Es trabajo de medio día.

---

## Docs

### NIT-D1 · `docs/API_REFERENCE.md` desactualizado
**Dónde:** `docs/API_REFERENCE.md`.
**Por qué:** No tiene los endpoints nuevos de proveedores paginados (#M-06),
ni cobranza masiva, ni egresos de caja.
**Fix:** Pasada de generación auto desde los router de Express + Zod schemas
(quizá con un script `npm run docs:api`).

---

## Convenciones para próximas tandas

1. **Cada fix:** comentario `#X-NN` en el código apuntando al ID de auditoría.
   Facilita el back-tracking si el comportamiento se pone en duda más tarde.
2. **Cada commit:** menciona los IDs atacados en el subject y agrupa por
   severidad y área. NO mezclar HIGH+LOW en el mismo commit.
3. **Cada tanda:** opcional pero útil — un script que corra el linter,
   los tests y el build antes de empujar. Hay un draft en `.github/workflows/`.
4. **Push:** primero a `staging` (force-push permitido) para review en Netlify
   preview. Después abrir PR a `main` y esperar merge manual del PO.
