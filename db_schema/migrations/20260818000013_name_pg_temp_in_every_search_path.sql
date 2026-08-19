-- Names pg_temp explicitly in the search_path of every function in public.
--
-- A pin that omits pg_temp is not a pin: Postgres searches the session's temporary schema
-- FIRST for relation names unless pg_temp appears, so `SET search_path = public` still
-- resolves an unqualified `emojis` to the caller's pg_temp.emojis. In a SECURITY DEFINER
-- function that lets the caller choose which table the owner reads and writes.
--
-- Measured on a fresh build: as `authenticated`, a temp table named emojis captured the
-- INSERT performed by create_federated_emoji and public.emojis received nothing.
-- has_database_privilege('authenticated', current_database(), 'TEMP') is true.
--
-- Not reachable over PostgREST, which will not run CREATE TEMP TABLE for a JWT client; this
-- is the function_search_path_mutable finding Supabase's own advisor reports. 134
-- SECURITY DEFINER functions were in that shape, including the helpers every RLS policy
-- calls.
--
-- pg_temp is APPENDED, never substituted, so a deliberately narrow path keeps its schemas.

BEGIN;

DO $$
DECLARE
    r record;
    v_pinned integer := 0;
    v_fixed  integer := 0;
    v_failed integer := 0;
BEGIN
    FOR r IN
        SELECT p.proname,
               pg_get_function_identity_arguments(p.oid) AS args,
               (SELECT c FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
                 WHERE c LIKE 'search_path=%' LIMIT 1) AS pin
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND NOT EXISTS (
              SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
              WHERE c LIKE 'search_path=%'
                AND replace(', ' || split_part(c, '=', 2) || ',', ' ', '') LIKE '%,pg_temp,%'
          )
    LOOP
        BEGIN
            IF r.pin IS NULL THEN
                EXECUTE format(
                    'ALTER FUNCTION public.%I(%s) SET search_path = public, extensions, pg_temp',
                    r.proname, r.args
                );
                v_pinned := v_pinned + 1;
            ELSE
                EXECUTE format(
                    'ALTER FUNCTION public.%I(%s) SET search_path = %s, pg_temp',
                    r.proname, r.args, split_part(r.pin, '=', 2)
                );
                v_fixed := v_fixed + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed + 1;
            RAISE NOTICE 'search_path unchanged for %(%): %', r.proname, r.args, SQLERRM;
        END;
    END LOOP;

    RAISE NOTICE 'search_path: % had no pin and were pinned, % had a pin without pg_temp and gained it, % could not be altered',
                 v_pinned, v_fixed, v_failed;
END
$$;

-- Nothing in public may be left without pg_temp named. A residue here means the loop above
-- raised on that function, which is a fact worth failing on rather than logging.
DO $$
DECLARE
    v_left integer;
    v_names text;
BEGIN
    SELECT count(*), coalesce(string_agg(p.oid::regprocedure::text, ', '), '')
      INTO v_left, v_names
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND NOT EXISTS (
           SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
           WHERE c LIKE 'search_path=%'
             AND replace(', ' || split_part(c, '=', 2) || ',', ' ', '') LIKE '%,pg_temp,%'
       );

    IF v_left > 0 THEN
        RAISE EXCEPTION 'search_path still omits pg_temp on % function(s): %', v_left, v_names;
    END IF;
END
$$;

COMMIT;
