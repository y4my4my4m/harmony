#!/usr/bin/env bash
set -euo pipefail

OUTPUT="${1:-harmony_dev_dump.txt}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/dump_harmony_schema.sql"

# Find the supabase DB container
CONTAINER=""
for name in supabase-db supabase_db_harmony db; do
  if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
    CONTAINER="$name"
    break
  fi
done

if [ -z "$CONTAINER" ]; then
  echo "Looking for Supabase DB container..."
  CONTAINER=$(docker ps --format '{{.Names}}' | grep -i 'supabase.*db' | head -1 || true)
fi

if [ -z "$CONTAINER" ]; then
  echo "❌ No Supabase DB container found. Running containers:"
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  exit 1
fi

echo "📦 Container: ${CONTAINER}"
echo "📄 Output: ${OUTPUT}"

docker cp "${SQL_FILE}" "${CONTAINER}:/tmp/dump_harmony.sql"
docker exec "${CONTAINER}" psql -U postgres -d postgres -f /tmp/dump_harmony.sql > "${OUTPUT}" 2>&1

echo ""
echo "✅ Done! Output: ${OUTPUT}"
echo "📊 $(wc -l < "${OUTPUT}") lines"
echo ""
echo "Quick check:"
grep -E "(realtime\.send|DOES NOT EXIST|FAILED|NO RLS|messages_count|SUBSCRIBED)" "${OUTPUT}" || echo "(no quick matches)"
