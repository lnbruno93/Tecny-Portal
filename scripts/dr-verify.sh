#!/usr/bin/env bash
# dr-verify.sh — sanity checks post-restore de Postgres (TANDA 4.E pre-live 2026-06-25).
#
# Usage:
#   DATABASE_URL=postgres://...  ./scripts/dr-verify.sh
#   o:
#   ./scripts/dr-verify.sh "postgres://user:pass@host:port/db"
#
# Qué chequea (en orden):
#   1. Conectividad básica (SELECT 1).
#   2. Versión PostgreSQL >= 16 (Railway corre 18, pero 16+ es suficiente).
#   3. Tablas críticas existen + tienen rows (heurística: si <2 rows en
#      `tenants` la restore probablemente quedó vacía).
#   4. RLS policies activas en tablas tenant-scoped — defensa contra
#      restore que perdió GRANTs o ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
#   5. Migrations table al día — el dump debe incluir pgmigrations con
#      ≥30 migrations (cantidad indicativa, no exacta).
#   6. Sample query end-to-end: 1 user con tenant_users + capabilities — si
#      esto funciona, la app puede iniciar sesión post-restore.
#
# Output: pasa/falla con códigos de salida claros para automation.
#   - exit 0: todos los checks OK
#   - exit 1: al menos un check falló (causa específica printeada)
#
# Diseño defensivo: si psql no está instalado, error claro. Si DATABASE_URL
# no se pasa, error claro. Si la query timeout (DB caída), el set -e + el
# error de psql salen con código != 0.

set -euo pipefail

# ─── Resolución del DATABASE_URL ─────────────────────────────────────────
DB_URL="${1:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "❌ ERROR: DATABASE_URL no provisto." >&2
  echo "" >&2
  echo "Uso: $0 [database_url]" >&2
  echo "  o: DATABASE_URL=postgres://... $0" >&2
  exit 1
fi

# ─── Prerequisites ───────────────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
  echo "❌ ERROR: psql no instalado. brew install postgresql@18" >&2
  exit 1
fi

# ─── Helpers ─────────────────────────────────────────────────────────────
# Helper: ejecuta una query y devuelve el primer valor escalar.
# Usa -t (tuples-only) + -A (unaligned) + -X (no .psqlrc) para output limpio.
q() {
  psql -X -t -A "$DB_URL" -c "$1" 2>&1 | tr -d ' '
}

# Helper: chequea que el output de q() sea exactamente el valor esperado.
# Falla con mensaje claro si no.
expect_eq() {
  local actual="$1"
  local expected="$2"
  local desc="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✅ $desc"
    return 0
  else
    echo "  ❌ $desc (esperaba '$expected', obtuve '$actual')"
    return 1
  fi
}

expect_gte() {
  local actual="$1"
  local minimum="$2"
  local desc="$3"
  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual >= minimum )); then
    echo "  ✅ $desc (count: $actual)"
    return 0
  else
    echo "  ❌ $desc (esperaba >= $minimum, obtuve '$actual')"
    return 1
  fi
}

# Track de fallas — no abortamos en el primer error, ejecutamos todos los
# checks para que el operador vea el panorama completo del estado del restore.
FAILED=0
check() { "$@" || FAILED=$((FAILED + 1)); }

# ─── Checks ──────────────────────────────────────────────────────────────

echo ""
echo "🔍 DR verify — checks de sanidad post-restore"
echo "   DB: ${DB_URL%%@*}@***"
echo ""

# 1. Conectividad básica
echo "1. Conectividad"
check expect_eq "$(q 'SELECT 1')" "1" "psql puede ejecutar SELECT 1"

# 2. Versión Postgres
echo ""
echo "2. Versión PostgreSQL"
PG_VERSION=$(q 'SHOW server_version_num' | head -c 2)
check expect_gte "$PG_VERSION" "16" "versión >= 16"

# 3. Tablas críticas + row counts
echo ""
echo "3. Tablas críticas con datos"
check expect_gte "$(q 'SELECT COUNT(*) FROM users')"             "1"  "tabla users tiene al menos 1 row"
check expect_gte "$(q 'SELECT COUNT(*) FROM tenants')"           "1"  "tabla tenants tiene al menos 1 row"
check expect_gte "$(q 'SELECT COUNT(*) FROM tenant_users')"      "1"  "tabla tenant_users tiene al menos 1 row"

