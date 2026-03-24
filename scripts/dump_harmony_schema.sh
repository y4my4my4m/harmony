#!/usr/bin/env bash
# ============================================================
# Dump Harmony-relevant schema from local Supabase dev instance
# Usage: ./scripts/dump_harmony_schema.sh [output_file]
# ============================================================
set -euo pipefail

OUTPUT="${1:-harmony_dev_dump.sql}"
CONTAINER="supabase-db"
DB_USER="postgres"
DB_NAME="postgres"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "❌ Container '${CONTAINER}' not found. Trying 'db'..."
  CONTAINER="db"
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "❌ No Supabase DB container found. Running containers:"
    docker ps --format '{{.Names}}'
    exit 1
  fi
fi

echo "📦 Using container: ${CONTAINER}"
echo "📄 Output: ${OUTPUT}"

docker exec "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -X -q --pset=tuples_only=on --pset=format=unaligned <<'EOSQL' > "${OUTPUT}"

\echo '-- ============================================================'
\echo '-- HARMONY SCHEMA DUMP'
\echo '-- Generated: ' :NOW
\echo '-- ============================================================'

\echo ''
\echo '-- ============================================================'
\echo '-- 1. PUBLIC FUNCTIONS'
\echo '-- ============================================================'

SELECT pg_get_functiondef(p.oid) || E';\n'
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
ORDER BY p.proname;

\echo ''
\echo '-- ============================================================'
\echo '-- 2. TRIGGERS ON PUBLIC TABLES'
\echo '-- ============================================================'

SELECT
  format(
    'CREATE TRIGGER %I %s %s ON public.%I FOR EACH %s EXECUTE FUNCTION %s.%s();',
    t.tgname,
    CASE WHEN (t.tgtype::int & 2) = 2 THEN 'BEFORE' ELSE 'AFTER' END,
    array_to_string(ARRAY[
      CASE WHEN (t.tgtype::int & 4) = 4 THEN 'INSERT' END,
      CASE WHEN (t.tgtype::int & 16) = 16 THEN 'UPDATE' END,
      CASE WHEN (t.tgtype::int & 8) = 8 THEN 'DELETE' END
    ]::text[], ' OR '),
    c.relname,
    CASE WHEN (t.tgtype::int & 1) = 1 THEN 'ROW' ELSE 'STATEMENT' END,
    p.pronamespace::regnamespace,
    p.proname
  )
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relnamespace = 'public'::regnamespace
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

\echo ''
\echo '-- ============================================================'
\echo '-- 3. RLS POLICIES ON PUBLIC TABLES'
\echo '-- ============================================================'

SELECT format(
  'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
  pol.polname,
  c.relname,
  CASE pol.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
  CASE pol.polcmd
    WHEN 'r' THEN 'SELECT'
    WHEN 'a' THEN 'INSERT'
    WHEN 'w' THEN 'UPDATE'
    WHEN 'd' THEN 'DELETE'
    WHEN '*' THEN 'ALL'
  END,
  array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)), ', '),
  CASE WHEN pol.polqual IS NOT NULL
    THEN ' USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')'
    ELSE '' END,
  CASE WHEN pol.polwithcheck IS NOT NULL
    THEN ' WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')'
    ELSE '' END
)
FROM pg_policy pol
JOIN pg_class c ON pol.polrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace
ORDER BY c.relname, pol.polname;

\echo ''
\echo '-- ============================================================'
\echo '-- 4. RLS STATUS PER PUBLIC TABLE'
\echo '-- ============================================================'

SELECT format(
  'ALTER TABLE public.%I %s ROW LEVEL SECURITY;',
  c.relname,
  CASE WHEN c.relrowsecurity THEN 'ENABLE' ELSE 'DISABLE' END
)
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind = 'r'
ORDER BY c.relname;

\echo ''
\echo '-- ============================================================'
\echo '-- 5. REALTIME.SEND() FUNCTION DEFINITION'
\echo '-- ============================================================'

SELECT COALESCE(
  (SELECT pg_get_functiondef(p.oid) || E';\n'
   FROM pg_proc p
   JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'realtime' AND p.proname = 'send'
   LIMIT 1),
  '-- ⚠️ realtime.send() DOES NOT EXIST!'
);

