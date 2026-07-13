// Crea una venta REAL a partir de un envío para evitar el doble trabajo. La venta
// auto-creada hereda los items 'producto' Y los items 'pago' del envío.
//
//   · items 'producto' → venta_items (descuenta stock si hay producto_id).
//   · items 'pago'     → venta_pagos. La venta es la única fuente de verdad
//                        de los efectos secundarios financieros: dispara
//                        syncVentaCaja, sincronizarCuentaCorriente,
//                        syncFinancieraComprobante, syncTarjetaCobros.
//
// Cuando registrar_venta=true, el envío NO postea directamente a caja
// (lo hace la venta). Cuando es false, los items 'pago' los postea el envío.
//
// Debe ejecutarse dentro de la transacción del envío.
const crypto = require('crypto');
const { round2, toUsd } = require('./money');
const { descontarStock } = require('./ventaCore');
const { syncVentaCaja, sincronizarCuentaCorriente, syncVentaVuelto } = require('./ventaSync');
const { syncFinancieraComprobante } = require('./financiera');
const { syncTarjetaCobros } = require('./tarjetas');

function genOrderId() {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `ORD-${yy}-${crypto.randomBytes(6).toString('hex')}`;
}

// 2026-07-13 (feature vuelto Fase 2): `opts.vuelto` es el 4to param opcional.
// Cuando el envío incluye vuelto (validado en el handler con registrar_venta=true),
// el 3 campos se persisten en `ventas` y se postea el egreso via syncVentaVuelto.
// Sin opts.vuelto → comportamiento pre-Fase-2 (venta sin vuelto).
async function crearVentaDesdeEnvio(client, envio, items, userId, opts = {}) {
  const vueltoCompleto = opts.vuelto_monto && opts.vuelto_moneda && opts.vuelto_caja_id;
  const productos = (items || []).filter(i => i.tipo === 'producto');
  if (productos.length === 0) return null;

  // Total/ganancia: convertimos cada item a USD según SU moneda (no asumir ARS).
  //   · 'USD'/'USDT' → 1:1 (no necesita TC).
  //   · 'ARS' → necesita envio.tc para convertir; sino queda 0 (registro sin total).
  let totalUsd = 0;
  let costoUsd = 0;
  for (const it of productos) {
    const monto = round2(Number(it.monto) || 0);
    const moneda = it.moneda || 'ARS';
    if (moneda === 'ARS') {
      if (envio.tc && Number(envio.tc) > 0) totalUsd += toUsd(monto, 'ARS', envio.tc);
      // sin TC, item ARS no aporta al total
    } else {
      totalUsd += monto; // USD o USDT
    }
  }
  totalUsd = round2(totalUsd);

  // Si hay producto_id linkeados, traemos costos en UNA sola query (ANY int[]).
  // El mapa `costoPorId` se reusa para (a) calcular costoUsd y (b) los inserts
  // de venta_items abajo — antes hacíamos un SELECT por cada item dentro del
  // loop, que con 10 items linkeados eran 11 round-trips a Railway DB.
  const linkedItems = productos.filter(p => p.producto_id);
  let costoPorId = new Map();
  if (linkedItems.length > 0) {
    const ids = [...new Set(linkedItems.map(p => p.producto_id))];
    const { rows: prods } = await client.query(
      'SELECT id, costo, costo_moneda FROM productos WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
      [ids]
    );
    costoPorId = new Map(prods.map(p => [p.id, p]));
    for (const it of linkedItems) {
      const p = costoPorId.get(it.producto_id);
      if (!p) continue;
      const costoMon = p.costo_moneda || 'USD';
      if (costoMon === 'ARS') {
        if (envio.tc && Number(envio.tc) > 0) costoUsd += toUsd(Number(p.costo) || 0, 'ARS', envio.tc);
      } else {
        costoUsd += Number(p.costo) || 0;
      }
    }
    costoUsd = round2(costoUsd);
  }
  const gananciaUsd = round2(totalUsd - costoUsd);

  // 2026-06-10 — La venta nace 'pendiente' hasta que el envío se marca como
  // 'Entregado'. Mientras está pendiente, NO suma en la ganancia neta del
  // dashboard (que filtra por estado='acreditado'). Las cajas SÍ se postean
  // porque retieneStock() es true para 'pendiente' — la plata ya entró cuando
  // se registró el envío, sólo el reconocimiento contable de la ganancia
  // espera la entrega. Cuando se crea un envío directamente como 'Entregado'
  // (alta retroactiva), la venta nace acreditada para no obligar a un paso
  // extra de confirmación.
  const estadoVenta = envio.estado === 'Entregado' ? 'acreditado' : 'pendiente';
  const { rows } = await client.query(
    `INSERT INTO ventas (order_id, fecha, cliente_nombre, cliente_cc_id, estado, total_usd, ganancia_usd, tc_venta, notas, user_id, vuelto_monto, vuelto_moneda, vuelto_caja_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [genOrderId(), envio.fecha, envio.cliente, envio.cliente_cc_id ?? null, estadoVenta, totalUsd, gananciaUsd, envio.tc ?? null, 'Generada automáticamente desde un envío', userId,
     // 2026-07-13 (Fase 2): 3 campos del vuelto pasan al INSERT.
     vueltoCompleto ? opts.vuelto_monto : null,
     vueltoCompleto ? opts.vuelto_moneda : null,
     vueltoCompleto ? opts.vuelto_caja_id : null]
  );
  const venta = rows[0];

  for (const it of productos) {
    const precio = round2(Number(it.monto) || 0);
    const moneda = it.moneda || 'ARS';
    // Reusamos el mapa ya cargado en lugar de SELECT por item.
    const prod = it.producto_id ? costoPorId.get(it.producto_id) : null;
    const costoItem = prod ? round2(Number(prod.costo) || 0) : 0;
    const ganancia = round2(precio - costoItem);
    await client.query(
      `INSERT INTO venta_items (venta_id, producto_id, descripcion, cantidad, precio_vendido, costo, moneda, comision, ganancia)
       VALUES ($1,$2,$3,1,$4,$5,$6,0,$7)`,
      [venta.id, it.producto_id || null, it.descripcion || 'Producto', precio, costoItem, moneda, ganancia]
    );
  }

  // Crear venta_pagos desde los items 'pago' del envío y disparar los syncs.
  await sincronizarPagosDesdeEnvio(client, venta, items, envio, userId);

  // 2026-07-13 (Fase 2): postear egreso a la caja del vuelto DESPUÉS de
  // syncVentaCaja (que corre dentro de sincronizarPagosDesdeEnvio). Si el
  // vuelto excede saldo caja o moneda no matchea, throwea 400 → handler PUT
  // /envios propaga y hace ROLLBACK.
  if (vueltoCompleto) {
    await syncVentaVuelto(client, venta, userId);
  }

  // Descontar stock para los items linkeados a productos.
  if (linkedItems.length > 0) {
    await descontarStock(client, linkedItems.map(it => ({ producto_id: it.producto_id, cantidad: 1 })));
  }

  return venta;
}

// Crea venta_pagos a partir de los items 'pago' del envío y dispara los efectos
// secundarios (caja, CC, financiera, tarjeta). Idempotente: revierte previos y
// recrea desde cero — útil tanto para crear como para actualizar.
async function sincronizarPagosDesdeEnvio(client, venta, items, envio, userId) {
  // Limpiar venta_pagos previos por si re-creamos en un update.
  await client.query('DELETE FROM venta_pagos WHERE venta_id = $1', [venta.id]);

  const pagos = (items || []).filter(i => i.tipo === 'pago');
  for (const p of pagos) {
    const monto = round2(Number(p.monto) || 0);
    if (monto <= 0) continue;
    const moneda = p.moneda || 'ARS';
    const tc = p.tc ?? envio.tc ?? null;
    const monto_usd = round2(toUsd(monto, moneda, tc));
    // Resolvemos el nombre del método para el comprobante / dashboard.
    // Auditoría 2026-06-30 D-01: además del nombre, leemos comision_pct para
    // snapshotear en venta_pagos.comision_pct_snapshot. Si no hay metodo_pago_id
    // (CC o pago manual), el snapshot queda NULL.
    let metodo_nombre = p.metodo_pago || (p.es_cuenta_corriente ? 'Cuenta corriente' : null);
    let comision_pct_snapshot = null;
    const mpIdForLookup = p.es_cuenta_corriente ? null : (p.metodo_pago_id ?? null);
    if (mpIdForLookup) {
      const { rows: mp } = await client.query(
        'SELECT nombre, comision_pct FROM metodos_pago WHERE id = $1', [mpIdForLookup]
      );
      if (!metodo_nombre) metodo_nombre = mp[0]?.nombre || 'Pago';
      comision_pct_snapshot = mp[0]?.comision_pct ?? null;
    } else if (!metodo_nombre && p.metodo_pago_id) {
      // (camino legacy: sólo se llega acá si es_cuenta_corriente, pero por
      // seguridad cubrimos el caso de p.metodo_pago_id presente).
      const { rows: mp } = await client.query('SELECT nombre FROM metodos_pago WHERE id = $1', [p.metodo_pago_id]);
      metodo_nombre = mp[0]?.nombre || 'Pago';
    }
    await client.query(
      `INSERT INTO venta_pagos (venta_id, metodo_pago_id, metodo_nombre, monto, moneda, tc, monto_usd, es_cuenta_corriente, comision_pct_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [venta.id, p.es_cuenta_corriente ? null : (p.metodo_pago_id ?? null), metodo_nombre || 'Pago',
       monto, moneda, tc, monto_usd, !!p.es_cuenta_corriente, comision_pct_snapshot]
    );
  }

  // Efectos secundarios — la venta es la fuente de verdad ahora.
  await syncVentaCaja(client, venta, userId);
  await sincronizarCuentaCorriente(client, venta);
  await syncFinancieraComprobante(client, venta.id, venta.estado);
  await syncTarjetaCobros(client, venta.id, venta.estado);
}

