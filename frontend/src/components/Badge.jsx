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
// Cajas, Usuarios y Financiera al import único. `className` se concatena
// con `badge badge-{tone}`, no lo reemplaza.
//
// Sprint 99 (CSP): removida la prop `style` — no había callers usándola en
// código real. Si en el futuro se necesita override puntual, usar className.
export default function Badge({ tone = 'default', children, className }) {
  const cls = `badge badge-${tone}${className ? ` ${className}` : ''}`;
  return <span className={cls}>{children}</span>;
}
