// Badge — chip de estado/etiqueta. Uniforma `tone` con los presets CSS
// del proyecto (`.badge-pos`, `.badge-neg`, `.badge-warn`, `.badge-info`,
// `.badge-default`, etc.).
//
// Uso:
//   <Badge tone="pos">Acreditado</Badge>
//   <Badge tone="info" className="u-fs-11">Etiqueta chica</Badge>
//
// Históricamente este componente vivía duplicado en cada screen. En U-13
// (auditoría 2026-06-10) se centralizó y se migraron Inventario, Envíos,
// Cajas, Usuarios y Financiera al import único. `style`/`className` se
// pasan para permitir override puntual (ej. tamaño reducido en chips de
// permisos en Usuarios.jsx). `className` se concatena con `badge badge-{tone}`,
// no lo reemplaza.
export default function Badge({ tone = 'default', children, style, className }) {
  const cls = `badge badge-${tone}${className ? ` ${className}` : ''}`;
  return <span className={cls} style={style}>{children}</span>;
}
