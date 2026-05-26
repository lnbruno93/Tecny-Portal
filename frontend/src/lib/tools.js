// Lista canónica de módulos (tools) con permiso por usuario — lado frontend.
// FUENTE ÚNICA DE VERDAD en el front: importar desde acá en vez de redefinir el array.
// DEBE coincidir con backend/src/lib/tools.js (mismo contenido y orden).
// Al agregar un módulo nuevo, sumarlo acá y en el backend.
export const TOOLS = [
  'cotizador', 'financiera', 'cajas', 'envios',
  'usuarios', 'cuentas', 'usados', 'inventario', 'ventas', 'proveedores', 'proyectos',
];
