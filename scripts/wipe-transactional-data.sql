-- =============================================================================
-- wipe-transactional-data.sql
--
-- Borra TODOS los datos transaccionales del portal iPro (ventas, compras,
-- movimientos de caja, comprobantes, etc.) reseteando secuencias para que
-- las nuevas filas empiecen en ID = 1.
--
-- MANTIENE (catálogo + setup):
--   · users, user_2fa, user_permissions
--   · vendedores
--   · categorias, depositos (Inventario)
--   · etiquetas (Ventas)
--   · plantillas_garantia
--   · metodos_pago (Cajas configuradas)
--   · egreso_categorias, egresos_recurrentes (plantillas)
--   · alertas_config, config (% retención financiera)
--   · proveedores (lista de proveedores)
--   · contactos, clientes_cc (libreta de contactos / clientes B2B)
--   · catalogo_usados (referencia de modelos + precios típicos)
--   · tarjeta_entidades, tarjeta_planes (catálogo Visa/Master/3x/6x/etc.)
--   · cambio_entidades (entidades de cambio: USD oficial, blue, USDT, etc.)
--   · pgmigrations (sistema de migraciones — NO TOCAR)
--
-- BORRA (transaccional):
--   · ventas, venta_items, venta_pagos, venta_comprobantes, canjes, ventas_rapidas
--   · comprobantes
--   · pagos
--   · caja_movimientos
--   · egresos
--   · cambio_movimientos
--   · tarjeta_movimientos
--   · proveedor_movimientos, proveedor_movimiento_items
--   · movimientos_cc, items_movimiento_cc, movimientos_deudas, movimientos_inversiones
--   · conciliaciones, conciliacion_lineas
--   · proyectos, proyecto_movimientos, proyecto_participantes
--   · envios, envio_items
--   · productos (todo el Inventario)
--   · audit_logs
--   · rate_limit_entries (counters in-flight del rate limit)
--
-- =============================================================================
-- USO:
--   1. SACAR BACKUP PRIMERO: ~/bin/ipro-backup.sh  (irreversible sin esto)
--   2. Probar en staging:
--        psql "$STAGING_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--             -f scripts/wipe-transactional-data.sql
--   3. Si OK en staging, repetir en prod con la URL pública:
--        psql "$PROD_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--             -f scripts/wipe-transactional-data.sql
--
-- --single-transaction:  envuelve todo en BEGIN/COMMIT — si algo falla, ROLLBACK.
-- ON_ERROR_STOP=1:       aborta al primer error en lugar de seguir.
--
-- TRUNCATE ... RESTART IDENTITY CASCADE:
--   · RESTART IDENTITY: las secuencias serial vuelven a 1.
--   · CASCADE: borra también las filas referenciadas por FK de OTRAS tablas
--     que NO listamos (cinturón + tirantes — si me olvidé alguna tabla hija,
--     se borra igual). El riesgo de CASCADE es que afecte tablas "catálogo"
--     que tengan FK a una transaccional — eso sería diseño raro y staging lo
--     detectaría.
--
-- =============================================================================

-- Conteos PRE-truncate (para verificar que hay datos y comparar contra POST).
\echo '--- Conteos PRE-truncate ---'
SELECT 'ventas'                 AS tabla, COUNT(*) FROM ventas
UNION ALL SELECT 'productos',              COUNT(*) FROM productos
UNION ALL SELECT 'caja_movimientos',       COUNT(*) FROM caja_movimientos
UNION ALL SELECT 'comprobantes',           COUNT(*) FROM comprobantes
UNION ALL SELECT 'audit_logs',             COUNT(*) FROM audit_logs;

-- TRUNCATE ENTERO con RESTART IDENTITY + CASCADE.
TRUNCATE TABLE
  -- Ventas y dependientes
  ventas, venta_items, venta_pagos, venta_comprobantes, canjes, ventas_rapidas,
  -- Cajas y movimientos
  caja_movimientos,
  -- Financiera
  comprobantes, pagos,
  -- Egresos (mantenemos categorias + recurrentes como catálogo)
  egresos,
  -- Cambios de divisa (mantenemos entidades)
  cambio_movimientos,
  -- Tarjetas (mantenemos entidades + planes)
  tarjeta_movimientos,
  -- Proveedores: movimientos (la lista de proveedores se mantiene)
  proveedor_movimientos, proveedor_movimiento_items,
  -- Cuenta corriente B2B (mantenemos clientes_cc)
  movimientos_cc, items_movimiento_cc,
  movimientos_deudas, movimientos_inversiones,
  -- Conciliación bancaria
  conciliaciones, conciliacion_lineas,
  -- Proyectos (operativo, no catálogo)
  proyectos, proyecto_movimientos, proyecto_participantes,
  -- Envíos
  envios, envio_items,
  -- Inventario (todo el stock vivo)
  productos,
  -- Logging
  audit_logs,
  -- Rate limit in-flight counters (limpieza)
  rate_limit_entries
RESTART IDENTITY CASCADE;

-- Conteos POST-truncate — todos deben ser 0.
\echo '--- Conteos POST-truncate (deben ser 0) ---'
SELECT 'ventas'                 AS tabla, COUNT(*) FROM ventas
UNION ALL SELECT 'productos',              COUNT(*) FROM productos
UNION ALL SELECT 'caja_movimientos',       COUNT(*) FROM caja_movimientos
UNION ALL SELECT 'comprobantes',           COUNT(*) FROM comprobantes
UNION ALL SELECT 'audit_logs',             COUNT(*) FROM audit_logs;

-- Verificación: catálogos NO deben estar vacíos (excepto si nunca cargaste).
\echo '--- Catálogos preservados (deben mantenerse) ---'
SELECT 'users'              AS tabla, COUNT(*) FROM users
UNION ALL SELECT 'metodos_pago',      COUNT(*) FROM metodos_pago
UNION ALL SELECT 'categorias',        COUNT(*) FROM categorias
UNION ALL SELECT 'etiquetas',         COUNT(*) FROM etiquetas
UNION ALL SELECT 'proveedores',       COUNT(*) FROM proveedores
UNION ALL SELECT 'contactos',         COUNT(*) FROM contactos
UNION ALL SELECT 'clientes_cc',       COUNT(*) FROM clientes_cc;
