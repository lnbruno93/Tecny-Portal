// Lista canónica de módulos (tools) con permiso por usuario.
// FUENTE ÚNICA DE VERDAD: importar desde acá en vez de redefinir el array.
// Al agregar un módulo nuevo, sumarlo solo acá.
const TOOLS = [
  'cotizador', 'financiera', 'cajas', 'envios',
  'usuarios', 'cuentas', 'usados', 'inventario', 'ventas', 'proveedores', 'proyectos', 'contactos', 'cambios',
];

module.exports = { TOOLS };
