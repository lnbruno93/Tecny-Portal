/**
 * Migration: agregar `config.ocultar_ganancia_venta` — toggle privacidad
 *
 * ── Contexto (pedido tenant 2026-08-01) ─────────────────────────────────
 *
 * Cuando el operador carga una venta frente al cliente, el modal muestra
 * el bloque de ganancia real preview (Ganancia bruta / Vuelto / Ganancia
 * real). El cliente ve la pantalla → ve el margen del negocio → incómodo
 * para algunos comercios.
 *
 * Lucas (PO): NO eliminar el feature (el operador lo usa para verificar
 * rentabilidad al vuelo), pero permitir a cada tenant ocultarlo desde
 * Configuración > General.
 *
 * ── Shape ───────────────────────────────────────────────────────────────
 *
 * BOOLEAN NOT NULL DEFAULT FALSE — default "mostrar" preserva el
 * comportamiento actual para todos los tenants existentes. Solo el que
 * lo active explícitamente desde el portal cambia comportamiento.
 *
 * Convive con `pct_financiera` en la misma tabla `config` (1 fila por
 * tenant, PK (tenant_id, id=1)). Handler PUT usa COALESCE-style: solo
 * cambia lo que viene en el body.
 *
 * ── Scope del ocultamiento (frontend) ───────────────────────────────────
 *
 * Solo se ocultan las 3 líneas del bloque "Preview de ganancia":
 *   · Ganancia bruta
 *   · Vuelto entregado
 *   · Ganancia real
 * El resto del bloque totales (Total venta, Cubierto, Diferencia) sigue
 * visible — el operador necesita ver si el cliente pagó el monto correcto.
 *
 * NO afecta:
 *   · Dashboard Ventas (KPIs de ganancia) — es contexto interno, no se
 *     ve frente al cliente.
 *   · Comprobante enviado al cliente (nunca tuvo ganancia).
 *   · Response del backend (GET /ventas devuelve ganancia_usd igual —
 *     el toggle es solo cosmético en el modal frontend).
 */

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE config
      ADD COLUMN IF NOT EXISTS ocultar_ganancia_venta BOOLEAN NOT NULL DEFAULT FALSE;
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`ALTER TABLE config DROP COLUMN IF EXISTS ocultar_ganancia_venta;`);
};
