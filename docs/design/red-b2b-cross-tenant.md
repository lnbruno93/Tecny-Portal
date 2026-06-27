# Red B2B — Operaciones cross-tenant entre clientes Tecny

**Estado**: 📐 DISEÑO (no implementado todavía)
**Fecha**: 2026-06-27
**Origen**: idea de Lucas tras cerrar el 6to cliente — convertir a Tecny en una red B2B con efectos de red, donde los tenants se invitan entre sí y operan digitalmente.
**Effort estimado**: 14-21 días bien hechos, partido en 5 fases mergeables.
**Decisiones cerradas con Lucas**: ver sección 3.

---

## 1. Resumen ejecutivo

### 1.1 Qué resolvemos

Hoy un cliente Tecny (ej. iPro/Celnyx) le vende en B2B a otro reseller que **NO es cliente Tecny** (ej. TekHaus). Para que TekHaus también use Tecny, hay que convencerlo "por afuera" — sin ninguna ventaja operativa más allá del producto en sí.

**Cuando ambos son clientes Tecny**, la operación entre ellos hoy igual es manual del lado del comprador: TekHaus tiene que cargar a mano la compra que recibió, los productos, los precios, sumar el comprobante, conciliar saldos contra iPro. Doble trabajo, doble fuente de error, saldos que divergen.

### 1.2 Qué proponemos

**Cross-tenant operations**: si dos tenants son "partners" (vínculo bilateral aceptado), una venta B2B del lado del seller se replica automáticamente como compra del lado del buyer. Inventario, cuentas corrientes, pagos y conciliación quedan sincronizados sin intervención humana del lado del buyer.

### 1.3 Por qué importa para el negocio

- **Network effect real**: cada cliente nuevo no es 1 venta — es potencialmente N (su red de proveedores y compradores B2B). El producto crece más rápido que el esfuerzo de marketing.
- **Lock-in saludable**: una vez que la cadena cliente→proveedor está armada digitalmente, salirse de Tecny rompe la integración con todos los partners. El costo de switching sube sin abusar del cliente.
- **Argumento de venta brutal del lado del comprador**: "tu proveedor usa Tecny → tus compras se cargan solas, sin tipear, sin OCR, sin armar items". El vendedor invita y el comprador casi no puede decir que no.
- **Combina con sistema de referidos** (deferred — Lucas lo trata aparte): "invitá a tu cliente, ambos reciben descuento en el plan".

### 1.4 Por qué este es un proyecto serio, no un sprint

