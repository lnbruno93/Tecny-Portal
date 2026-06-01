// Seg — selector segmentado (radio-like) usado en filtros de Ventas para
// elegir período (hoy/semana/mes/etc). Renderiza botones con clase `seg`
// que el CSS pinta agrupados.
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
