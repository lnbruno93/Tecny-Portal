// ExpiredBanner tests — TANDA 4.C billing pre-live 2026-06-25.
//
// Cubre los 4 estados visibles:
//   1. No render: sin user / sin tenant / grandfathered / lejos del vencimiento.
//   2. Warning (amarillo): paid_until ∈ [hoy, hoy+7d].
//   3. Expired (rojo): paid_until < hoy.
//   4. Suspended (rojo): suspended_at != null.
//   5. Dismiss en warning oculta el banner. No así en expired/suspended.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockUser = null;

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import ExpiredBanner from './ExpiredBanner';

// Helper: fecha YYYY-MM-DD a `n` días desde hoy, EN LOCAL TZ.
//
// BUG HISTÓRICO (issue #466): antes usaba `.toISOString().slice(0,10)` que
// devuelve la fecha en UTC, pero `setDate(getDate()+n)` opera en LOCAL TZ →
// mezcla TZ → off-by-one cerca del UTC boundary. Ejemplo: a las 22:00 AR
// (=01:00 UTC del día siguiente), `dateInDays(1)` devolvía la fecha DOS DÍAS
// adelante en local AR. El componente `parseLocalDate` interpreta el string
// como local, entonces el test esperaba +1 pero veía +2 y fallaba el match.
//
// Fix: construimos el string YYYY-MM-DD manualmente con getFullYear /
// getMonth / getDate (todos LOCAL TZ), así matchea exactamente lo que
// `parseLocalDate` espera del backend (PG DATE en TZ del servidor).
function dateInDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function makeUser(overrides = {}) {
  return {
    id: 1,
    email: 'op@tenant.com',
    is_super_admin: false,
    tenant: {
      id: 1,
      plan: 'starter',
      paid_until: null,
      suspended_at: null,
      is_active: true,
      ...(overrides.tenant || {}),
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockUser = null;
});

describe('ExpiredBanner — no render', () => {
  it('no renderiza si no hay user', () => {
    mockUser = null;
    const { container } = render(<ExpiredBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('no renderiza si user.tenant es null (fallback)', () => {
    mockUser = { id: 1, email: 'x@y.z', tenant: null };
    const { container } = render(<ExpiredBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('no renderiza para super-admin', () => {
    mockUser = makeUser({
      is_super_admin: true,
      tenant: { ...makeUser().tenant, paid_until: dateInDays(-5), is_active: false },
    });
    const { container } = render(<ExpiredBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('no renderiza si paid_until=null (grandfathered)', () => {
    mockUser = makeUser({ tenant: { paid_until: null, is_active: true, suspended_at: null } });
    const { container } = render(<ExpiredBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('no renderiza si paid_until > hoy+7d (lejos del vencimiento)', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(30), is_active: true, suspended_at: null,
    }});
    const { container } = render(<ExpiredBanner />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ExpiredBanner — estado warning (≤7 días)', () => {
  it('paid_until = hoy+3d → banner amarillo "en 3 días"', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(3), is_active: true, suspended_at: null,
    }});
    render(<ExpiredBanner />);
    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    // El texto se compone de spans + strong + literal — usamos textContent.
    expect(status.textContent).toMatch(/3 días/);
    expect(status.textContent).toMatch(/hola@tecnyapp\.com/);
  });

  it('paid_until = hoy → "vence hoy"', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(0), is_active: true, suspended_at: null,
    }});
    render(<ExpiredBanner />);
    expect(screen.getByRole('status').textContent).toMatch(/Tu cuenta vence\s*hoy/i);
  });

  it('paid_until = mañana → "vence mañana"', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(1), is_active: true, suspended_at: null,
    }});
    render(<ExpiredBanner />);
    expect(screen.getByRole('status').textContent).toMatch(/mañana/i);
  });

  it('dismiss oculta el banner warning', async () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(2), is_active: true, suspended_at: null,
    }});
    render(<ExpiredBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    // El botón usa aria-label descriptivo + text "Cerrar". Queremos por text.
    await userEvent.setup().click(screen.getByText('Cerrar'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ExpiredBanner — estado expirado (paid_until < hoy)', () => {
  it('paid_until ayer + is_active=false → banner rojo permanente', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(-1), is_active: false, suspended_at: null,
    }});
    render(<ExpiredBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/tu cuenta venció/i)).toBeInTheDocument();
    // No tiene botón cerrar (no dismissable).
    expect(screen.queryByRole('button', { name: /cerrar/i })).not.toBeInTheDocument();
  });

  it('incluye mailto: con asunto de renovación', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(-3), is_active: false, suspended_at: null,
    }});
    render(<ExpiredBanner />);
    const link = screen.getByRole('link', { name: /hola@tecnyapp.com/i });
    expect(link.getAttribute('href')).toMatch(/mailto:hola@tecnyapp\.com\?subject=Renovaci/);
  });
});

describe('ExpiredBanner — estado suspended', () => {
  it('suspended_at set → banner rojo "cuenta suspendida"', () => {
    mockUser = makeUser({ tenant: {
      paid_until: dateInDays(30), // paid_until OK pero suspended manualmente
      is_active: false,
      suspended_at: '2026-06-20T10:00:00Z',
    }});
    render(<ExpiredBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/suspendida/i)).toBeInTheDocument();
    expect(screen.getByText(/contactá soporte/i)).toBeInTheDocument();
  });
});
