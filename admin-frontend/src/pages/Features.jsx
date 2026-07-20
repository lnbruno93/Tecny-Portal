// Pantalla Features — CMS de feature flags per-tenant (F2 Rec proactiva #3,
// 2026-07-20). Design doc: docs/design/feature-flags-per-tenant.md.
//
// Cada flag tiene:
//   · Toggle GLOBAL (feature_flags.enabled)
//   · Rollout %  (feature_flags.rollout_pct) — 0..100 o null
//   · Overrides por TENANT (feature_flags_tenants) — el más específico gana
//   · Overrides por PLAN   (feature_flags_plans)
//
// Precedencia del resolver (backend `lib/featureFlags.js`):
//   tenant > plan > rollout > global > fail-closed (false)
//
// UX: lista de flags con:
//   · Header con nombre + toggle global + rollout% + description
//   · Sub-secciones: "Overrides por tenant" (con "+ Agregar") y
//     "Overrides por plan"
//   · Cambios se guardan inmediatamente al toggle/blur (sin botón Save)
//     — al ser super-admin, la confirmación implícita es aceptable. Los
//     kill switches deben ser 1-click.
//
// Backend: adminApi.features.* → /api/super-admin/features/*

import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, PageHead, Badge } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import { fmtDateTime } from '../lib/format.js';

const PLANES = ['trial', 'starter', 'pro', 'enterprise'];

