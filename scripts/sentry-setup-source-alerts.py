#!/usr/bin/env python3
"""
Sentry alert rules — source-based filters · 2026-07-27 (follow-up audit 07-25).

Crea 3 alert rules específicas basadas en el `source` tag que agregamos en
Sprint 3 (`resolveUserTenant`) + Sprint 3 (`migrate-timed`) + Sprint 4 hotfix
(`pricing_schema_drift`). Cada una filtra por source específico + level.

Rules:

  1. "🔔 resolveUserTenant multi-tenant" — se dispara cuando el WARN log
     del Sprint 3 Fix 1 aparece en Sentry. Signal: users con >1 tenant
     (candidatos a multi-tenant per user long-term refactor).
     Frecuencia máx: 1 hora.

  2. "🚨 migrate-timed deploy en riesgo" — se dispara cuando el wrapper
     del Sprint 3 Fix 6 emite Sentry con level=error (migrate > 240s =
     80% del healthcheckTimeout, deploy inminente a fallar).
     Frecuencia máx: 5 min (queremos verlo YA).

  3. "⚠️  pricing_schema_drift" — se dispara cuando el frontend
     useLandingPricing detecta un shape inesperado en el response del
     backend (Sprint 4 Fix 6 refinado por hotfix post-Sprint 4).
     Frecuencia máx: 30 min (debug pero no crítico).

Uso:
  export SENTRY_TOKEN=<tu token con project:write>
  python3 scripts/sentry-setup-source-alerts.py

Idempotente: chequea si ya existe una rule con el mismo nombre antes de
crear, así podés re-correrlo sin duplicar.

Referencia del script principal: scripts/sentry-setup-alerts.py (task #139).
"""

import json
import os
import sys
import urllib.request
import urllib.error

TOKEN = os.environ.get("SENTRY_TOKEN")
if not TOKEN:
    print("ERROR: SENTRY_TOKEN no está seteado. Export con `export SENTRY_TOKEN=<token>`.")
    sys.exit(1)

ORG = "bruno-iu"
TEAM_SLUG = "bruno"
TEAM_ID = "4511427679748096"

# Cada rule vive en su proyecto correspondiente. Las 2 source-based del
# backend (resolveUserTenant + migrate-timed) van al backend project. La
# pricing_schema_drift viene del frontend (Landing.hooks.js).
BACKEND_PROJECT = "tecny-portal-backend"
FRONTEND_PROJECT = "tecny-portal-frontend"


def api(method, path, body=None):
    url = f"https://sentry.io/api/0{path}"
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body else None,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")


def notify_email_action():
    return {
        "id": "sentry.mail.actions.NotifyEmailAction",
        "targetType": "Team",
        "targetIdentifier": TEAM_ID,
        "fallthroughType": "ActiveMembers",
    }


def tag_filter(key, value, match="eq"):
    """Filter por tag exacto. match=eq → tag[key] == value."""
    return {
        "id": "sentry.rules.filters.tagged_event.TaggedEventFilter",
        "key": key,
        "match": match,
        "value": value,
    }


def event_frequency_condition(interval="1h", value=0):
    """Trigger la primera vez que aparece un evento con esos tags.

    interval sirve como debounce — se dispara si hay >= value eventos en
    ese lapso. value=0 significa "al menos 1" (primera aparición).
    """
    return {
        "id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
        "interval": interval,
        "value": str(value),
    }


def rule_resolve_user_tenant_ambiguity():
    """Rule: user con >1 tenant detectado.

    Filtra por tag source == 'resolveUserTenant_multi_tenant_ambiguity'
    (setado en backend/src/lib/userTenant.js:53).
    """
    return {
        "name": "🔔 resolveUserTenant multi-tenant ambiguity",
        "actionMatch": "all",
        "filterMatch": "all",
        "conditions": [
            {"id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"},
        ],
        "filters": [
            tag_filter("source", "resolveUserTenant_multi_tenant_ambiguity"),
        ],
        "actions": [notify_email_action()],
        "frequency": 60,  # min entre notifs para el mismo issue
    }


def rule_migrate_timed_deploy_risk():
    """Rule: migrate demoró > 240s (Sprint 3 Fix 6, level=error).

    Filtra por tag source == 'migrate-timed' + level=error.
    """
    return {
        "name": "🚨 migrate-timed deploy en riesgo (>= 240s)",
        "actionMatch": "all",
        "filterMatch": "all",
        "conditions": [
            {"id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"},
        ],
        "filters": [
            tag_filter("source", "migrate-timed"),
            # Level 40=error, 50=fatal. gte → error o fatal (skippea warning).
            {
                "id": "sentry.rules.filters.level.LevelFilter",
                "level": "40",
                "match": "gte",
            },
        ],
        "actions": [notify_email_action()],
        "frequency": 5,
    }


def rule_pricing_schema_drift():
    """Rule: useLandingPricing detectó shape raro del backend.

    Filtra por tag section == 'pricing_schema_drift' (frontend Sentry).
    """
    return {
        "name": "⚠️  pricing_schema_drift (frontend detectó shape raro)",
        "actionMatch": "all",
        "filterMatch": "all",
        "conditions": [
            {"id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"},
        ],
        "filters": [
            tag_filter("section", "pricing_schema_drift"),
        ],
        "actions": [notify_email_action()],
        "frequency": 30,
    }


def ensure_rule(project_slug, rule):
    """Crea la rule si no existe con el mismo name en ese proyecto."""
    status, existing = api("GET", f"/projects/{ORG}/{project_slug}/rules/")
    if status != 200:
        print(f"  ERROR listando rules de {project_slug}: HTTP {status}")
        return

    matching = [r for r in existing if r.get("name") == rule["name"]]
    if matching:
        print(f"  ✓ Ya existe rule '{rule['name']}' (id={matching[0]['id']}). Skip.")
        return

    status, created = api("POST", f"/projects/{ORG}/{project_slug}/rules/", rule)
    if status in (200, 201):
        print(f"  ✓ Creada rule '{rule['name']}' (id={created.get('id')}) en {project_slug}")
    else:
        print(f"  ✗ Error creando '{rule['name']}': HTTP {status} — {created}")


def main():
    print(f"Sentry source alerts setup — org={ORG}, team={TEAM_SLUG}")
    print()

    print(f"Proyecto: {BACKEND_PROJECT}")
    ensure_rule(BACKEND_PROJECT, rule_resolve_user_tenant_ambiguity())
    ensure_rule(BACKEND_PROJECT, rule_migrate_timed_deploy_risk())

    print()
    print(f"Proyecto: {FRONTEND_PROJECT}")
    ensure_rule(FRONTEND_PROJECT, rule_pricing_schema_drift())

    print()
    print("Done. Ver reglas en:")
    print(f"  https://bruno-iu.sentry.io/alerts/rules/")


if __name__ == "__main__":
    main()
