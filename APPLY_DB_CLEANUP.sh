#!/bin/bash
set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Harmony Database Cleanup - 124 → 15 Functions          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# 1. BACKUP
echo "📦 Step 1: Creating backup..."
docker exec supabase-db pg_dump -U postgres postgres > \
  harmony_backup_$(date +%Y%m%d_%H%M%S).sql

if [ $? -eq 0 ]; then
  echo "✅ Backup created successfully"
  ls -lh harmony_backup_*.sql | tail -1
else
  echo "❌ Backup failed! Aborting."
  exit 1
fi

echo ""

# 2. DROP OLD FUNCTIONS
echo "🗑️  Step 2: Dropping unnecessary functions..."
docker cp db_schema/drop_unnecessary_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/drop_unnecessary_functions.sql

echo ""

# 3. ADD NEW FUNCTIONS
echo "➕ Step 3: Adding essential functions..."
docker cp db_schema/essential_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/essential_functions.sql

echo ""

# 4. ADD SMART ROUTING
echo "🔀 Step 4: Adding smart routing triggers..."
docker cp db_schema/triggers/smart_message_routing.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/smart_message_routing.sql

echo ""

# 5. VERIFY
echo "✅ Step 5: Verifying..."
echo "Function count:"
docker exec supabase-db psql -U postgres postgres -c \
  "SELECT COUNT(*) as total_functions FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND p.prokind = 'f';"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Database cleanup complete! ✅                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Backup saved to: harmony_backup_$(date +%Y%m%d)_*.sql"
echo ""
echo "Next: Test your app to make sure everything still works!"
