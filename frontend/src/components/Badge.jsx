// Badge — chip de estado/etiqueta. Uniforma `tone` con los presets CSS
// del proyecto (`.badge-pos`, `.badge-neg`, `.badge-warn`, `.badge-info`,
// `.badge-default`, etc.).
//
// Uso:
//   <Badge tone="pos">Acreditado</Badge>
//
// Históricamente este componente vivía duplicado en cada screen (~7
// duplicaciones cuando se extrajo). Centralizado acá para que un fix
// visual sea único. Los screens que aún tienen su Badge local son
// candidatos a migrar gradualmente.
export default function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
