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

### ~~LOW-B1 · Logs de sync de contactos ruidosos en tests~~ ✅ CERRADO
**Cerrado en:** commit `4b7567a`. El catch en `syncContactoSafe` detecta el
código `23505` y lo degrada a `info` con payload mínimo (sin stack). Sigue
escapando como `warn` para errores reales.

### ~~LOW-B2 · Soft-delete sin compactación periódica~~ ✅ CERRADO
**Cerrado en:** este PR. Script `backend/scripts/compactar-soft-deletes.js`
(manual, no automático) con DRY-RUN por default. Whitelist explícita:
`caja_movimientos`, `movimientos_deudas`, `movimientos_inversiones`.
Ventana de retención configurable (default 12 meses). Documentado en
`docs/OPERATIONS.md` sección 5.

### ~~NIT-B3 · `SELECT FOR UPDATE` sin `ORDER BY id` en algunos paths~~ ✅ CERRADO
**Cerrado en:** commit `d7cd462`. Auditoría completa de todos los `FOR UPDATE`
en `src/routes/` y `src/lib/`. Único hallazgo real: `proveedores.js` en el
DELETE de compra (multi-row sobre `proveedor_movimiento_id = $1`), agregamos
`ORDER BY id` antes de `FOR UPDATE`. Resto ya tenía orden estable (sort en JS,
ANY+ORDER BY en SQL, o single-row).

---

## Frontend

### ~~MEDIUM-F1 · `blockInvalidNumberKeys` solo aplicado a 3 modales~~ ✅ CERRADO
**Cerrado en:** commit `2dbc063` (PR fix/followup-number-inputs).
**Resumen:** Cobertura final 67/67 inputs `type="number"` en screens +
components con `onKeyDown={blockInvalidNumberKeys}`. 14 archivos tocados,
55 handlers nuevos. Sed + perl + inyección de import automatizada.

### ~~LOW-F2 · Loading state de PDF solo en Ventas~~ ✅ CERRADO
**Cerrado en:** commit `31a0a48`. Extraído el patrón al hook reutilizable
`useLoadingAction` (lib/useLoadingAction.js). Ventas.jsx migrado como demo.
Cuando se agregue PDF a B2B / Cobranzas / etc., el código es:
```js
const { loading, run } = useLoadingAction();
<button disabled={loading} onClick={() => run(generarPDF)}>...
```

### ~~LOW-F3 · `<input type="number">` no acepta coma como decimal~~ ✅ CERRADO
**Cerrado en:** commit `4438bb6`. `blockInvalidNumberKeys` ahora permite coma
por DEFAULT (allowComma: true). Helper `normalizeDecimal(str)` exportado para
parsing LATAM: `"1,50" → "1.50"`, `"1.234,56" → "1234.56"`. NO migramos los
67 callers de Number(x) a Number(normalizeDecimal(x)) — eso queda para
próximas oleadas en los puntos calientes (modales spreadsheet, ventas).

### ~~NIT-F4 · `scroll-fade-x` no detecta si hay realmente overflow~~ ✅ CERRADO
**Cerrado en:** commit `8396c3f`. Nuevo componente `<ScrollFadeX>` con
ResizeObserver + scroll listener: muestra fade SOLO si hay overflow real
y agrega fade izquierdo cuando el user ya scrolleó. Inventario.jsx migrado.
La utility `.scroll-fade-x` original (versión permanente) queda intacta
para usos legacy.

### ~~NIT-F5 · `applyDefaultsToEmpty` del hook compartido sigue sin ser usado~~ ✅ CERRADO
**Cerrado en:** commit `1b816ad`. Los 3 modales spreadsheet (CompraProveedor,
CobranzaMasiva, VentaB2B) ahora toman `rows/setRows/updCell/removeRow` del
hook `useSpreadsheetRows`. `addRows` se mantiene custom (recibe defaults
runtime), `applyDefaultsToEmpty` también porque cada modal tiene su propia
semántica de "fila tocada" (M-10 con compare-against-template en Compra).

---

## Tests

### ~~LOW-T1 · Cobertura de `cobranzaMasiva` solo cubre happy path~~ ✅ CERRADO
**Cerrado en:** commit `b2b9331`. 3 tests nuevos: caja inexistente en posición
intermedia (rollback total), caja soft-deleted entre setup y cobranza (vía
SQL directo), cliente soft-deleted (paralelo). Como side-effect agregamos
`skip: () => process.env.NODE_ENV === 'test'` al `cobranzaLimiter`.

### ~~NIT-T2 · Tests de modales spreadsheet (frontend)~~ ✅ CERRADO
**Cerrado en:** commit `1ad25fb`. 12 smoke tests nuevos (4 por modal) con
mocks de api + ToastProvider + ConfirmProvider. Verifican: render del
header, cantidad inicial de filas, total "—" con rows vacías (#M-13),
"+ N filas" agrega exactamente N. Lo que NO cubrimos (E2E): AutocompletePicker,
save real al backend, navegación teclado, paste-from-excel.

---

## Docs

### ~~NIT-D1 · `docs/API_REFERENCE.md` desactualizado~~ ✅ CERRADO
**Cerrado en:** este mismo PR. Se agregaron 9 secciones nuevas: Inventario,
Ventas, Cuentas CC (incluyendo cobranza masiva), Proveedores (paginado #M-06),
Tarjetas, Egresos, Cambios de divisa, Proyectos, y Cajas: CRUD/movimientos
(`/api/cajas/cajas`). +181 líneas, mismo nivel de detalle que las secciones
existentes (lista de endpoints + sample por método principal).

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
