# Refactor: Cuenta unificada bidireccional (Terceros)

**Task**: #149
**Autor**: Lucas B. + Claude
**Fecha**: 2026-07-17 (diseño), 2026-08-03 (verificación pre-Fase-1)
**Estado**: Diseño aprobado. **Fase 0 ✅ completada** (task #150, 2026-07-17). Fases 1-3 pendientes.

**Actualización 2026-08-03**: verificación pre-Fase-1 encontró que la
Fase 0 ("cleanup precondición: consolidar fórmula del saldo en un helper
canónico") ya se hizo por task #150 (2026-07-17). Ambos helpers existen:
`backend/src/lib/saldoCC.js` (exporta `SALDO_CASE_M` para clientes) +
`backend/src/lib/saldoProveedor.js` (exporta `SALDO_CASE_M` para
proveedores). Los 2 consumers que este doc mencionaba consolidar
(`dashboardMensual.js` L328 + `chat-tools.js` L920/948) ya los usan.
Verified: 8 archivos backend consumen los helpers hoy
(alertas.js, cuentas.js, redB2b/conciliation.js, proveedores.js,
chat-tools.js, dashboardMensual.js, saldoCC.js, saldoProveedor.js).
Fase 1 puede arrancar sin pre-requisito.

## Contexto

Un cliente y también Lucas tienen el mismo problema: un "tercero" (Kevin) es SIMULTÁNEAMENTE cliente y proveedor. Hoy no se puede modelar — cliente y proveedor son entidades disjuntas en 2 tablas separadas.

**Caso concreto**:
- Kevin le compró 4 PlayStations + 1 Samsung → Kevin le debe USD 5000 (cliente CC)
- Lucas le compró PlayStations a Kevin y adelantó USD 2500 (proveedor)
- **Saldo neto real: Kevin le debe 2500 USD**. El sistema no puede representarlo.

## Decisión

**Opción C**: refactor completo a un modelo unificado bidireccional.

- Entidad única `terceros` con flags `es_cliente` + `es_proveedor` (pueden ser ambos)
- `tercero_movimientos` con tipos signed → saldo neto = SUM(monto × signo)
- UI: reemplazar Venta & Gestión B2B + Proveedores por una única "Clientes y Proveedores"
- Naming: internal `terceros`, user-facing "Cliente / Proveedor" con badges

## Fases

### Fase 0 — Cleanup precondición (~1 PR, 1 día)

**Objetivo**: consolidar la fórmula del saldo en un solo lugar ANTES del refactor. Si no se hace, la migración cristaliza el bug de que hay 2 fórmulas paralelas.

- Extraer helper `lib/terceroSaldo.js` (mismo pattern que `lib/saldoCC.js`)
- Reemplazar la CASE manual de `dashboardMensual.js:328` (proveedores) por el helper
- Reemplazar el saldo custom de `chat-tools.js:925/948` por el helper
- Tests que confirmen que los endpoints devuelven el mismo número pre/post

**Sin cambio de schema**.

### Fase 1 — Schema + migración de datos (3 PRs, 3-4 días)

**PR 1.1: Schema nuevo (aditiva)**
```sql
CREATE TABLE terceros (
  id UUID PRIMARY KEY,
  tenant_id INT NOT NULL,
  contacto_id INT REFERENCES contactos(id),
  nombre TEXT NOT NULL,
  apellido TEXT,
  whatsapp TEXT,
  ubicacion TEXT,
  categoria TEXT,               -- VIP/A+/A- de clientes_cc, NULL para ex-proveedores
  notas TEXT,
  es_cliente BOOLEAN DEFAULT FALSE,
  es_proveedor BOOLEAN DEFAULT FALSE,
  saldo_inicial_usd NUMERIC DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tercero_movimientos (
  id UUID PRIMARY KEY,
  tenant_id INT NOT NULL,
  tercero_id UUID REFERENCES terceros(id),
  fecha DATE NOT NULL,
  tipo TEXT CHECK (tipo IN (
    'venta',              -- +saldo
    'compra',             -- -saldo
    'pago_recibido',      -- -saldo
    'pago_enviado',       -- +saldo
    'adelanto_dado',      -- +saldo
    'adelanto_recibido',  -- -saldo
    'devolucion_venta',   -- -saldo
    'devolucion_compra',  -- +saldo
    'saldo_inicial'       -- signed
  )),
  monto_usd NUMERIC NOT NULL,
  monto_ars NUMERIC,
  tc NUMERIC,
  moneda TEXT DEFAULT 'USD',
  caja_id INT REFERENCES cajas(id),
  venta_id INT REFERENCES ventas(id),
  concepto TEXT,
  creado_por INT,
  created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE tercero_items (
  -- clone de items_movimiento_cc para preservar detalles ricos
  -- verificado, color, tamano, modelo, imei_serial, etc.
);
```

RLS por tenant_id (mismo pattern que rlsCanonical.js). Feature flag `flags.terceros_unificado` per-tenant.

**PR 1.2: Migración de datos (idempotente, per-tenant)**
- `clientes_cc` → `terceros` (es_cliente=true)
- `proveedores` → `terceros` (es_proveedor=true)
- **Match por (nombre_normalizado, apellido_normalizado, tenant_id)** → si aparece en ambas tablas, UNIFICAR en 1 fila con AMBOS flags
- Migrar movimientos con signo correcto (mapping table de old→new tipo)
- Preservar UUIDs viejos como legacy fields (para reversion si hace falta)
- Tests: comparar `SUM(saldo) por tenant` pre vs post — deben ser idénticos

**PR 1.3: Endpoints backend nuevos**
- `GET/POST /api/terceros`
- `GET/POST /api/terceros/:id/movimientos`
- `GET /api/terceros/:id/saldo` (usa lib/terceroSaldo.js de Fase 0)
- **Endpoints viejos siguen vivos en paralelo** — sin breaking change

### Fase 2 — UI unificada (5 PRs, ~1 semana)

- **PR 2.1**: Nueva pantalla `Cuentas.jsx` (o mantener el nombre "Venta & Gestión B2B" que ya conocen)
- **PR 2.2**: Refactor `Ventas.jsx` para linkear a `tercero_id`
- **PR 2.3**: Refactor `Envios.jsx` (cliente_cc_id → tercero_id)
- **PR 2.4**: Refactor Reportes (Capital, Sanidad, Dashboard) para consumir nuevos endpoints
- **PR 2.5**: Cmd+K + Contactos.jsx apuntando a terceros

Cada PR con feature flag: si `flags.terceros_unificado[tenant]` = true, usa nuevo path; sino, viejo.

### Fase 3 — Cutover (2 PRs, ~2 días)

- **PR 3.1**: Deprecar endpoints viejos (410 Gone con redirect header). Archivar (no borrar) tablas viejas.
- **PR 3.2**: Cleanup del código legacy. Remover feature flag.

## Riesgos identificados (top 10)

Ver reporte del agent en el análisis pre-refactor (task #149). Los principales:

1. Fórmula del saldo desincronizada — mitigado por Fase 0
2. Tipos de movimiento DISTINTOS (cliente 5, proveedor 2) — union type nuevo cubre ambos
3. `clientes_cc.categoria` (VIP/A+/A-) vs proveedores sin categoría — NULL default para ex-proveedores
4. Multi-moneda en proveedores vs USD implícito en clientes — nuevo campo `moneda` en tercero_movimientos con default USD
5. Búsqueda: proveedores solo tienen nombre, clientes nombre+apellido — apellido opcional en terceros
6. `items_movimiento_cc` — replicar como `tercero_items` (mismos campos)
7. `envios.cliente_cc_id` FK — renombrar a `tercero_id`, backfill
8. `ventas.cliente_cc_id` FK — misma decisión
9. UNIQUE cobranza-masiva por (nombre, apellido) — el UNIQUE va a nivel de es_cliente=true, sino Kevin proveedor rompe
10. `dashboardMensual` + `chat-tools` desincronizados — cubierto por Fase 0

## Downtime

**CERO** permitido — 10 tenants prod activos. Estrategia dual-write:
- Fase 1 tablas nuevas coexisten con viejas
- Fase 2 dual-writes: cada mutation escribe a las 2 (transacción)
- Fase 3 cutover controlado por feature flag per-tenant

## Rollback

Feature flag `flags.terceros_unificado[tenant_id]`. En cualquier momento se puede desactivar para un tenant específico — vuelve a usar las tablas y endpoints viejos. Datos NO se pierden.

## Estimación

| Fase | PRs | Días |
|---|---|---|
| Fase 0 preparatoria | 1 | 1 |
| Fase 1 schema + migración | 3 | 3-4 |
| Fase 2 UI | 5 | 5-7 |
| Fase 3 cutover | 2 | 2 |
| **Total** | **11** | **~2.5-3 semanas** |

## Próximos pasos

1. Aprobación del plan (Lucas)
2. Arrancar Fase 0 (helper terceroSaldo)
3. Fase 1 (schema + migración con tests exhaustivos)