\echo ''
\echo '-- ============================================================'
\echo '-- 6. REALTIME.MESSAGES TABLE STATUS'
\echo '-- ============================================================'

SELECT COALESCE(
  (SELECT format(
    'ALTER TABLE realtime.messages %s ROW LEVEL SECURITY; -- table EXISTS',
    CASE WHEN c.relrowsecurity THEN 'ENABLE' ELSE 'DISABLE' END
  )
  FROM pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  LIMIT 1),
  '-- ⚠️ realtime.messages TABLE DOES NOT EXIST!'
);

\echo ''
\echo '-- ============================================================'
\echo '-- 7. REALTIME.MESSAGES RLS POLICIES'
\echo '-- ============================================================'

SELECT COALESCE(
  (SELECT string_agg(format(
    'CREATE POLICY %I ON realtime.messages AS %s FOR %s TO %s%s%s;',
    pol.polname,
    CASE pol.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
    CASE pol.polcmd
      WHEN 'r' THEN 'SELECT'
      WHEN 'a' THEN 'INSERT'
      WHEN 'w' THEN 'UPDATE'
      WHEN 'd' THEN 'DELETE'
      WHEN '*' THEN 'ALL'
    END,
    array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)), ', '),
    CASE WHEN pol.polqual IS NOT NULL
      THEN ' USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')'
      ELSE '' END,
    CASE WHEN pol.polwithcheck IS NOT NULL
      THEN ' WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')'
      ELSE '' END
  ), E'\n')
  FROM pg_policy pol
  JOIN pg_class c ON pol.polrelid = c.oid
  WHERE c.relnamespace = 'realtime'::regnamespace AND c.relname = 'messages'),
  '-- ⚠️ NO RLS POLICIES on realtime.messages!'
);

\echo ''
\echo '-- ============================================================'
\echo '-- 8. QUICK DIAGNOSTIC: Test realtime.send() call'
\echo '-- ============================================================'

SELECT COALESCE(
  (SELECT 'realtime.send() returned: ' || realtime.send(
    '{"type":"diagnostic:test"}'::jsonb,
    'server_event',
    'server-structure:00000000-0000-0000-0000-000000000000',
    true
  )::text),
  '-- realtime.send() call failed'
);

SELECT COALESCE(
  (SELECT 'realtime.send(private=false) returned: ' || realtime.send(
    '{"type":"diagnostic:test"}'::jsonb,
    'server_event',
    'server-structure:00000000-0000-0000-0000-000000000000',
    false
  )::text),
  '-- realtime.send(private=false) call failed'
);

\echo ''
\echo '-- ============================================================'
\echo '-- 9. BROADCAST TRIGGER FUNCTIONS (channel/category specific)'
\echo '-- ============================================================'

SELECT pg_get_functiondef(p.oid) || E';\n'
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'broadcast_channel_change',
    'broadcast_category_change',
    'broadcast_membership_event',
    'broadcast_role_change',
    'broadcast_user_role_change',
    'broadcast_thread_change',
    'broadcast_permission_override_change',
    'broadcast_server_settings_change',
    'broadcast_member_presence_change',
    'broadcast_profile_update',
    'broadcast_notification_event',
    'broadcast_unread_count_event',
    'broadcast_conversation_participant_event',
    'broadcast_user_server_event',
    'broadcast_server_change_event',
    'broadcast_mute_event',
    'broadcast_block_event'
  )
ORDER BY p.proname;

\echo ''
\echo '-- ============================================================'
\echo '-- 10. SUPABASE REALTIME VERSION INFO'
\echo '-- ============================================================'

SELECT COALESCE(
  (SELECT 'Realtime extension version: ' || extversion
   FROM pg_extension WHERE extname = 'supabase_realtime'),
  '-- supabase_realtime extension NOT installed'
);

SELECT version() AS postgres_version;

EOSQL

echo ""
echo "✅ Dump complete: ${OUTPUT}"
echo "📊 File size: $(wc -c < "${OUTPUT}") bytes, $(wc -l < "${OUTPUT}") lines"
