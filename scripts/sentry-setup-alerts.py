#!/usr/bin/env python3
"""
Sentry alert rules setup — task #139 · 2026-07-16.

Crea 2 issue alert rules por cada proyecto (backend, portal frontend,
admin frontend) usando la API de Sentry:

  1. "Nuevo issue con nivel error+" — dispara la primera vez que Sentry
     agrupa un nuevo issue con level >= error. Frecuencia máx 5 min por issue.

  2. "Regresión (issue resuelto vuelve)" — dispara cuando un issue que
     estaba marcado como resolved vuelve a ocurrir. Frecuencia máx 30 min.

Ambas notifican por email al team `bruno` (único team activo — Lucas es el
único member por ahora).

Uso:
  export SENTRY_TOKEN=$(cat /tmp/.sentry_new_token)
  python3 /tmp/sentry-create-alerts.py

Idempotente: chequea si ya existe una rule con el mismo nombre antes de
crear, así podés re-correrlo sin duplicar.
"""

import json
import os
import sys
import urllib.request
import urllib.error

TOKEN = os.environ.get("SENTRY_TOKEN") or open("/tmp/.sentry_new_token").read().strip()
ORG = "bruno-iu"
TEAM_SLUG = "bruno"
TEAM_ID = "4511427679748096"

PROJECTS = [
    "tecny-portal-backend",
    "tecny-portal-frontend",
    "tecny-portal-admin",
]

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

def rule_new_issue(project_slug):
    """Rule: nuevo issue con nivel error+, notify team bruno."""
    return {
        "name": "🚨 Nuevo issue (error+)",
        # actionMatch=all: se cumplen TODOS los conditions (solo uno acá, pero
        # el schema lo pide). filterMatch=all idem para filters.
        "actionMatch": "all",
        "filterMatch": "all",
        "conditions": [
            {"id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"},
        ],
        "filters": [
            # LevelFilter: 40=error, 50=fatal. match=gte → error o fatal.
            {"id": "sentry.rules.filters.level.LevelFilter", "level": "40", "match": "gte"},
        ],
        "actions": [
            {
                "id": "sentry.mail.actions.NotifyEmailAction",
                "targetType": "Team",
                "targetIdentifier": TEAM_ID,
                "fallthroughType": "ActiveMembers",
            },
        ],
        # Frecuencia máx: 5 min por issue (evita spam si algo genera 100 events).
        "frequency": 5,
    }

def rule_regression(project_slug):
    """Rule: issue resuelto que vuelve a ocurrir, notify team bruno."""
    return {
        "name": "🔁 Regresión (issue resuelto reapareció)",
        "actionMatch": "all",
        "filterMatch": "all",
        "conditions": [
            {"id": "sentry.rules.conditions.regression_event.RegressionEventCondition"},
        ],
        "filters": [],  # Sin filtros — cualquier regresión avisa
        "actions": [
            {
                "id": "sentry.mail.actions.NotifyEmailAction",
                "targetType": "Team",
                "targetIdentifier": TEAM_ID,
                "fallthroughType": "ActiveMembers",
            },
        ],
        # Frecuencia máx: 30 min. Las regresiones son menos frecuentes que
        # nuevos issues, no hace falta throttle tan agresivo.
        "frequency": 30,
    }

def get_existing_rules(project):
    """Devuelve lista de rule names ya creadas en el project."""
    _, rules = api("GET", f"/projects/{ORG}/{project}/rules/")
    if not isinstance(rules, list):
        return []
    return [r.get("name", "") for r in rules]

def create_rule(project, rule_body):
    existing = get_existing_rules(project)
    if rule_body["name"] in existing:
        return "skip", "ya existía"
    status, resp = api("POST", f"/projects/{ORG}/{project}/rules/", rule_body)
    if status in (200, 201):
        return "created", f"id={resp.get('id')}"
    return "error", f"HTTP {status}: {resp}"

def main():
    print(f"═══════════════════════════════════════════════════════")
    print(f"  Sentry alert rules — 2 x {len(PROJECTS)} projects")
    print(f"═══════════════════════════════════════════════════════")
    print(f"  Org: {ORG}")
    print(f"  Team: {TEAM_SLUG} (id={TEAM_ID})")
    print()

    total_created = 0
    total_skipped = 0
    total_errors = 0

    for project in PROJECTS:
        print(f"▶ {project}")
        for rule_fn in (rule_new_issue, rule_regression):
            body = rule_fn(project)
            result, detail = create_rule(project, body)
            icon = {"created": "✅", "skip": "⏭️ ", "error": "❌"}[result]
            print(f"  {icon} {body['name']:50s}  {detail}")
            if result == "created": total_created += 1
            if result == "skip": total_skipped += 1
            if result == "error": total_errors += 1

    print()
    print(f"═══════════════════════════════════════════════════════")
    print(f"  Resumen: {total_created} creadas · {total_skipped} skipeadas · {total_errors} errores")
    print(f"═══════════════════════════════════════════════════════")

    if total_errors:
        sys.exit(1)

if __name__ == "__main__":
    main()
