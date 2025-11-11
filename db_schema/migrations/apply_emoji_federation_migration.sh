#!/bin/bash

# Script to apply emoji reaction federation migrations in correct order
# This resolves the function name conflict and applies the complete migration

set -e

echo "🗑️  Step 1: Dropping old process_incoming_emoji_reaction function..."
psql "$DATABASE_URL" -f drop_old_process_incoming_emoji_reaction.sql

echo "✨ Step 2: Applying complete emoji reaction federation migration..."
psql "$DATABASE_URL" -f emoji_reaction_federation_complete.sql

echo "🎉 Migration completed successfully!"
echo "📝 The database now has:"
echo "   - Unified emoji reaction federation functions"
echo "   - Correct process_incoming_emoji_reaction signature"
echo "   - All necessary triggers and helpers"

# Verify the new function exists with correct signature
echo "🔍 Verifying new function signature..."
psql "$DATABASE_URL" -c "
SELECT 
    p.proname as function_name,
    pg_get_function_arguments(p.oid) as arguments,
    pg_get_function_result(p.oid) as return_type
FROM pg_proc p 
JOIN pg_namespace n ON p.pronamespace = n.oid 
WHERE n.nspname = 'public' 
AND p.proname = 'process_incoming_emoji_reaction';
"