Tocar el modelo multi-tenant para introducir writes cross-tenant es **invertir** la garantía core de aislamiento (RLS estricta). Si lo hacemos mal:
- Leak de datos entre tenants (catastrófico, vimos #336 P0 ya)
- Saldos que divergen entre A y B (peor que no tener la feature — destruye confianza)
- Race conditions en propagación (venta cancelada del lado A pero aplicada del lado B → fantasma)
- Operaciones huérfanas cuando un tenant expira (paid_until)

Por eso este doc cierra 10 decisiones antes de tocar código, propone esquema DB completo y parte la implementación en 5 fases independientes (cada una mergeable y observable en prod antes de la siguiente).

---

## 2. Estado actual relevante

### 2.1 Modelo multi-tenant

- Cada tenant tiene un `id` numérico y un `slug` (`tenants` table).
- **RLS estricta** en todas las tablas con datos del tenant: `WHERE tenant_id = current_setting('app.current_tenant')::int`.
- Dos roles en Postgres:
  - `ipro_app` **NOSUPERUSER** — el role normal del backend. RLS aplica.
  - `tecny_admin` **BYPASSRLS** — solo para `db.adminQuery()` desde `backend/src/routes/superAdmin.js`. Cross-tenant reads admin.
- Tenants huérfanos / leaks ya fueron auditados (#336, #337, TANDA 0a-0c). Hoy el aislamiento es sólido.

### 2.2 Módulo B2B existente (`frontend/src/screens/B2B.jsx` + `backend/src/routes/ventas/b2b.js`)

- Ventas B2B se cargan con un modal tipo planilla (`VentaB2BModal`).
- Cada venta B2B tiene cliente (entrada en `contactos`), items con producto + cantidad + precio, una caja receptora (o CC), y un estado `acreditada` | `pendiente`.
- La CC del cliente sube/baja según pagos parciales registrados en `cobros`.
- Existe Cobranza Masiva (`CobranzaMasivaModal`) para procesar varios cobros en bloque.

### 2.3 Módulo Proveedores

- Compras a proveedores se cargan en `frontend/src/screens/Proveedores.jsx` + `backend/src/routes/proveedores.js`.
- Cada compra tiene proveedor (entrada en `contactos` con flag `es_proveedor`), items, caja egreso (o CC), generan stock al confirmar.
- La CC del proveedor sube cuando se compra y baja cuando se le paga.

### 2.4 Tabla `contactos` — clientes Y proveedores

- Es la fuente única de "entidades con las que operamos". Una fila puede ser cliente, proveedor o ambos.
- Tiene `tenant_id` (RLS): los contactos son privados de cada tenant.

**Implicancia para esta feature**: cuando iPro le vende a TekHaus, del lado de iPro la "operación" se carga contra un contacto que representa a TekHaus (hoy puede ser "TekHaus" tipeado a mano). Del lado de TekHaus, el contacto que representa a iPro también existe (o se crea) en sus contactos. Lo que vamos a hacer es **linkear esos dos contactos a la entidad real "Tenant" cuando ambos son tenants Tecny y están en partnership**.

---

## 3. Decisiones cerradas con Lucas (2026-06-27)

| # | Tema | Decisión |
|---|---|---|
| 1 | **Consentimiento** | Bilateral. Tenant X invita por nombre de empresa registrado, Tenant Y debe aceptar explícito. Sin ambos pasos no hay vínculo. |
| 1b | **Revocación** | Cualquiera de los dos puede revocar. Operaciones + stock comercializado durante el vínculo **se preservan** (read-only post-revocación, no se borran). |
| 2 | **Mapeo de catálogos** | **Auto-create con flag**. Cada producto vendido se crea automático en el inventario del buyer con flag `pending_cross_tenant_review`. El buyer puede después mergearlo con otro producto suyo o aceptarlo como nuevo. (Decisión Lucas: auto-create — más fricción baja, sumamos mapeo manual en F4 si hace falta). |
| 3 | **Propagación de cambios** | Automática + notificación + historial completo de movimientos. Si A edita una venta, se propaga a B y B recibe notificación. |
| 4 | **Moneda y TC** | El TC siempre lo define el **vendedor**. El buyer ve el valor en su moneda operativa con TC informado. |
| 5 | **Pagos / cobros** | La venta crea CC del cliente del lado del seller y CC del proveedor del lado del buyer. El pago es **evento separado**: cualquiera de los dos puede registrarlo primero y se replica al otro lado. Siempre con notificación. |
| 6 | **Comprobantes adjuntos** | NO se replican. B2B no requiere comprobante visual del lado del buyer (eso es para Financiera retail). |
| 7 | **Visibilidad** | Cada tenant ve SOLO sus operaciones con el partner (no ve historia interna del otro con terceros). Vista de **conciliación bilateral** muestra si los saldos del lado A y del lado B matchean o difieren. |
| 8 | **Estado del tenant** | Si un partner tiene `paid_until` vencido, las operaciones cross-tenant entre ese partner y cualquier otro quedan **freezadas read-only** hasta que renueve. Se pueden ver, no se pueden crear ni editar. |
| 9 | **Permisos** | Nueva capability `cross_tenant.write`. Default OFF — el owner del tenant la activa por vendedor desde Usuarios. Sin esta cap, el botón "enviar a partner" no aparece. |
| 10 | **Cancelaciones unilaterales** | **NO existen**. Si el buyer quiere "deshacer" una operación cross-tenant del lado suyo, la única ruta es pedirle al seller que cancele la venta original (que entonces propaga a B), o cargar una devolución / ajuste bilateral con audit. Esto evita que los saldos diverjan misteriosamente. |

**Open decisions** (no críticas para F1 pero hay que cerrarlas antes de F4):
- ¿Cómo se manejan las devoluciones cross-tenant exactamente? (probablemente igual flow que venta, pero negativo + items a devolver)
- ¿Vista de "conciliación bilateral" muestra automáticamente las diferencias o requiere refresh manual?
- ¿Notificaciones por email además del in-app inbox? (default no en F1, sí en F5)

---

## 4. Modelo de datos

### 4.1 Tablas nuevas

#### `tenant_partnerships` — vínculo bilateral aceptado

```sql
CREATE TABLE tenant_partnerships (
  id BIGSERIAL PRIMARY KEY,

  -- Convención: tenant_a_id < tenant_b_id SIEMPRE.
  -- Esto evita tener (A,B) y (B,A) como filas distintas para el mismo vínculo.
  -- Los endpoints que consultan ordenan los IDs antes de WHERE.
  tenant_a_id INT NOT NULL REFERENCES tenants(id),
  tenant_b_id INT NOT NULL REFERENCES tenants(id),
  CHECK (tenant_a_id < tenant_b_id),
  UNIQUE (tenant_a_id, tenant_b_id),

  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),

  -- Quién invitó (tenant_a o tenant_b — guardamos ambos campos para no asumir).
  invited_by_tenant_id INT NOT NULL REFERENCES tenants(id),
  invited_by_user_id INT NOT NULL REFERENCES users(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Mensaje opcional del invitador ("Hola TekHaus, somos iPro, ya operamos juntos...").
  invitation_message TEXT,

  -- Aceptación (NULL hasta status='active').
  accepted_by_user_id INT REFERENCES users(id),
  accepted_at TIMESTAMPTZ,

  -- Revocación (NULL hasta status='revoked').
  revoked_by_tenant_id INT REFERENCES tenants(id),
  revoked_by_user_id INT REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,

  -- Anti-spam: si A revoca a B, NO puede re-invitar hasta cooldown.
  -- Implementado en el endpoint, no a nivel DB (cap muy específico al producto).
  CHECK (
    (status = 'pending'  AND accepted_at IS NULL AND revoked_at IS NULL) OR
    (status = 'active'   AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'revoked'  AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX idx_tenant_partnerships_a ON tenant_partnerships(tenant_a_id) WHERE status = 'active';
CREATE INDEX idx_tenant_partnerships_b ON tenant_partnerships(tenant_b_id) WHERE status = 'active';
CREATE INDEX idx_tenant_partnerships_invited_for ON tenant_partnerships(invited_by_tenant_id, status);

-- RLS especial: no es como las demás. Los dos tenants involucrados pueden ver
-- la fila. Política dual: WHERE tenant_a_id = current OR tenant_b_id = current.
ALTER TABLE tenant_partnerships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_partnerships_select ON tenant_partnerships FOR SELECT USING (
  tenant_a_id = current_setting('app.current_tenant', true)::int OR
  tenant_b_id = current_setting('app.current_tenant', true)::int
);
-- INSERT/UPDATE no usan policy: los hace el backend con `tecny_admin` (BYPASSRLS)
-- desde endpoints que validan el flow.
```

**Helper Node**: `getPartnership(tenantX, tenantY)` ordena los IDs y devuelve la fila si existe.

#### `cross_tenant_operations` — la operación maestra (1 venta cross-tenant = 1 fila)

```sql
CREATE TABLE cross_tenant_operations (
  id BIGSERIAL PRIMARY KEY,
  partnership_id BIGINT NOT NULL REFERENCES tenant_partnerships(id),

  -- Los dos lados de la operación.
  seller_tenant_id INT NOT NULL REFERENCES tenants(id),
  buyer_tenant_id  INT NOT NULL REFERENCES tenants(id),
  CHECK (seller_tenant_id <> buyer_tenant_id),

  -- Links a las tablas existentes (ventas/compras) de cada lado.
  -- Cuando se crea la operación, primero se inserta la venta del seller,
  -- luego la compra del buyer, y al final esta fila con los dos IDs.
  seller_venta_id INT NOT NULL,  -- FK lógica a ventas(id) del tenant seller
  buyer_compra_id INT NOT NULL,  -- FK lógica a compras(id) del tenant buyer
  -- No usamos FK física porque ventas/compras tienen tenant_id distinto y
  -- queremos evitar joins cross-schema complejos. Defensa: trigger que
  -- valida en INSERT.

  status TEXT NOT NULL CHECK (status IN (
    'active',     -- operación normal, ambos lados activos
    'cancelled',  -- el seller la canceló — propaga al buyer
    'frozen'      -- uno de los dos tenants tiene paid_until vencido
  )) DEFAULT 'active',

  -- Totales redundantes para queries rápidas de conciliación.
  -- La verdad sigue siendo seller_venta + buyer_compra; estos son cache.
  total_usd NUMERIC(14, 2) NOT NULL,
  total_ars NUMERIC(14, 2) NOT NULL,
  tc_used NUMERIC(10, 4) NOT NULL,  -- TC del momento de creación, lo fija el seller

  created_by_user_id INT NOT NULL REFERENCES users(id), -- vendedor del seller
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Si fue editada después: timestamp + user + side.
  last_modified_by_user_id INT REFERENCES users(id),
  last_modified_at TIMESTAMPTZ
);

CREATE INDEX idx_cross_ops_seller ON cross_tenant_operations(seller_tenant_id, status, created_at DESC);
CREATE INDEX idx_cross_ops_buyer ON cross_tenant_operations(buyer_tenant_id, status, created_at DESC);
CREATE INDEX idx_cross_ops_partnership ON cross_tenant_operations(partnership_id);

ALTER TABLE cross_tenant_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY cross_ops_select ON cross_tenant_operations FOR SELECT USING (
  seller_tenant_id = current_setting('app.current_tenant', true)::int OR
  buyer_tenant_id  = current_setting('app.current_tenant', true)::int
);
```

#### `cross_tenant_operation_items` — items de la operación

```sql
CREATE TABLE cross_tenant_operation_items (
  id BIGSERIAL PRIMARY KEY,
  cross_tenant_operation_id BIGINT NOT NULL REFERENCES cross_tenant_operations(id) ON DELETE CASCADE,

  -- Cada item tiene un producto en cada lado.
  seller_producto_id INT NOT NULL,
  buyer_producto_id  INT NOT NULL,  -- auto-creado con pending_cross_tenant_review=true si no existía

  cantidad INT NOT NULL CHECK (cantidad > 0),
  precio_unitario_usd NUMERIC(12, 2) NOT NULL,
  precio_unitario_ars NUMERIC(14, 2) NOT NULL,

  -- Si seller editó el item: track del cambio.
  -- F1 no soporta edición de items, F3 sí.
  original_cantidad INT,
  original_precio_unitario_usd NUMERIC(12, 2)
);

CREATE INDEX idx_cross_op_items_op ON cross_tenant_operation_items(cross_tenant_operation_id);
```

#### `cross_tenant_pagos` — pagos/cobros replicados

```sql
CREATE TABLE cross_tenant_pagos (
  id BIGSERIAL PRIMARY KEY,
  cross_tenant_operation_id BIGINT NOT NULL REFERENCES cross_tenant_operations(id),

  -- Links a las tablas existentes (cobros/pagos) de cada lado.
  seller_cobro_id INT NOT NULL,  -- FK lógica a cobros del seller
  buyer_pago_id INT NOT NULL,    -- FK lógica a pagos del buyer

  monto_usd NUMERIC(14, 2) NOT NULL,
  monto_ars NUMERIC(14, 2) NOT NULL,
  tc_used NUMERIC(10, 4) NOT NULL,

  -- Cajas donde el dinero efectivamente se movió.
  caja_seller_id INT NOT NULL, -- caja del seller donde se cobró
  caja_buyer_id INT NOT NULL,  -- caja del buyer desde donde se pagó

  -- Quién lo registró primero (el otro lado lo recibe propagado).
  registered_by_side TEXT NOT NULL CHECK (registered_by_side IN ('seller', 'buyer')),
  registered_by_user_id INT NOT NULL REFERENCES users(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Cuándo se propagó al otro lado (debería ser inmediato en sync; valor seteado
  -- post-COMMIT del INSERT del otro lado).
  propagated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cross_pagos_op ON cross_tenant_pagos(cross_tenant_operation_id);
```

#### `cross_tenant_notifications` — inbox del tenant

```sql
CREATE TABLE cross_tenant_notifications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id),  -- el que ve la notificación
  partnership_id BIGINT REFERENCES tenant_partnerships(id),
  cross_tenant_operation_id BIGINT REFERENCES cross_tenant_operations(id),

  type TEXT NOT NULL CHECK (type IN (
    'invitation_received',       -- "X te invitó a partnership"
    'invitation_accepted',       -- "Y aceptó tu invitación"
    'invitation_rejected',       -- "Y rechazó tu invitación"
    'partnership_revoked',       -- "X revocó la partnership"
    'operation_received',        -- "X te envió una venta de $XX"
    'operation_modified',        -- "X modificó la venta #123"
    'operation_cancelled',       -- "X canceló la venta #123"
    'payment_received',          -- "X cobró $XX de tu deuda" (lo ve el buyer)
    'payment_registered',        -- "Y registró un pago de $XX" (lo ve el seller)
    'product_pending_review'     -- "Tenés N productos auto-creados pendientes de revisión"
  )),

  -- Payload con datos para renderizar la notif (e.g. nombre del partner, monto).
  -- Snapshot — no depende de joins en runtime.
  payload JSONB NOT NULL,

  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cross_notif_unread ON cross_tenant_notifications(tenant_id, read_at)
  WHERE read_at IS NULL;
CREATE INDEX idx_cross_notif_recent ON cross_tenant_notifications(tenant_id, created_at DESC);

ALTER TABLE cross_tenant_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY cross_notif_select ON cross_tenant_notifications FOR SELECT USING (
  tenant_id = current_setting('app.current_tenant', true)::int
);
CREATE POLICY cross_notif_update ON cross_tenant_notifications FOR UPDATE USING (
  tenant_id = current_setting('app.current_tenant', true)::int
);
```

### 4.2 Cambios a tablas existentes

#### `productos`

```sql
ALTER TABLE productos ADD COLUMN pending_cross_tenant_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE productos ADD COLUMN created_from_cross_tenant_op_id BIGINT REFERENCES cross_tenant_operations(id);

-- Index parcial: queries para "productos pendientes de revisión" son frecuentes
-- en la UI del buyer pero superficiales del lado del seller (siempre false).
CREATE INDEX idx_productos_pending_review ON productos(tenant_id) WHERE pending_cross_tenant_review = true;
```

Semántica:
- `pending_cross_tenant_review = true` → producto auto-creado por una operación cross-tenant en el lado del buyer; el buyer todavía no lo revisó.
- UI del buyer en Inventario muestra badge "Pendiente revisión" + acción "Confirmar como nuevo" o "Mergear con producto existente".
- `created_from_cross_tenant_op_id` → trazabilidad de dónde vino.

#### `ventas` (módulo B2B)

```sql
ALTER TABLE ventas ADD COLUMN cross_tenant_operation_id BIGINT REFERENCES cross_tenant_operations(id);
CREATE INDEX idx_ventas_cross_tenant ON ventas(tenant_id, cross_tenant_operation_id)
  WHERE cross_tenant_operation_id IS NOT NULL;
```

Si una venta B2B forma parte de una operación cross-tenant, este campo apunta a la fila maestra. La UI del seller en su listado de ventas muestra un badge "→ TekHaus (Red B2B)" para diferenciar de ventas B2B normales.

#### `compras` (módulo Proveedores)

```sql
ALTER TABLE compras ADD COLUMN cross_tenant_operation_id BIGINT REFERENCES cross_tenant_operations(id);
CREATE INDEX idx_compras_cross_tenant ON compras(tenant_id, cross_tenant_operation_id)
  WHERE cross_tenant_operation_id IS NOT NULL;
```

Análogo del lado del buyer.

#### `cobros` y `pagos`

```sql
ALTER TABLE cobros ADD COLUMN cross_tenant_pago_id BIGINT REFERENCES cross_tenant_pagos(id);
ALTER TABLE pagos  ADD COLUMN cross_tenant_pago_id BIGINT REFERENCES cross_tenant_pagos(id);
```

#### `contactos`

```sql
ALTER TABLE contactos ADD COLUMN linked_tenant_id INT REFERENCES tenants(id);
-- Cuando un contacto representa a un partner Tecny, este campo apunta al otro tenant.
-- Si la partnership se revoca, el campo NO se limpia (preservamos histórico) pero la UI
-- muestra el contacto como "ex-partner".

CREATE INDEX idx_contactos_linked_tenant ON contactos(tenant_id, linked_tenant_id)
  WHERE linked_tenant_id IS NOT NULL;
```

Cuando dos tenants firman partnership, se crea (o linkea con un contacto existente) la entrada de contactos en ambos lados. Las próximas operaciones cross-tenant entre ellos usan ese contacto fantasma. Si A revoca, el contacto queda como histórico no-linkable.

#### `tenant_admin_actions` (audit del super-admin)

```sql
-- Agregar 2 actions al CHECK: 'cross_tenant_partnership_created' y 'cross_tenant_partnership_revoked'
-- (Migration: 20260627000001_tenant_admin_actions_add_cross_tenant.js)
```

#### `user_capabilities`

```sql
-- Nueva capability 'cross_tenant.write'. Se agrega al seed de capabilities.
-- Owner del tenant ya bypassa (capability-based, rol='owner').
INSERT INTO capabilities (code, descripcion) VALUES
  ('cross_tenant.write', 'Crear y editar operaciones cross-tenant (Red B2B)');
```

### 4.3 Helper para la convención (a < b)

```javascript
// backend/src/lib/partnership.js

/** Ordena dos tenant IDs ascendente — convención de tenant_partnerships. */
function orderTenantIds(t1, t2) {
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

/** Busca partnership activo entre dos tenants. Devuelve null si no existe. */
async function getActivePartnership(client, tenantX, tenantY) {
  const [a, b] = orderTenantIds(tenantX, tenantY);
  const { rows } = await client.query(
    `SELECT * FROM tenant_partnerships
       WHERE tenant_a_id = $1 AND tenant_b_id = $2
         AND status = 'active'`,
    [a, b]
  );
  return rows[0] || null;
}

module.exports = { orderTenantIds, getActivePartnership };
```

---

## 5. API endpoints

Todos los endpoints van bajo `/api/red-b2b/*` para no contaminar el namespace existente.

### 5.1 Partnership lifecycle

| Endpoint | Auth | Body / Query | Descripción |
|---|---|---|---|
| `POST /partnerships/invite` | requireAuth + cap `cross_tenant.write` | `{ target_tenant_slug, message? }` | Crea fila `tenant_partnerships` con `status='pending'`. Notifica al tenant target. Anti-spam: rate limit 10/hora/user, y bloqueo de re-invite si revoke reciente. |
| `POST /partnerships/:id/accept` | requireAuth + cap `cross_tenant.write` | (sin body) | Tenant target acepta. Cambia status a `active`. Crea contactos linkeados en ambos lados. |
| `POST /partnerships/:id/reject` | requireAuth + cap `cross_tenant.write` | `{ reason? }` | Tenant target rechaza. Borra la fila pending (no se preserva — invitación rechazada es no-op). |
| `POST /partnerships/:id/revoke` | requireAuth + cap `cross_tenant.write` | `{ reason? }` | Cualquiera de los dos revoca. Status → `revoked`. Operaciones existentes quedan read-only. |
| `GET /partnerships` | requireAuth | `?status=active|pending|revoked` | Lista partnerships donde mi tenant participa (como tenant_a o tenant_b). |
| `GET /partnerships/:id` | requireAuth | — | Detalle de una partnership + stats (cantidad ops, total USD movido, último movimiento). |

### 5.2 Operaciones cross-tenant

| Endpoint | Auth | Body | Descripción |
|---|---|---|---|
| `POST /operations` | requireAuth + cap `cross_tenant.write` | `{ partnership_id, items: [{producto_id, cantidad, precio_usd}], tc, total_ars, notes? }` | **CORE**. Crea venta del lado del seller, compra del lado del buyer, items espejados, cross_tenant_operation maestro. Trigger 1 notificación al buyer. |
| `GET /operations` | requireAuth | `?partner_id=X&from=date&to=date&status=...` | Lista operaciones cross-tenant donde mi tenant participa. |
| `GET /operations/:id` | requireAuth | — | Detalle full (items, pagos, status, conciliación). |
| `PATCH /operations/:id` | requireAuth + cap `cross_tenant.write` (solo el seller) | `{ items?, tc?, notes? }` | Modificar la operación. Propaga al buyer + notificación + audit. F1: solo notes editable. F3: items editables. |
| `POST /operations/:id/cancel` | requireAuth + cap `cross_tenant.write` (solo el seller) | `{ reason }` | Cancela la operación. Propaga al buyer (compra cancelada → reverso de stock). Notificación + audit. |

### 5.3 Pagos cross-tenant

| Endpoint | Auth | Body | Descripción |
|---|---|---|---|
| `POST /operations/:id/pagos` | requireAuth + cap `cross_tenant.write` | `{ monto_usd, tc, caja_id }` | Registra un pago. El backend determina si quien llama es seller (entonces es un "cobro" del lado suyo + "pago" replicado del otro) o buyer (al revés). |
| `GET /operations/:id/pagos` | requireAuth | — | Lista los pagos de la operación. |

### 5.4 Productos pendientes de revisión (lado buyer)

| Endpoint | Auth | Body | Descripción |
|---|---|---|---|
| `GET /productos-pending-review` | requireAuth | — | Lista mis productos con `pending_cross_tenant_review=true`. UI muestra badge global y pantalla dedicada. |
| `POST /productos/:id/confirm-new` | requireAuth | — | Confirma el producto auto-creado como nuevo en mi catálogo. Limpia el flag. |
| `POST /productos/:id/merge-into` | requireAuth | `{ target_producto_id }` | Mergea el producto auto-creado con uno existente. Stock + historial se traspasan. El producto fuente queda soft-deleted. |

### 5.5 Notificaciones cross-tenant

| Endpoint | Auth | Body | Descripción |
|---|---|---|---|
| `GET /notifications` | requireAuth | `?unread=true` | Inbox. |
| `POST /notifications/:id/read` | requireAuth | — | Marcar como leída. |
| `POST /notifications/read-all` | requireAuth | — | Marcar todas como leídas. |

### 5.6 Conciliación bilateral

| Endpoint | Auth | Body | Descripción |
|---|---|---|---|
| `GET /partnerships/:id/conciliation` | requireAuth | — | Devuelve resumen: total operaciones, total pagos, saldo según mi lado, saldo según el otro lado, diferencia si hay. Si hay diff, lista las operaciones donde difiere. |

---

## 6. Flujos críticos

### 6.1 Invitación + aceptación

```
SELLER (iPro)                                  BUYER (TekHaus)
─────────────                                  ───────────────
[UI Red B2B → Invitar partner]
  Busca "TekHaus" por slug/nombre
  → POST /api/red-b2b/partnerships/invite
     body: { target_tenant_slug: 'tekhaus', message: 'Hola, ...' }

  Backend (BYPASSRLS):
    1. Valida que target tenant exista y no esté suspended.
    2. Valida que no exista ya una partnership active o pending entre ambos.
    3. Valida rate limit (10 invitaciones/hora/user).
    4. INSERT tenant_partnerships con status='pending'.
    5. INSERT cross_tenant_notifications type='invitation_received' en TekHaus.
    6. (F5) Envía email al owner de TekHaus.
    7. Audit log.

  ← 201 Created { partnership_id }
                                              [Recibe notificación in-app]
                                              [Va a /red-b2b/inbox]
                                              [Click "Aceptar"]
                                              → POST /api/red-b2b/partnerships/:id/accept

                                              Backend (BYPASSRLS):
                                                1. Valida que el caller esté en target tenant.
                                                2. UPDATE status='active' + accepted_at + accepted_by.
                                                3. INSERT contactos en AMBOS tenants con linked_tenant_id.
                                                4. INSERT notification 'invitation_accepted' en iPro.
                                                5. Audit.

                                              ← 200 OK
[Recibe notificación]
[Aparece TekHaus en su lista de partners]
[Botón "Enviar venta a TekHaus" habilitado]
```

### 6.2 Crear venta cross-tenant (el flujo core)

```
SELLER (iPro)                                  BUYER (TekHaus)
─────────────                                  ───────────────
[UI Ventas B2B → Nueva venta]
  Selecciona "Cliente": dropdown muestra contactos + partners Tecny.
  Lucas elige "TekHaus (Red B2B)" — contacto con linked_tenant_id.
  Carga items: 5× iPhone 15 Pro 256GB, USD 950 c/u, TC 1400 → ARS 4.750.000 c/u.
  → POST /api/red-b2b/operations
     body: {
       partnership_id: 42,
       items: [{ producto_id: 1234, cantidad: 5, precio_usd: 950 }],
       tc: 1400,
       total_usd: 4750,
       total_ars: 6_650_000
     }

  Backend (BYPASSRLS, en una sola tx atómica):
    A. Verifica partnership active.
    B. Verifica cap 'cross_tenant.write' del user.
    C. Verifica que ambos tenants estén active (paid_until > today).
    D. SET LOCAL app.current_tenant = seller_tenant_id
       Crea venta B2B normal (insert en ventas + venta_items + decrement stock + insert cobro CC).
       Resultado: seller_venta_id.
    E. SET LOCAL app.current_tenant = buyer_tenant_id
       Para cada item:
         - ¿El producto existe en el buyer? Match por... ¿código_interno? ¿nombre exacto?
           F1 decisión: NO matching, SIEMPRE auto-create con flag.
           INSERT producto en inventario buyer con:
             - mismo nombre, descripcion, categoria 'Auto-importado'
             - pending_cross_tenant_review = true
             - created_from_cross_tenant_op_id = (placeholder, se actualiza al final)
       Crea compra normal (insert en compras + compra_items + increment stock + insert pago CC del proveedor=iPro).
       Resultado: buyer_compra_id.
    F. SET LOCAL... (sin importar — la siguiente tabla no es RLS-scoped)
       INSERT cross_tenant_operations con seller_venta_id + buyer_compra_id.
       UPDATE productos created_from_cross_tenant_op_id ahora que tenemos el id.
       INSERT cross_tenant_operation_items con los matches.
    G. UPDATE ventas SET cross_tenant_operation_id = ... WHERE id = seller_venta_id.
       UPDATE compras SET cross_tenant_operation_id = ... WHERE id = buyer_compra_id.
    H. INSERT notification 'operation_received' en TekHaus.
       Si hay productos auto-creados: INSERT notification 'product_pending_review'.
    I. Audit (tenant_admin_actions o nueva tabla cross_tenant_actions).
    J. COMMIT.

  ← 201 Created { operation_id }
                                              [Recibe notificación in-app]
                                              "iPro te envió una venta de USD 4750"
                                              [Va a /red-b2b/operations/:id]
                                              [Ve la operación replicada]
                                              [Su inventario aumentó +5 iPhones]
                                              [Su CC con iPro aumentó +ARS 6.65M]
                                              [Tiene 1 producto pendiente de revisión]
```

**Edge case A — uno de los tenants tiene paid_until vencido**:
- Endpoint POST /operations falla con 403 + reason='tenant_inactive' (lo detectamos en paso C).
- Las operaciones existentes pre-vencimiento quedan visibles read-only.

**Edge case B — partnership revocada entre el momento del SELECT inicial y el INSERT**:
- Paso A falla con 409 + reason='partnership_inactive'.
- Tx rollback completo.

**Edge case C — buyer no tiene caja receptora configurada**:
- F1 decisión: el INSERT compra usa la "caja CC del proveedor" del buyer (que se crea automáticamente al firmar la partnership — es metadata, no plata real).
- No se necesita caja física porque es "compra a crédito"; el pago real se hace en evento separado.

### 6.3 Pago de la operación

```
SELLER (iPro)                                  BUYER (TekHaus)
─────────────                                  ───────────────
                                              [Va a /red-b2b/operations/:id]
                                              [Click "Registrar pago"]
                                              Carga: ARS 6.650.000, TC 1400, caja "Banco Galicia".
                                              → POST /api/red-b2b/operations/:id/pagos
                                                 body: { monto_usd: 4750, tc: 1400, caja_id: 7 }

                                              Backend (BYPASSRLS, tx):
                                                A. Verifica caller en buyer side.
                                                B. SET LOCAL app.current_tenant = buyer
                                                   INSERT pagos (egreso de caja buyer)
                                                   UPDATE compra: paga la CC proveedor.
                                                C. SET LOCAL app.current_tenant = seller
                                                   INSERT cobros (ingreso a CC del cliente seller)
                                                   ... PERO ¿cuál caja del seller?
                                                   F1 decisión: caja default del seller para cross-tenant
                                                                 (configurable en /red-b2b/config),
                                                                 sino la primera caja del seller con
                                                                 misma moneda.
                                                   UPDATE venta: marca como pagada o pago parcial.
                                                D. INSERT cross_tenant_pagos linkeando los dos.
                                                E. INSERT notification 'payment_registered' en seller.
                                                F. COMMIT.

                                              ← 201 Created
[Recibe notificación]
"TekHaus pagó USD 4750"
[Ve cobro en su caja default cross-tenant]
[Su CC con TekHaus baja a 0]
```

**¿Qué pasa si el seller registra el pago primero?** Mismo flow invertido — el ladonde se carga primero define `registered_by_side`, y el otro lado recibe el pago propagado a su caja default cross-tenant.

### 6.4 Modificación de venta cross-tenant (F3)

F1 NO soporta esto. El seller que se equivocó debe cancelar la operación y rehacerla. F3 agrega:

```
SELLER edita la operación (cambia precio o cantidad)
→ PATCH /api/red-b2b/operations/:id

Backend:
  A. Calcula diff (qué cambió).
  B. UPDATE venta seller con valores nuevos + recalcula stock/CC.
  C. UPDATE compra buyer espejada + recalcula stock/CC.
  D. UPDATE cross_tenant_operations totals.
  E. INSERT notification 'operation_modified' con snapshot del diff.
  F. Audit en cross_tenant_operation_history (nueva tabla con el diff).
  G. COMMIT.

BUYER ve la notificación + el diff en su /red-b2b/operations/:id/history.
```

### 6.5 Cancelación

Solo el **seller** puede cancelar (decisión #10 — no hay cancelación unilateral del buyer).

```
SELLER → POST /api/red-b2b/operations/:id/cancel { reason }

Backend:
  A. UPDATE venta seller status='cancelled'. Stock vuelve.
  B. UPDATE compra buyer status='cancelled'. Stock vuelve.
  C. ¿Hay pagos asociados? Si sí: pagos se REVIERTEN automático (crea pago/cobro negativo en ambos lados).
  D. UPDATE cross_tenant_operations status='cancelled'.
  E. Notification 'operation_cancelled' al buyer.
  F. COMMIT.
```

### 6.6 Revocación de partnership

```
Cualquier lado → POST /api/red-b2b/partnerships/:id/revoke { reason }

Backend:
  A. UPDATE partnership status='revoked' + revoked_at + revoked_by_*.
  B. Las operaciones existentes quedan tal cual (status='active', visibles, read-only).
  C. NUEVAS operaciones rechazadas con 409 + reason='partnership_revoked'.
  D. Pagos pendientes de operaciones existentes SÍ se pueden seguir cargando (sino sería problema legal: te debo plata y no te puedo pagar porque me bloqueás).
  E. Cooldown: 24h antes de poder re-invitar al mismo tenant (anti-spam).
  F. Notification 'partnership_revoked' al otro lado.
```

---

## 7. UI / UX

### 7.1 Nuevo módulo "Red B2B" en sidebar

Aparece SI el tenant tiene al menos 1 partnership (active o pending). Sino, aparece como item "Próximamente" con un onboarding card que explica la feature.

Pantallas dentro del módulo:

1. **Partners** — listado de partnerships con stats (cantidad ops, último movimiento, saldo neto). Botón "Invitar nuevo partner" arriba.
2. **Operaciones** — listado de cross_tenant_operations del tenant. Filtros por partner, fecha, estado. Click → detalle.
3. **Inbox** — notificaciones unread + recientes. Acceso rápido a invitaciones pendientes.
4. **Pendientes de revisión** — productos auto-creados pendientes de confirmar/mergear. Badge global con contador en el sidebar.
5. **Conciliación** — vista por partner que compara saldos. Verde si match, rojo con detalle si divergen.

### 7.2 Cambios a módulos existentes

- **Ventas B2B**: en el modal de nueva venta, en el dropdown "Cliente", los partners aparecen con un badge "Red B2B". Si se elige uno, el flow pasa al endpoint cross-tenant en vez del B2B normal.
- **Inventario**: filtro "Pendientes revisión" que muestra solo productos con `pending_cross_tenant_review=true`. Botón en el card del producto para "Confirmar" o "Mergear con...".
- **Cajas**: cuenta corriente del partner aparece como contacto normal pero con icono especial (link entre tenants).

### 7.3 Notificaciones globales

Un bell icon en la topbar muestra cantidad de notifications unread. Click → drawer con la lista. Click en una notif → navega al recurso (operación, productos pending, partnership).

---

## 8. Plan de implementación por fases

Cada fase es **mergeable independiente**, deployable a prod sin esperar las siguientes. Cap explícito: **NO** activar feature flag en prod hasta validar la fase completa en staging con escenario E2E real.

### F1 — Foundation: schema + partnerships (3-4 días)

Entregables:
- Migration con TODAS las tablas + indices + RLS policies (1 migration grande)
- Endpoint `POST /partnerships/invite`, `accept`, `reject`, `revoke`
- Endpoint `GET /partnerships`, `GET /partnerships/:id`
- Helper `partnership.js` (orderTenantIds, getActivePartnership)
- Cap `cross_tenant.write` agregada al seed + UI checkbox en Usuarios
- Tests backend: 15+ casos (invite happy, anti-spam, re-invite cooldown, accept/reject, revoke, RLS leak attempts)
- Frontend: solo módulo Partners con listado + invitar. NO operations todavía.

Validación en prod: dos cuentas test (iPro + TekHaus dummy) firman partnership y se ven mutuamente en la lista. Si esto anda, F1 está lista.

### F2 — Auto-create de productos + flag pending review (1.5-2 días)

Entregables:
- Migration: ALTER productos (`pending_cross_tenant_review`, `created_from_cross_tenant_op_id`)
- Endpoint `GET /productos-pending-review`
- Endpoint `POST /productos/:id/confirm-new`
- Endpoint `POST /productos/:id/merge-into`
- Tests del flow merge (stock + historial migran correctamente)
- Frontend: pantalla "Pendientes de revisión" en módulo Red B2B + badge en sidebar

### F3 — Operaciones cross-tenant (5-7 días, el más grande)

Entregables:
- Migration: ALTER ventas + compras (`cross_tenant_operation_id`) + ALTER contactos
- Endpoint `POST /operations` — el flow core
- Endpoint `GET /operations`, `GET /operations/:id`
- Endpoint `POST /operations/:id/cancel`
- Endpoint `PATCH /operations/:id` (solo notes en F3, items en F3.5)
- Tests backend: 25+ casos (happy path, RLS leak attempts, partnership inactive, tenant expired, stock insufficient, currency conversion, atomicity del rollback si un side falla)
- Frontend: pantalla Operaciones + detalle + integración en modal Ventas B2B existente (badge "Red B2B" en dropdown)

### F4 — Pagos cross-tenant + conciliación (3-4 días)

Entregables:
- Endpoint `POST /operations/:id/pagos`
- Endpoint `GET /operations/:id/pagos`
- Endpoint `GET /partnerships/:id/conciliation`
- Caja default cross-tenant configurable en /red-b2b/config
- Tests backend: 15+ casos (pago desde buyer, pago desde seller, pago parcial, reverso por cancelación, divergencia detectada)
- Frontend: form "Registrar pago" en detalle de operación, vista de conciliación bilateral

### F5 — Inbox de notificaciones + emails (2-3 días)

Entregables:
- Endpoint `GET /notifications`, `POST /:id/read`, `POST /read-all`
- Topbar bell icon con counter unread
- Drawer con listado de notifications
- Email opcional (gate por config del tenant) para los 5 events críticos: invitation_received, invitation_accepted, operation_received, operation_cancelled, payment_received
- Tests frontend: 10+ casos del drawer
- Validación E2E en prod con dos cuentas reales

**Total estimado: 14-21 días.** Si se quiere acelerar, se puede sacar F2 al final (el flag inicial puede ser "todo nuevo" sin merging — F2 solo agrega ergonomía). F5 también es estirable; sin emails sigue siendo funcional con notif in-app.

---

## 9. Riesgos y mitigaciones

### 9.1 RLS leak entre tenants — CRÍTICO

**Riesgo**: el path cross-tenant requiere `BYPASSRLS` para escribir en el tenant del comprador. Un bug en la validación de partnership puede permitir que un tenant escriba en cualquier otro.

**Mitigaciones**:
- Tests de "RLS leak attempt" obligatorios en cada endpoint: caller del tenant A intenta operar sobre partnership del tenant B (con B no-relacionado) → debe rebotar 403.
- Toda escritura cross-tenant pasa por un único helper `crossTenantWrite(targetTenantId, callback)` que valida partnership activa ANTES de cambiar el `SET LOCAL`.
- Audit `cross_tenant_actions` con timestamp + caller_user + target_tenant + endpoint. Forensics inmediata si algo sale mal.
- Rollout gradual con feature flag por-tenant (no global) — solo iPro/Celnyx + 1 partner test en F1, ampliar con cada validación.

### 9.2 Saldos divergentes

**Riesgo**: por un bug, una operación queda creada en un lado pero no en el otro → saldos divergen, el feature pierde credibilidad inmediata.

**Mitigaciones**:
- TODAS las escrituras cross-tenant están en una sola transacción atómica. Si cualquier paso falla, rollback completo.
- Cron diario que recorre `cross_tenant_operations` y verifica que `seller_venta_id` y `buyer_compra_id` realmente existan y matcheen totales. Cualquier inconsistencia → alerta + página de "Operaciones inconsistentes" en admin para resolución manual.
- Vista de conciliación bilateral expuesta al usuario para que detecte rápido si algo no matchea.

### 9.3 Productos duplicados en el buyer

**Riesgo**: auto-create genera N copias del mismo producto si el seller le vende N veces sin que el buyer haga merge.

**Mitigaciones**:
- En el INSERT de producto auto-create, primero buscar match exacto por `(nombre, descripcion, partner_id)` en productos del buyer con flag `pending_cross_tenant_review=true`. Si match → no crear, reusar.
- Badge global "tenés N productos pendientes de revisión" en sidebar mantiene presión para hacer cleanup.
- F5 onboarding-card que aparece la primera vez con explicación.

### 9.4 Performance al escalar

**Riesgo**: cada operación cross-tenant es 2 writes (venta + compra) + N inserts de items + 1 cross_tenant_op + 1 notification. Para tenants con 1000 ventas/mes esto multiplica writes y notifs.

**Mitigaciones**:
- Indices parciales (ya en schema arriba) para queries calientes.
- Notifications type='product_pending_review' colapsadas: en vez de 1 notif por producto pending, 1 sola con counter agregada y actualizada cuando se agregan más.
- F5+: si los volúmenes crecen, procesar la propagación async via cola (BullMQ + Redis). F1-F4 sync es suficiente.

### 9.5 Abuso de invitaciones

**Riesgo**: un tenant malintencionado invita a todos los demás para spamear.

**Mitigaciones**:
- Rate limit 10 invitaciones/hora/user (en F1).
- Cap de partnerships activas por plan (trial: 5, starter: 20, pro: 100, enterprise: ilimitado).
- Cooldown 24h entre revoke y re-invite al mismo tenant.
- Notificación "X te invitó por Nra vez" con badge especial.

### 9.6 Cancelación de operación con pagos previos

**Riesgo**: el seller cancela una operación que ya tiene pagos cargados → reverso automático puede confundir contablemente.

**Mitigaciones**:
- En el endpoint cancel, si hay pagos, requiere confirmación explícita: "Esta operación tiene N pagos por USD X. Cancelarla revertirá esos pagos. ¿Confirmás?"
- El reverso genera entradas de "pago negativo" claramente etiquetadas (NO borra los pagos originales — preserva audit).
- F4+: en lugar de cancelar, permitir "ajuste parcial" como alternativa más limpia.

### 9.7 Pricing y enforcement de paid_until cross-tenant

**Riesgo**: si TekHaus está en trial y le firma partnership a iPro (paid), y trial vence → TekHaus es freezado pero las operaciones in-flight quedan en limbo.

**Mitigaciones**:
- Banner persistente en partner: "TekHaus está suspended — sin operaciones nuevas hasta que renueve. Operaciones existentes visibles read-only."
- Notification al partner activo (iPro) cuando el otro lado expira.
- F5+: el sistema de referidos puede ofrecer descuento a TekHaus de parte de iPro para incentivar renovación.

---

## 10. Open questions / decisiones diferidas

Estas NO bloquean F1-F2. Se pueden cerrar en el design de F3+ o iterar.

1. **Matching de productos por código/EAN** — F1 es solo auto-create + merge manual. ¿Vale agregar matching automático por código en F4?
2. **Comprobantes adjuntos cross-tenant** — Lucas decidió que no. Pero si los clientes piden adjuntar facturas formales (no comprobantes de OCR), ¿reabrimos?
3. **Multi-divisa fina** — ¿qué pasa si seller opera en USD y buyer en ARS pero el pago se hace en USD efectivo en mano? La conversión bilateral puede ser dolor de cabeza. F1 asume "TC fijado por seller, ambos usan ese TC para conciliar"; en la práctica puede haber mismatch.
4. **Devoluciones cross-tenant** — F3 captura cancelación full. ¿Devolución parcial (3 de 5 iPhones vuelven al seller)? F4 o F5.
5. **API pública para integraciones** — si un tenant quiere exponer su catálogo a otros tenants vía API directa (sin Tecny UI), ¿es feature pago?
6. **Modelo de plan / monetización** — ¿la feature es solo de planes pagos? ¿O trial también puede recibir (no enviar) operaciones para experimentar?

---

## 11. Métricas de éxito

Tras 1 mes en prod (post-F5):
- ≥ 30% de tenants pagos con ≥1 partnership activa.
- ≥ 50 operaciones cross-tenant procesadas sin inconsistencias detectadas por el cron.
- ≥ 5 tenants nuevos auto-onboarded vía invitación de partner (vs signup público).
- 0 incidentes de leak cross-tenant.
- ≥ 80% de productos auto-creados resueltos (confirmed o merged) dentro de 7 días.

---

## 12. Próximos pasos

1. **Aprobación de este doc por Lucas** — leer, marcar decisiones a discutir, validar estimaciones.
2. **Refinement con cliente real** — Lucas escoge 1 de los 6 clientes actuales como "early partner" de iPro para probar F1-F3 en staging con datos reales.
3. **Implementación F1** (3-4 días) — schema + partnerships, mergeable + deployable solo.
4. **Validación F1** — iPro + early partner firman partnership en prod, sin operaciones todavía.
5. **F2 → F5 iterativo**, cada fase validada antes de empezar la siguiente.

---

**Última actualización**: 2026-06-27
**Autor**: design pair-coding Lucas + Claude
