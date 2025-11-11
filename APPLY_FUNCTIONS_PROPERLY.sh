#!/bin/bash
set -e

echo "🔧 Applying Essential Functions Properly"
echo "=========================================="

# 1. Drop ALL overloads first
echo "Step 1: Dropping all overloads of functions we're recreating..."
docker cp db_schema/drop_all_overloads_first.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/drop_all_overloads_first.sql

# 2. Create new clean functions
echo ""
echo "Step 2: Creating new essential functions..."
docker cp db_schema/essential_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/essential_functions.sql

# 3. Apply smart routing
echo ""
echo "Step 3: Applying smart routing triggers..."
docker cp db_schema/triggers/smart_message_routing.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/smart_message_routing.sql

# 4. Verify
echo ""
echo "✅ Verifying..."
docker exec supabase-db psql -U postgres postgres -c \
  "SELECT COUNT(*) as total_functions FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND p.prokind = 'f';"

echo ""
echo "✅ Done! Database functions cleaned up."