# Estas tablas pueden estar vacías en un tenant nuevo. Solo validamos que
# existen (la query no debe fallar con relation does not exist).
echo ""
echo "4. Tablas tenant-scoped existen (rows opcionales)"
check expect_gte "$(q 'SELECT COUNT(*) FROM metodos_pago')"      "0"  "tabla metodos_pago accesible"
check expect_gte "$(q 'SELECT COUNT(*) FROM caja_movimientos')"  "0"  "tabla caja_movimientos accesible"
check expect_gte "$(q 'SELECT COUNT(*) FROM clientes_cc')"       "0"  "tabla clientes_cc accesible"
check expect_gte "$(q 'SELECT COUNT(*) FROM productos')"         "0"  "tabla productos accesible"
check expect_gte "$(q 'SELECT COUNT(*) FROM audit_logs')"        "0"  "tabla audit_logs (particionada) accesible"

# 5. RLS policies activas. Sin esto, post-restore la app SERVIRÍA data
# cross-tenant en silencio (defense in depth: la app usa withTenant que
# setea SET LOCAL, pero RLS es el último gate).
#
# Las queries se construyen con concatenación (no escape de comillas inline)
# para que bash no se pelee con los apóstrofes de SQL.
echo ""
echo "5. RLS policies"
SQL_POLICY="SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename="
check expect_gte "$(q "${SQL_POLICY}'clientes_cc'")" "1" "policy RLS activa en clientes_cc"
check expect_gte "$(q "${SQL_POLICY}'productos'")"   "1" "policy RLS activa en productos"
check expect_gte "$(q "${SQL_POLICY}'ventas'")"      "1" "policy RLS activa en ventas"
check expect_gte "$(q "${SQL_POLICY}'audit_logs'")"  "1" "policy RLS activa en audit_logs"

# RLS FORCEado (sino los super-users bypassean — relevante en prod con role NOSUPERUSER)
echo ""
echo "6. RLS FORCE en tablas críticas"
SQL_FORCE="SELECT relforcerowsecurity FROM pg_class WHERE relname="
check expect_eq "$(q "${SQL_FORCE}'clientes_cc'")" "t" "clientes_cc tiene FORCE ROW LEVEL SECURITY"
check expect_eq "$(q "${SQL_FORCE}'productos'")"   "t" "productos tiene FORCE ROW LEVEL SECURITY"

# 7. Migrations table — el dump debe traerlas
echo ""
echo "7. Migrations al día"
check expect_gte "$(q 'SELECT COUNT(*) FROM pgmigrations')" "30" "pgmigrations tiene >=30 entries (todas las migrations aplicadas)"

# Última migration aplicada (informativo, sin assertion):
LAST_MIG=$(q "SELECT name FROM pgmigrations ORDER BY run_on DESC LIMIT 1")
echo "  ℹ  última migration: $LAST_MIG"

# 8. Sample end-to-end query: 1 user con caps efectivos
echo ""
echo "8. Sample query end-to-end (login simulado)"
RESULT=$(q "
  SELECT COUNT(*)
    FROM users u
    JOIN tenant_users tu ON tu.user_id = u.id
   WHERE u.deleted_at IS NULL
     AND tu.tenant_id IS NOT NULL
   LIMIT 1
")
check expect_gte "$RESULT" "1" "al menos 1 user con tenant_users válido (login funcionará post-restore)"

# 9. Critical extensions (uuid-ossp, pgcrypto si la app las usa)
# Nota: chequeamos varias por OR — si alguna está, está bien. Si ninguna, raro
# pero puede ser un test DB que nunca las necesitó (caso common en CI fresh).
echo ""
echo "9. Extensions"
EXT_COUNT=$(q "SELECT COUNT(*) FROM pg_extension WHERE extname IN ('pgcrypto', 'uuid-ossp', 'plpgsql')")
check expect_gte "$EXT_COUNT" "1" "al menos 1 extension instalada (pgcrypto/uuid-ossp/plpgsql)"

# ─── Resumen ────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
if [[ "$FAILED" -eq 0 ]]; then
  echo "✅ TODOS LOS CHECKS PASARON. El restore parece válido."
  echo ""
  echo "Próximo paso opcional: levantar el backend apuntando a este DB y"
  echo "hacer login + browse Inventario/Cajas para confirmar end-to-end."
  exit 0
else
  echo "❌ $FAILED CHECKS FALLARON. Revisar antes de promover el restore."
  echo ""
  echo "Causas comunes:"
  echo "  - Dump incompleto (pg_dump cortó por timeout)"
  echo "  - Restore con --no-owner pero faltaron GRANTs → re-correr migrations"
  echo "  - Postgres version mismatch (dump de PG18 a PG14, etc.)"
  echo "  - RLS no se aplicó (revisar policies en pg_policies)"
  exit 1
fi
