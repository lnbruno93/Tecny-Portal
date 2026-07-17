#!/usr/bin/env node
/**
 * seed-release-notes.js — Poblado inicial del feature Novedades (task #148).
 *
 * Contexto: task #142 dejó el feature de release notes live end-to-end
 * (backend + admin CMS + portal cliente con badge). Pero salió VACÍO —
 * cuando el cliente abra /novedades no ve nada. Este script pone 10 notas
 * reales curadas desde los últimos 8 días de git log en un solo pasaje.
 *
 * Cómo se corre:
 *   1. Loguearte al admin (admin.tecnyapp.com) → DevTools → Console:
 *      `copy(localStorage.getItem('admin_token'))`
 *   2. Pegar el token en el env var:
 *      export ADMIN_JWT="ey..."
 *   3. Correr:
 *      node scripts/seed-release-notes.js
 *
 * El script es IDEMPOTENTE por diseño (no chequea duplicados). Si lo corrés
 * 2 veces vas a tener 2 copias de cada nota. Después del primer run:
 *   - Verificás en admin.tecnyapp.com/novedades que están las 10.
 *   - Si algo no gustó, lo editás o borrás desde la UI.
 *   - NO volver a correr.
 *
 * Diseño de las notas:
 *   - Título ≤ 60 chars (respetar el CHECK constraint del backend)
 *   - Descripción ≤ 280 chars
 *   - tipo ∈ {'feature', 'mejora', 'fix'}
 *   - publicado_en explícito, escalado en el pasado (ver TIMESTAMPS abajo)
 *
 * Los `publicado_en` NO son "ahora" a propósito — usamos fechas reales
 * escaladas para simular el histórico de la semana. Así el cliente al
 * abrir /novedades ve una lista ordenada natural (Hoy · Ayer · antes),
 * no 10 items todos con timestamp idéntico.
 */

/* eslint-disable no-console */

const API_BASE = process.env.API_BASE || 'https://tecny-backend-production.up.railway.app';
const ADMIN_JWT = process.env.ADMIN_JWT;

if (!ADMIN_JWT) {
  console.error('❌ Falta ADMIN_JWT. Instrucciones en el header de este archivo.');
  process.exit(1);
}

// ─── Contenido curado ────────────────────────────────────────────────────
// Fechas escaladas: 2026-07-16 hoy, 2026-07-15 ayer, etc. Las notas más
// importantes van MÁS RECIENTES para que dominen la vista del user.

