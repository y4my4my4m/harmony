-- ============================================================
-- HARMONY SCHEMA DIAGNOSTIC DUMP
-- ============================================================

\echo '-- ========================================'
\echo '-- SECTION 5: realtime.send() FUNCTION'
\echo '-- ========================================'

SELECT COALESCE(
  (SELECT pg_get_functiondef(p.oid) || ';'
   FROM pg_proc p
   JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'realtime' AND p.proname = 'send'
   LIMIT 1),
  '-- !! realtime.send() DOES NOT EXIST !!'
);

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 6: realtime.messages TABLE'
\echo '-- ========================================'

SELECT COALESCE(
  (SELECT 'realtime.messages EXISTS, RLS=' || c.relrowsecurity::text
   FROM pg_class c
   JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE n.nspname = 'realtime' AND c.relname = 'messages'
   LIMIT 1),
  '-- !! realtime.messages TABLE DOES NOT EXIST !!'
);

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 7: realtime.messages RLS POLICIES'
\echo '-- ========================================'

SELECT COALESCE(
  (SELECT string_agg(
    format('POLICY %I: %s FOR %s TO %s',
      pol.polname,
      CASE pol.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END,
      array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)), ', ')
    ), E'\n')
   FROM pg_policy pol
   JOIN pg_class c ON pol.polrelid = c.oid
   WHERE c.relnamespace = 'realtime'::regnamespace AND c.relname = 'messages'),
  '-- !! NO RLS POLICIES on realtime.messages !!'
);

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 8: TEST realtime.send()'
\echo '-- ========================================'

DO $$
BEGIN
  PERFORM realtime.send(
    '{"type":"diagnostic:ping"}'::jsonb,
    'server_event',
    'server-structure:00000000-0000-0000-0000-000000000000',
    true
  );
  RAISE NOTICE 'realtime.send(private=true) succeeded';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'realtime.send(private=true) FAILED: %', SQLERRM;
END;
$$;

DO $$
BEGIN
  PERFORM realtime.send(
    '{"type":"diagnostic:ping"}'::jsonb,
    'server_event',
    'server-structure:00000000-0000-0000-0000-000000000000',
    false
  );
  RAISE NOTICE 'realtime.send(private=false) succeeded';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'realtime.send(private=false) FAILED: %', SQLERRM;
END;
$$;

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 9: CHECK realtime.messages CONTENT'
\echo '-- (are messages actually being inserted?)'
\echo '-- ========================================'

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    RAISE NOTICE 'Checking realtime.messages row count...';
  ELSE
    RAISE NOTICE 'realtime.messages table does not exist - send() may use pg_notify instead';
  END IF;
END;
$$;

SELECT count(*) AS messages_count FROM realtime.messages;

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 10: BROADCAST TRIGGER FUNCTIONS'
\echo '-- ========================================'

SELECT pg_get_functiondef(p.oid) || E';\n'
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname LIKE 'broadcast_%'
ORDER BY p.proname;

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 11: TRIGGERS ON channels + channel_categories'
\echo '-- ========================================'

SELECT format('%s trigger %I on %I: %s',
  CASE WHEN (t.tgtype::int & 2) = 2 THEN 'BEFORE' ELSE 'AFTER' END,
  t.tgname,
  c.relname,
  p.pronamespace::regnamespace || '.' || p.proname || '()'
)
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('channels', 'channel_categories')
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 12: SUPABASE VERSION INFO'
\echo '-- ========================================'

SELECT extname, extversion FROM pg_extension WHERE extname IN ('supabase_realtime', 'pgjwt', 'pg_net') ORDER BY extname;
SELECT version() AS pg_version;

\echo ''
\echo '-- ========================================'
\echo '-- SECTION 13: REALTIME SCHEMA FUNCTIONS'
\echo '-- ========================================'

SELECT p.proname, pg_get_function_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'realtime'
ORDER BY p.proname;
