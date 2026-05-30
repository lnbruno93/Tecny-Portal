// Scenarios — qué endpoints testear y con qué carga.
//
// Cada scenario define:
//   name        — etiqueta para el reporte
//   path        — path GET (POST también soportado vía method+body si se requiere)
//   description — qué endpoint mide y por qué importa
//   connections — conexiones concurrentes (≈ usuarios concurrentes)
//   duration    — segundos de duración del test
//
// Los endpoints elegidos son los más pesados / más solicitados en producción.
// No incluyen flows de WRITE (ventas, conciliación POST) — esos generan datos
// que después hay que limpiar, y al ser idempotentes-no, sesgan resultados.

module.exports = [
  {
    name: 'health',
    path: '/health',
    description: 'Liveness probe — pingueado por UptimeRobot c/5min. No es endpoint user-facing, no hace sentido testearlo a 50 conn. Validamos que aguante 10 conn sin saturar el pool DB.',
    connections: 10,
    duration: 10,
  },
  {
    name: 'inventario_list',
    path: '/api/inventario?limit=50',
    description: 'Lista de inventario paginada (50 productos). Endpoint más visitado del portal — vendedores lo abren constantemente.',
    connections: 20,
    duration: 15,
  },
  {
    name: 'dashboard_resumen_mensual',
    path: '/api/dashboard/resumen-mensual',
    description: 'Resumen mensual con 8 queries en paralelo (ventas, cajas, deudas, egresos). Cacheado TTL 60s — el primer hit es el caro.',
    connections: 10,
    duration: 15,
  },
  {
    name: 'alertas_eval',
    path: '/api/alertas',
    description: 'Evaluación de alertas (caja_negativa, stock_bajo, cc_mora, prov_atrasado). Cacheado TTL 5min — primer hit es el caro.',
    connections: 10,
    duration: 10,
  },
  {
    name: 'cuentas_clientes',
    path: '/api/cuentas/clientes?limit=50',
    description: 'Lista de clientes CC con saldo calculado por cliente. JOIN agregado sobre movimientos_cc.',
    connections: 15,
    duration: 15,
  },
  {
    name: 'proveedores_list',
    path: '/api/proveedores?limit=50',
    description: 'Lista de proveedores con saldo (lo que les debemos). LEFT JOIN agregado sobre proveedor_movimientos.',
    connections: 15,
    duration: 15,
  },
  {
    name: 'contactos_search',
    path: '/api/contactos?buscar=lu&limit=20',
    description: 'Search en contactos con ILIKE — disparado por cada keystroke en quick-add. Debería usar índice trigram (gin_trgm).',
    connections: 20,
    duration: 10,
  },
];
