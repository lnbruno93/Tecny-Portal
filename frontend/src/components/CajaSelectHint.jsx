// CajaSelectHint — option disabled que se agrega al final de los <select>
// de cajas para recordar dónde se administran.
//
// Por política, TODAS las cajas se crean en "Cajas → Config Cajas". No
// hay quick-add en otros lugares (intencional: single source of truth y
// evitar errores de tipeo / duplicados). Este hint hace visible la regla
// sin invadir el flow: solo aparece cuando el usuario abre el selector
// buscando una caja que no encuentra.
//
// Uso:
//   <select>
//     <option value="">— Elegí —</option>
//     {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
//     <CajaSelectHint />
//   </select>

export default function CajaSelectHint() {
  return (
    <>
      <option disabled value="" style={{ color: 'var(--text-muted)' }}>──────────</option>
      <option disabled value="" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
        ¿Falta una caja? Cargala en Cajas → Config
      </option>
    </>
  );
}
