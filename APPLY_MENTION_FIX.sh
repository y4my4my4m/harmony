#!/bin/bash

# Apply mention isLocal detection fix
# This fixes the convert_ap_to_jsonb function to correctly determine if a mention is local
# by comparing the domain with the current instance domain

echo "📝 Applying mention isLocal detection fix..."

# Check if Supabase connection details are available
if [ -z "$SUPABASE_DB_URL" ]; then
  echo "⚠️  SUPABASE_DB_URL not set. Please set it first:"
  echo "   export SUPABASE_DB_URL='postgresql://postgres:[YOUR-PASSWORD]@[YOUR-PROJECT-REF].supabase.co:5432/postgres'"
  exit 1
fi

# Apply the migration
echo "🔧 Updating convert_ap_to_jsonb function..."
psql "$SUPABASE_DB_URL" -f db_schema/migrations/fix_mention_islocal_detection.sql

if [ $? -eq 0 ]; then
  echo "✅ Migration applied successfully!"
  echo ""
  echo "📋 What was fixed:"
  echo "  - convert_ap_to_jsonb now correctly determines if a mention is local"
  echo "  - Compares mention domain with current instance domain (har.mony.lol)"
  echo "  - Local users show as @username"
  echo "  - Remote users show as @username@domain"
  echo ""
  echo "🔄 You may need to refresh your browser to see the changes"
else
  echo "❌ Migration failed. Please check the error messages above."
  exit 1
fi