const NOTAS = [
  // ── HOY (2026-07-16) ─────────────────────────────────────────────
  {
    tipo: 'mejora',
    titulo: 'Errores en formularios más claros y en vivo',
    descripcion: 'Los formularios ahora te muestran los errores debajo de cada campo en el momento, no cuando clickeás Guardar. Al empezar a corregir, el mensaje desaparece solo. Aplicado a Contactos, Usuarios, Envíos, Cambios e Inventario.',
    publicado_en: '2026-07-16T18:00:00-03:00',
  },
  {
    tipo: 'fix',
    titulo: 'Historial: el detalle ya no muestra JSON crudo',
    descripcion: 'Cuando abrías el detalle de un evento en Historial veías un bloque de JSON con llaves y comillas — feo y difícil de leer. Ahora aparece con secciones claras: Qué pasó, Usuario, Módulo, Fecha.',
    publicado_en: '2026-07-16T16:00:00-03:00',
  },
  {
    tipo: 'mejora',
    titulo: 'Estados vacíos y de carga más informativos',
    descripcion: 'Ventas y Contactos ahora muestran skeleton al cargar (menos flash blanco) y mensajes accionables cuando no hay data ("Todavía no cargaste contactos" + botón). Cambios y Cajas ganaron banners de reintentar cuando falla la red.',
    publicado_en: '2026-07-16T14:00:00-03:00',
  },

  // ── AYER (2026-07-15) ────────────────────────────────────────────
  {
    tipo: 'feature',
    titulo: 'Novedades: ahora te contamos qué cambió en el portal',
    descripcion: 'Cada vez que soltemos una mejora o corrijamos un bug, vas a ver acá una nota corta explicándolo. El puntito celeste en el menú te avisa cuando hay algo nuevo desde tu última visita.',
    publicado_en: '2026-07-15T20:00:00-03:00',
  },
  {
    tipo: 'fix',
    titulo: 'Comprobantes: el canje se suma al total cobrado',
    descripcion: 'Cuando cerrás una venta con canje (ej. iPhone 14 Pro por USD 250 + efectivo por el resto), el PDF ahora muestra el equipo entregado en su propia sección y suma su valor al total. Antes daba una diferencia falsa "en contra".',
    publicado_en: '2026-07-15T15:30:00-03:00',
  },

  // ── ANTEAYER (2026-07-14) ────────────────────────────────────────
  {
    tipo: 'feature',
    titulo: 'Cambios de Divisa: ahora también dirección inversa',
    descripcion: 'Antes solo podías registrar "entregás pesos y recibís USD". Ahora también "entregás USD y recibís ARS/UYU". Un segmented control arriba del form deja clarísimo qué dirección estás cargando para no confundir montos.',
    publicado_en: '2026-07-14T17:00:00-03:00',
  },
  {
    tipo: 'fix',
    titulo: 'Cmd+K: al clickear una venta, se abre esa venta',
    descripcion: 'En la búsqueda global (Cmd+K / Ctrl+K), cuando clickeabas un resultado de "Ventas", te mandaba al dashboard del día sin la venta abierta. Ahora abre directamente el detalle de la venta específica.',
    publicado_en: '2026-07-14T11:00:00-03:00',
  },

  // ── LUNES (2026-07-13) ───────────────────────────────────────────
  {
    tipo: 'fix',
    titulo: 'Cajas → Deudas a cobrar: layout más leíble',
    descripcion: 'El detalle de deudas ahora aparece debajo de la tabla, no al costado achicándola. Se ven mucho mejor los montos y los conceptos, especialmente en pantallas medianas.',
    publicado_en: '2026-07-13T16:00:00-03:00',
  },
  {
    tipo: 'mejora',
    titulo: 'IMEIs duplicados: mensaje amigable en vez de error genérico',
    descripcion: 'Cuando editás un producto y ponés un IMEI que ya está en otro producto activo, el portal ahora te avisa con un mensaje claro y te muestra en cuál está. Antes daba un 500 genérico.',
    publicado_en: '2026-07-13T10:00:00-03:00',
  },

  // ── SEMANA PASADA (2026-07-11) ───────────────────────────────────
  {
    tipo: 'feature',
    titulo: 'Búsqueda global (Cmd+K / Ctrl+K)',
    descripcion: 'Presioná Cmd+K en cualquier pantalla y buscá productos, ventas, clientes, envíos, cajas y egresos desde un solo lugar. Podés navegar con flechas y elegir con Enter — todo sin sacar las manos del teclado.',
    publicado_en: '2026-07-11T18:00:00-03:00',
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────

async function postNota(nota) {
  const url = `${API_BASE}/api/super-admin/release-notes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_JWT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(nota),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  console.log(`\n📢 Seed inicial de Novedades — ${NOTAS.length} notas`);
  console.log(`   API: ${API_BASE}\n`);

  let ok = 0;
  let fail = 0;
  for (const nota of NOTAS) {
    const tag = {
      feature: '🚀',
      mejora:  '✨',
      fix:     '🐛',
    }[nota.tipo] || '·';
    try {
      const res = await postNota(nota);
      ok++;
      console.log(`   ${tag} [${res.id.slice(0, 8)}] ${nota.titulo}`);
    } catch (e) {
      fail++;
      console.error(`   ❌ ${nota.titulo}\n      → ${e.message}`);
    }
  }

  console.log(`\n${ok}/${NOTAS.length} OK${fail ? `, ${fail} fallidas` : ''}.`);
  if (ok > 0) {
    console.log('\n✅ Entrá al portal cliente (tecnyapp.com) para verlas con el badge celeste.');
    console.log('   O al admin (admin.tecnyapp.com/novedades) para revisar/editar/borrar.\n');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ Error inesperado:', e);
  process.exit(1);
});
