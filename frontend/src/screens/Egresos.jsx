import EgresosPanel from './EgresosPanel';

// Pantalla Egresos (ítem propio del menú, bajo Cajas). Comparte el panel con
// el resto de la lógica de egresos.
export default function Egresos() {
  return (
    <div>
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Egresos</h1>
          <div className="page-sub">Gastos de la empresa · categorías, recurrentes y estado pendiente/pagado</div>
        </div>
      </div>
      <EgresosPanel />
    </div>
  );
}
