import { useState } from 'react';
import EgresosPanel from './EgresosPanel';
import MovimientosCajaPanel from './MovimientosCajaPanel';
import Seg from '../components/Seg';

// Pantalla Egresos y Movimientos (ítem propio del menú, bajo Cajas).
// 2026-07-04 #505: pasó de single-panel a tabs internos:
//   · "Egresos"      → gastos reales del negocio (proveedor, sueldos, etc.).
//   · "Movimientos"  → transferencias entre 2 cajas propias del negocio
//                      (ej. retiro banco USD → efectivo USD). No modifican
//                      el patrimonio total, solo mueven plata entre contenedores.
// Ambos tabs comparten la misma capability ('egresos.ver') y viven en el mismo
// item del sidebar — el operador entra a "Egresos y Movimientos" y elige la
// operación arriba.
export default function Egresos() {
  const [tab, setTab] = useState('egresos');

  return (
    <div>
      <div className="page-head u-mb-20">
        <div>
          <h1 className="page-title">Egresos y Movimientos</h1>
          <div className="page-sub">
            {tab === 'egresos'
              ? 'Gastos de la empresa · categorías, recurrentes y estado pendiente/pagado'
              : 'Transferencias internas entre tus cajas · misma moneda, sin financiera'}
          </div>
        </div>
        <Seg
          value={tab}
          options={[
            { value: 'egresos',      label: 'Egresos' },
            { value: 'movimientos',  label: 'Movimientos de caja' },
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'egresos'    && <EgresosPanel />}
      {tab === 'movimientos' && <MovimientosCajaPanel />}
    </div>
  );
}
