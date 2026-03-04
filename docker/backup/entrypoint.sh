#!/bin/sh
set -e

BACKUP_DIR="/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-mcp_memory}"

mkdir -p "$BACKUP_DIR"

run_backup() {
  TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
  FILENAME="memories_${TIMESTAMP}.dump"
  FILEPATH="${BACKUP_DIR}/${FILENAME}"

  echo "[$(date -Iseconds)] Starting backup: ${FILENAME}"

  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --format=custom \
    --compress=9 \
    --file="$FILEPATH"

  echo "[$(date -Iseconds)] Backup complete: ${FILEPATH} ($(du -sh "$FILEPATH" | cut -f1))"

  # Remove backups older than retention period
  find "$BACKUP_DIR" -name "memories_*.dump" -mtime "+${RETENTION_DAYS}" -delete
  REMOVED=$(find "$BACKUP_DIR" -name "memories_*.dump" -mtime "+${RETENTION_DAYS}" | wc -l)
  echo "[$(date -Iseconds)] Retention cleanup done (>${RETENTION_DAYS} days removed: ${REMOVED} files)"
}

# Wait for postgres to be ready
echo "[$(date -Iseconds)] Waiting for PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}..."
until PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -q; do
  sleep 5
done
echo "[$(date -Iseconds)] PostgreSQL is ready."

# Run immediately on startup
run_backup

# Then run daily via cron
echo "0 2 * * * /entrypoint.sh" > /etc/crontabs/root
crond -f