export default function Features() {
  const [flags, setFlags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(null); // debounce visual: qué campo está guardando

  // ── Load ─────────────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminApi.features.list();
      setFlags(r.flags || []);
    } catch (e) {
      setError(e.message || 'Error al cargar feature flags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // ── Helper: toggle enabled global ────────────────────────────────────
  async function handleGlobalToggle(name, currentEnabled) {
    setSavingKey(`${name}:global`);
    try {
      await adminApi.features.updateFlag(name, { enabled: !currentEnabled });
      await reload();
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo actualizar'));
    } finally {
      setSavingKey(null);
    }
  }

  // ── Helper: cambiar rollout_pct ──────────────────────────────────────
  async function handleRolloutChange(name, valueStr) {
    // valueStr = '' (vacío = null = sin rollout) o número 0..100
    const value = valueStr.trim() === '' ? null : Number(valueStr);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
      alert('Rollout debe ser un entero entre 0 y 100 (o vacío para desactivar)');
      return;
    }
    setSavingKey(`${name}:rollout`);
    try {
      await adminApi.features.updateFlag(name, { rollout_pct: value });
      await reload();
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo actualizar'));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="page">
      <PageHead
        label="Feature Flags"
        title="Overrides por tenant y plan"
        subtitle="Global / plan / tenant. El más específico gana. Ver docs/design/feature-flags-per-tenant.md."
        actions={
          <Btn kind="ghost" icon="refresh" onClick={reload} disabled={loading}>
            Refrescar
          </Btn>
        }
      />

      {error && (
        <Card><div className="alert alert-error">{error}</div></Card>
      )}

      {loading && !flags.length && (
        <Card><div className="muted">Cargando flags…</div></Card>
      )}

      {!loading && flags.length === 0 && !error && (
        <Card>
          <div className="empty-state">
            <div className="empty-title">No hay feature flags creados</div>
            <div className="muted">
              Los flags se crean desde el endpoint `POST /api/feature-flags`
              (sistema legacy). Esta pantalla los muestra + gestiona overrides
              per-tenant y per-plan sobre los ya existentes.
            </div>
          </div>
        </Card>
      )}

      {flags.map((flag) => (
        <FlagCard
          key={flag.name}
          flag={flag}
          savingKey={savingKey}
          onGlobalToggle={handleGlobalToggle}
          onRolloutChange={handleRolloutChange}
          onReload={reload}
        />
      ))}
    </div>
  );
}

// ─── FlagCard ───────────────────────────────────────────────────────────

function FlagCard({ flag, savingKey, onGlobalToggle, onRolloutChange, onReload }) {
  const [rolloutInput, setRolloutInput] = useState(
    flag.rollout_pct == null ? '' : String(flag.rollout_pct)
  );
  const [addingTenantId, setAddingTenantId] = useState('');
  const [addingTenantEnabled, setAddingTenantEnabled] = useState(true);
  const [addingTenantReason, setAddingTenantReason] = useState('');
  const [addingPlan, setAddingPlan] = useState('');
  const [addingPlanEnabled, setAddingPlanEnabled] = useState(true);

  const globalSaving = savingKey === `${flag.name}:global`;
  const rolloutSaving = savingKey === `${flag.name}:rollout`;

  async function addTenantOverride() {
    const tenantId = Number(addingTenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      alert('Tenant ID debe ser un entero > 0');
      return;
    }
    try {
      await adminApi.features.upsertTenantOverride(flag.name, tenantId, {
        enabled: addingTenantEnabled,
        reason: addingTenantReason.trim() || null,
      });
      setAddingTenantId('');
      setAddingTenantReason('');
      setAddingTenantEnabled(true);
      await onReload();
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo agregar'));
    }
  }

  async function removeTenantOverride(tenantId) {
    if (!confirm(`¿Quitar override del tenant ${tenantId}? El resolver vuelve a evaluar plan → rollout → global.`)) return;
    try {
      await adminApi.features.removeTenantOverride(flag.name, tenantId);
      await onReload();
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo quitar'));
    }
  }

  async function addPlanOverride() {
    if (!PLANES.includes(addingPlan)) {
      alert(`Plan debe ser uno de: ${PLANES.join(', ')}`);
      return;
    }
    try {
      await adminApi.features.upsertPlanOverride(flag.name, addingPlan, {
        enabled: addingPlanEnabled,
      });
      setAddingPlan('');
      setAddingPlanEnabled(true);
      await onReload();
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo agregar'));
    }
  }

  async function removePlanOverride(planId) {
    if (!confirm(`¿Quitar override del plan ${planId}?`)) return;
    try {
      await adminApi.features.removePlanOverride(flag.name, planId);
      await onReload();
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo quitar'));
    }
  }

  return (
    <Card>
      <div className="feature-flag-card">
        <div className="feature-flag-header">
          <div>
            <div className="feature-flag-name">
              <code>{flag.name}</code>
              {flag.rollout_pct != null && (
                <Badge tone="info">rollout {flag.rollout_pct}%</Badge>
              )}
              {flag.tenant_overrides.length > 0 && (
                <Badge tone="warn">{flag.tenant_overrides.length} tenant override(s)</Badge>
              )}
              {flag.plan_overrides.length > 0 && (
                <Badge tone="warn">{flag.plan_overrides.length} plan override(s)</Badge>
              )}
            </div>
            {flag.description && (
              <div className="muted feature-flag-desc">{flag.description}</div>
            )}
          </div>

          <div className="feature-flag-controls">
            <label className="feature-flag-toggle">
              <input
                type="checkbox"
                checked={flag.enabled}
                disabled={globalSaving}
                onChange={() => onGlobalToggle(flag.name, flag.enabled)}
              />
              <span>Global {flag.enabled ? 'ON' : 'OFF'}</span>
            </label>

            <label className="feature-flag-rollout">
              Rollout %:
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                placeholder="—"
                value={rolloutInput}
                disabled={rolloutSaving}
                onChange={(e) => setRolloutInput(e.target.value)}
                onBlur={() => {
                  if (rolloutInput !== (flag.rollout_pct == null ? '' : String(flag.rollout_pct))) {
                    onRolloutChange(flag.name, rolloutInput);
                  }
                }}
              />
            </label>
          </div>
        </div>

        {/* Overrides por TENANT */}
        <div className="feature-flag-section">
          <div className="feature-flag-section-title">
            Overrides por tenant ({flag.tenant_overrides.length})
          </div>
          {flag.tenant_overrides.length === 0 && (
            <div className="muted">Sin overrides. Todos los tenants usan plan/rollout/global.</div>
          )}
          {flag.tenant_overrides.map((ov) => (
            <div key={ov.tenant_id} className="feature-flag-override-row">
              <span>
                <strong>{ov.tenant_nombre}</strong> <code>id={ov.tenant_id}</code>
              </span>
              <Badge tone={ov.enabled ? 'success' : 'danger'}>
                {ov.enabled ? 'ON' : 'OFF'}
              </Badge>
              {ov.reason && <span className="muted">— {ov.reason}</span>}
              <span className="muted feature-flag-meta">
                {fmtDateTime(ov.updated_at)}
              </span>
              <Btn
                kind="ghost"
                sm
                icon="trash"
                iconOnly
                onClick={() => removeTenantOverride(ov.tenant_id)}
                aria-label={`Quitar override del tenant ${ov.tenant_id}`}
              />
            </div>
          ))}
          {/* Add tenant override */}
          <div className="feature-flag-add-row">
            <input
              type="number"
              placeholder="Tenant ID"
              value={addingTenantId}
              onChange={(e) => setAddingTenantId(e.target.value)}
              style={{ width: 100 }}
            />
            <select
              value={addingTenantEnabled ? '1' : '0'}
              onChange={(e) => setAddingTenantEnabled(e.target.value === '1')}
            >
              <option value="1">ON</option>
              <option value="0">OFF</option>
            </select>
            <input
              type="text"
              placeholder="Razón (opcional — canary, kill switch, etc.)"
              value={addingTenantReason}
              onChange={(e) => setAddingTenantReason(e.target.value)}
              maxLength={200}
              className="u-flex-1"
            />
            <Btn kind="primary" sm icon="plus" onClick={addTenantOverride}>
              Agregar
            </Btn>
          </div>
        </div>

        {/* Overrides por PLAN */}
        <div className="feature-flag-section">
          <div className="feature-flag-section-title">
            Overrides por plan ({flag.plan_overrides.length})
          </div>
          {flag.plan_overrides.length === 0 && (
            <div className="muted">Sin overrides por plan.</div>
          )}
          {flag.plan_overrides.map((ov) => (
            <div key={ov.plan_id} className="feature-flag-override-row">
              <span><strong>{ov.plan_id}</strong></span>
              <Badge tone={ov.enabled ? 'success' : 'danger'}>
                {ov.enabled ? 'ON' : 'OFF'}
              </Badge>
              <span className="muted feature-flag-meta">
                {fmtDateTime(ov.updated_at)}
              </span>
              <Btn
                kind="ghost"
                sm
                icon="trash"
                iconOnly
                onClick={() => removePlanOverride(ov.plan_id)}
                aria-label={`Quitar override del plan ${ov.plan_id}`}
              />
            </div>
          ))}
          {/* Add plan override */}
          <div className="feature-flag-add-row">
            <select value={addingPlan} onChange={(e) => setAddingPlan(e.target.value)}>
              <option value="">Elegir plan…</option>
              {PLANES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              value={addingPlanEnabled ? '1' : '0'}
              onChange={(e) => setAddingPlanEnabled(e.target.value === '1')}
            >
              <option value="1">ON</option>
              <option value="0">OFF</option>
            </select>
            <Btn kind="primary" sm icon="plus" onClick={addPlanOverride}>
              Agregar
            </Btn>
          </div>
        </div>
      </div>
    </Card>
  );
}
