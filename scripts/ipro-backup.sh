#!/bin/bash
#
# ipro-backup.sh — dump de la DB de producción a Backblaze B2.
#
# Pieza del Disaster Recovery offsite (ver docs/DISASTER_RECOVERY.md).
# Corre en la Mac del operador (Lucas), no en el servidor:
#   1. pg_dump via Railway TCP Proxy (conexión pública a Postgres-AueP).
#   2. b2-tools sube el dump al bucket de Backblaze.
#   3. /tmp se limpia al terminar (trap EXIT).
#
# Idempotente: el filename incluye fecha+hora hasta el minuto, así que dos
# corridas el mismo día no se pisan.
#
# Setup (una sola vez por máquina):
#   1. brew install postgresql@18 b2-tools
#   2. Habilitar TCP Proxy en Railway → Postgres-AueP → Settings → Networking
#   3. Crear Application Key en Backblaze con bucket-scoped access
#   4. Copiar este script a ~/bin/ (en el PATH):
#        cp scripts/ipro-backup.sh ~/bin/ipro-backup.sh && chmod +x ~/bin/ipro-backup.sh
#   5. Crear ~/.ipro-backup.env (NO commit) con las 4 variables del check de abajo
#   6. chmod 600 ~/.ipro-backup.env
#   7. Cron diario en crontab (todos los días, 9 AM):
#        0 9 * * * /Users/<vos>/bin/ipro-backup.sh >> /Users/<vos>/.ipro-backup.log 2>&1
#      (Historial: era mensual `0 9 1 * *` hasta 2026-06-25. Cambiado a diario
#       después del rehearsal — ver docs/DISASTER_RECOVERY.md §5.)
#
# Si algo falla (versión de pg_dump < server, network, credenciales), el script
# aborta con error legible (set -e) y NO sube backup roto a Backblaze.

set -euo pipefail

# ── 1) Cargar credenciales desde ~/.ipro-backup.env ────────────────────────
# Este archivo NO se versiona — vive en el home del operador (chmod 600).
# Contiene:
#   DATABASE_PUBLIC_URL="postgresql://USER:PASS@HOST:PORT/DB"   (TCP Proxy Railway)
#   B2_KEY_ID="..."                                              (Backblaze Application Key)
#   B2_APP_KEY="..."                                             (Backblaze Application Key value)
#   B2_BUCKET="ipro-backups-prod"                                (bucket privado, encriptado)
if [ ! -f ~/.ipro-backup.env ]; then
  echo "❌ Falta ~/.ipro-backup.env"
  echo "   Crealo siguiendo docs/DISASTER_RECOVERY.md §Setup local."
  exit 1
fi
source ~/.ipro-backup.env

for var in DATABASE_PUBLIC_URL B2_KEY_ID B2_APP_KEY B2_BUCKET; do
  if [ -z "${!var:-}" ]; then
    echo "❌ Falta $var en ~/.ipro-backup.env"
    exit 1
  fi
done

# ── 2) Dump comprimido (-Fc = custom format, restaurable con pg_restore) ──
DATE=$(date +%Y-%m-%d_%H%M)
FILE="ipro_${DATE}.dump"
TMP="/tmp/$FILE"
trap "rm -f '$TMP'" EXIT

echo "▶ Dump de la DB → $TMP"
# --no-owner: el dump no preserva el role del owner (Railway lo recrea con
# permisos limpios al restaurar). Esto evita errores de "role no existe"
# si se restaura en otro server.
pg_dump "$DATABASE_PUBLIC_URL" -Fc --no-owner -f "$TMP"

SIZE_MB=$(du -m "$TMP" | cut -f1)
echo "  ✓ Dump: ${SIZE_MB}MB"

# ── 3) Upload a Backblaze B2 ──────────────────────────────────────────────
echo "▶ Autenticando con Backblaze B2"
b2 account authorize "$B2_KEY_ID" "$B2_APP_KEY" > /dev/null

echo "▶ Subiendo a B2://$B2_BUCKET/$FILE"
b2 file upload "$B2_BUCKET" "$TMP" "$FILE" > /dev/null

echo "✅ Backup completado: $FILE (${SIZE_MB}MB) en bucket $B2_BUCKET"
