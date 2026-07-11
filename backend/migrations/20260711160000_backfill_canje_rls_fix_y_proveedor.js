/**
 * 20260711160000_backfill_canje_rls_fix_y_proveedor.js
 *
 * Fix + feature en una sola migration:
 *
 * ## 1) Re-run del backfill de costo (RLS fix)
 *
 * La migration `20260711130000_backfill_producto_costo_from_canje` corrió en
 * prod pero afectó 0 filas por RLS: `productos` tiene FORCE ROW LEVEL SECURITY,
 * y node-pg-migrate corre sin `SET LOCAL app.current_tenant` → la policy
 * `tenant_isolation` deja el WHERE efectivamente en `WHERE false`.
 *
 * Ya lo verificamos manualmente ejecutando el UPDATE bypasseando RLS
 * (afectó 2 productos: iPhone 17 de Lucas + iPhone 15 de otro tenant).
 * Esta migration re-corre el backfill CON el patrón correcto
 * (`NO FORCE ROW LEVEL SECURITY` durante el UPDATE, restaurar después).
 *
 * Ver referencia: migration `20260708000001_productos_clase_categorias_reales.js`
 * y runbook `docs/runbooks/rls-bulk-migration.md`.
 *
 * ## 2) Backfill de proveedor desde canjes
 *
 * Feature pedida por Lucas: cuando un equipo entró a Inventario por canje,
 * el campo `proveedor` del producto debería tener el nombre del cliente que
 * lo entregó (no queda vacío). Hoy los productos legacy tienen proveedor
 * NULL. Backfill: para productos con `proveedor IS NULL` o vacío que están
 * ligados a un canje, setear `proveedor = ventas.cliente_nombre`.
 *
 * En el mismo PR el handler POST/PUT ventas (routes/ventas.js) también
 * setea `proveedor = cliente_nombre` al crear/actualizar el producto por
 * canje — así los canjes futuros salen bien de fábrica.
 *
 * Idempotente: solo actualiza filas con `proveedor` vacío o NULL.
 * Rollback: no-op (destructivo — el proveedor real puede haber sido
 * editado a mano post-backfill).
 */

exports.up = async (pgm) => {
  pgm.sql(`
    -- Bypass temporal de RLS para el UPDATE cross-tenant. Restauramos al
    -- final. La transacción wrapping de node-pg-migrate mantiene esto
    -- consistente incluso en caso de rollback.
    ALTER TABLE productos NO FORCE ROW LEVEL SECURITY;

    -- ─── Backfill 1: costo desde canjes.valor_toma ─────────────────
    -- Idempotente: solo productos con costo=0 o NULL. Re-correr no toca
    -- los que ya tienen costo.
    UPDATE productos p
       SET costo        = c.valor_toma,
           costo_moneda = COALESCE(NULLIF(p.costo_moneda, ''), c.moneda)
      FROM canjes c
     WHERE c.producto_id = p.id
       AND c.valor_toma > 0
       AND (p.costo IS NULL OR p.costo = 0)
       AND p.deleted_at IS NULL;

    -- ─── Backfill 2: proveedor desde cliente_nombre de la venta ────
    -- Feature Lucas: si el producto vino por canje, el "proveedor" es el
    -- cliente que lo entregó. Solo tocamos productos con proveedor NULL
    -- o vacío (respeta ediciones manuales del operador).
    UPDATE productos p
       SET proveedor = v.cliente_nombre
      FROM canjes c
      JOIN ventas v ON v.id = c.venta_id AND v.deleted_at IS NULL
     WHERE c.producto_id = p.id
       AND v.cliente_nombre IS NOT NULL
       AND TRIM(v.cliente_nombre) <> ''
       AND (p.proveedor IS NULL OR TRIM(p.proveedor) = '')
       AND p.deleted_at IS NULL;

    ALTER TABLE productos FORCE ROW LEVEL SECURITY;
  `);
};

exports.down = async () => {
  // No-op — ambos backfills son destructivos si se revertieran.
};
