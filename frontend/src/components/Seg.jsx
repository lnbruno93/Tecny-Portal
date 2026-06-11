// Seg — selector segmentado (radio-like) usado para filtros de período o estado.
// Renderiza botones con clase `seg` que el CSS pinta agrupados (ver index.css
// .seg / .seg button.on).
//
// Históricamente este componente vivía duplicado en cada screen (Envios, Cajas,
// Tarjetas, Inventario, CuentasCC, ventas/Seg.jsx). Centralizado acá en U-13
// (auditoría 2026-06-10) para que cambios visuales sean únicos.
//
// Uso:
//   <Seg
//     value={periodo}
//     options={[{ value: 'hoy', label: 'Hoy' }, ...]}
//     onChange={setPeriodo}
//   />
export default function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