// Sincroniza los venta_items con los items del envío cuando éste se edita.
// Devuelve la venta actualizada o null si la venta ya no existe.
// 2026-07-13 (Fase 2): igual que crear, `opts.vuelto_*` opcionales — cuando
// el edit del envío modifica el vuelto (agregar, cambiar monto/caja, o quitar
// enviando los 3 null), lo persistimos en la venta linkeada + re-syncamos.
async function actualizarVentaDesdeEnvio(client, envio, items, userId, opts = {}) {
  if (!envio.venta_id) return null;
  const hasVueltoInOpts = 'vuelto_monto' in opts || 'vuelto_moneda' in opts || 'vuelto_caja_id' in opts;
  const vueltoCompleto = opts.vuelto_monto && opts.vuelto_moneda && opts.vuelto_caja_id;
  // Reponer stock de los items linkeados anteriores antes de borrar.
  const { rows: prev } = await client.query(
    'SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL',
    [envio.venta_id]
  );
  if (prev.length) {
    const { reponerStock } = require('./ventaCore');
    await reponerStock(client, prev);
  }
  await client.query('DELETE FROM venta_items WHERE venta_id = $1', [envio.venta_id]);

  // Re-insertar items + recalcular total/ganancia + re-descontar stock para los nuevos linkeados.
  const productos = (items || []).filter(i => i.tipo === 'producto');
  let totalUsd = 0, costoUsd = 0;
  const hasTc = envio.tc && Number(envio.tc) > 0;
  for (const it of productos) {
    const monto = round2(Number(it.monto) || 0);
    const moneda = it.moneda || 'ARS';
    if (moneda === 'ARS') {
      if (hasTc) totalUsd += toUsd(monto, 'ARS', envio.tc);
    } else {
      totalUsd += monto;
    }
  }
  totalUsd = round2(totalUsd);

  // Preload de costos de los productos linkeados en una sola query.
  // Antes hacíamos un SELECT por cada item dentro del loop → con 20 items
  // linkeados eran 20 round-trips a Railway DB dentro de la tx del envío.
  const linkedNew = productos.filter(p => p.producto_id);
  let costoPorId = new Map();
  if (linkedNew.length > 0) {
    const ids = [...new Set(linkedNew.map(p => p.producto_id))];
    const { rows: prods } = await client.query(
      'SELECT id, costo, costo_moneda FROM productos WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
      [ids]
    );
    costoPorId = new Map(prods.map(p => [p.id, p]));
  }
  for (const it of productos) {
    const precio = round2(Number(it.monto) || 0);
    const moneda = it.moneda || 'ARS';
    let costoItem = 0;
    if (it.producto_id) {
      const pr = costoPorId.get(it.producto_id);
      if (pr) {
        costoItem = round2(Number(pr.costo) || 0);
        const costoMon = pr.costo_moneda || 'USD';
        if (costoMon === 'ARS') { if (hasTc) costoUsd += toUsd(costoItem, 'ARS', envio.tc); }
        else costoUsd += costoItem;
      }
    }
    await client.query(
      `INSERT INTO venta_items (venta_id, producto_id, descripcion, cantidad, precio_vendido, costo, moneda, comision, ganancia)
       VALUES ($1,$2,$3,1,$4,$5,$6,0,$7)`,
      [envio.venta_id, it.producto_id || null, it.descripcion || 'Producto', precio, costoItem, moneda, round2(precio - costoItem)]
    );
  }
  const gananciaUsd = round2(totalUsd - costoUsd);
  const { rows: vrows } = await client.query(
    `UPDATE ventas SET total_usd = $1, ganancia_usd = $2, cliente_cc_id = COALESCE($3, cliente_cc_id), tc_venta = COALESCE($4, tc_venta) WHERE id = $5 RETURNING *`,
    [totalUsd, gananciaUsd, envio.cliente_cc_id ?? null, envio.tc ?? null, envio.venta_id]
  );
  let venta = vrows[0];

  // 2026-07-13 (Fase 2): mismo patrón que routes/ventas.js — UPDATE dedicado
  // de los 3 campos SI el body del envío los envía (aunque sean null para
  // "quitar" el vuelto de un envío que lo tenía).
  if (venta && hasVueltoInOpts) {
    const { rows: upd } = await client.query(
      `UPDATE ventas SET vuelto_monto = $1, vuelto_moneda = $2, vuelto_caja_id = $3 WHERE id = $4 RETURNING *`,
      [vueltoCompleto ? opts.vuelto_monto : null, vueltoCompleto ? opts.vuelto_moneda : null, vueltoCompleto ? opts.vuelto_caja_id : null, venta.id]
    );
    venta = upd[0];
  }

  // Re-sincronizar venta_pagos desde los items 'pago' actuales del envío.
  if (venta) await sincronizarPagosDesdeEnvio(client, venta, items, envio, userId);
  // Postear egreso del vuelto post-sync de caja (mismo orden que en el POST
  // /ventas y en crearVentaDesdeEnvio).
  if (venta) await syncVentaVuelto(client, venta, userId);

  // Descontar stock de los nuevos linkeados (reusa linkedNew calculado arriba).
  if (linkedNew.length) {
    await descontarStock(client, linkedNew.map(it => ({ producto_id: it.producto_id, cantidad: 1 })));
  }

  return venta || null;
}

module.exports = { crearVentaDesdeEnvio, actualizarVentaDesdeEnvio };
