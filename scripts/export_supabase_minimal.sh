#!/usr/bin/env bash
set -euo pipefail

# ==============================
# CONFIG
# ==============================
CONTAINER="supabase-db"   # change if your DB container has a different name
DB="postgres"
USER="postgres"
OUT_DIR="./supabase_export"
OUT_FILE="supabase_minimal.sql"

# ==============================
# SETUP
# ==============================
mkdir -p "$OUT_DIR"
TMP_APP="$OUT_DIR/_app_schema.sql"
TMP_STORAGE="$OUT_DIR/_storage.sql"
TMP_REALTIME="$OUT_DIR/_realtime.sql"
FINAL_OUT="$OUT_DIR/$OUT_FILE"

echo "==> Using container: $CONTAINER"
echo "==> Output directory: $OUT_DIR"
echo

# ==============================
# EXPORT APP SCHEMA
# ==============================
echo "==> Exporting application schema (public)..."
docker exec -t "$CONTAINER" pg_dump \
  -U "$USER" \
  -d "$DB" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  > "$TMP_APP"

# ==============================
# EXPORT STORAGE SCHEMA
# ==============================
echo "==> Exporting storage buckets + RLS..."
docker exec -t "$CONTAINER" pg_dump \
  -U "$USER" \
  -d "$DB" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=storage \
  > "$TMP_STORAGE"

# ==============================
# EXPORT REALTIME CONFIG (PUBLICATION MEMBERSHIP)
# ==============================
echo "==> Exporting realtime table configuration..."
docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" -At -c "
SELECT
  'ALTER PUBLICATION ' || p.pubname || ' ADD TABLE ' ||
  n.nspname || '.' || c.relname || ';'
FROM pg_publication p
JOIN pg_publication_rel pr ON p.oid = pr.prpubid
JOIN pg_class c ON c.oid = pr.prrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
ORDER BY p.pubname, n.nspname, c.relname;
" > "$TMP_REALTIME"

# ==============================
# CLEAN EXTENSION NOISE
# ==============================
echo "==> Removing extension noise..."
sed -i '/^CREATE EXTENSION/d' "$TMP_APP"
sed -i '/^COMMENT ON EXTENSION/d' "$TMP_APP"
sed -i '/^CREATE EXTENSION/d' "$TMP_STORAGE"
sed -i '/^COMMENT ON EXTENSION/d' "$TMP_STORAGE"

# ==============================
# COMBINE FINAL OUTPUT
# ==============================
echo "==> Combining final SQL export..."
cat "$TMP_APP" "$TMP_STORAGE" "$TMP_REALTIME" > "$FINAL_OUT"

# ==============================
# CLEANUP
# ==============================
rm -f "$TMP_APP" "$TMP_STORAGE" "$TMP_REALTIME"

echo
echo "✅ Export complete:"
echo "   $FINAL_OUT"
