-- ANTISPAM_RATE_LIMITED names its limit in DETAIL after 20261118300001.
--
--   erin   c307 account, new; frank, gina, hank c307 accounts she does not know
-- refusal() runs a statement and returns its error message and DETAIL. now() is fixed inside the
-- transaction, so a refusal right after the counted writes waits the whole window.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c3070000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin307@test.local'),
  ('c3070000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank307@test.local'),
  ('c3070000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gina307@test.local'),
  ('c3070000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hank307@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('c3071000-0000-0000-0000-00000000000a', 'c3070000-0000-0000-0000-00000000000a', 'erin307', 'Erin', true),
  ('c3071000-0000-0000-0000-00000000000b', 'c3070000-0000-0000-0000-00000000000b', 'frank307', 'Frank', true),
  ('c3071000-0000-0000-0000-00000000000c', 'c3070000-0000-0000-0000-00000000000c', 'gina307', 'Gina', true),
  ('c3071000-0000-0000-0000-00000000000d', 'c3070000-0000-0000-0000-00000000000d', 'hank307', 'Hank', true);
UPDATE public.instance_config
   SET config_value = config_value || '{"new_account_stranger_dms_per_hour": 2, "account_follows_per_hour": 1}'::jsonb
 WHERE config_key = 'antispam';

CREATE FUNCTION pg_temp.refusal(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v_message text;
    v_detail text;
BEGIN
    EXECUTE p_sql;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('message', v_message, 'detail', NULLIF(v_detail, '')::jsonb);
END
$fn$;

-- A group of strangers past a new account's limit -----------------------------------------------------
SELECT tests.authenticate_as('c3070000-0000-0000-0000-00000000000a');
CREATE TEMP TABLE group_refusal ON COMMIT DROP AS
SELECT pg_temp.refusal($q$SELECT public.create_group_conversation('c3071000-0000-0000-0000-00000000000a',
    ARRAY['c3071000-0000-0000-0000-00000000000a', 'c3071000-0000-0000-0000-00000000000b',
          'c3071000-0000-0000-0000-00000000000c', 'c3071000-0000-0000-0000-00000000000d']::uuid[])$q$) AS r;
RESET ROLE;
SELECT tests.clear_authentication();

SELECT is((SELECT r ->> 'message' FROM group_refusal), 'ANTISPAM_RATE_LIMITED:3600',
          'the third stranger in a new group is refused, with the seconds until the oldest leaves the hour');
SELECT is((SELECT r -> 'detail' FROM group_refusal),
          '{"kind": "stranger_dm", "limit": 2, "window_seconds": 3600}'::jsonb,
          'and names the limit: new conversations with strangers, 2 per hour');
SELECT is((SELECT count(*)::int FROM public.conversations WHERE created_by = 'c3071000-0000-0000-0000-00000000000a'), 0,
          'the refused group is not made');

-- A write guard -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('c3070000-0000-0000-0000-00000000000a');
SELECT is(pg_temp.refusal($q$INSERT INTO public.follows (follower_id, following_id)
                             VALUES ('c3071000-0000-0000-0000-00000000000a', 'c3071000-0000-0000-0000-00000000000b')$q$),
          NULL, 'a follow within the limit');
SELECT is(pg_temp.refusal($q$INSERT INTO public.follows (follower_id, following_id)
                             VALUES ('c3071000-0000-0000-0000-00000000000a', 'c3071000-0000-0000-0000-00000000000c')$q$),
          '{"message": "ANTISPAM_RATE_LIMITED:3600",
            "detail": {"kind": "follow", "limit": 1, "window_seconds": 3600}}'::jsonb,
          'the next follow is refused and names the follow limit');
RESET ROLE;
SELECT tests.clear_authentication();

-- The function ------------------------------------------------------------------------------------------
SELECT is(pg_temp.refusal($q$SELECT public.antispam_rate_check('c3071000-0000-0000-0000-00000000000d', 'reaction', 1, 60, 'hint')$q$),
          NULL, 'nothing counted, nothing refused');
SELECT ok((SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp']
             FROM pg_proc p WHERE p.oid = 'public.antispam_rate_check(uuid, text, integer, integer, text)'::regprocedure),
          'the function stays a stable definer with the search_path of SURFACE.tsv');
SELECT ok(NOT has_function_privilege('authenticated', 'public.antispam_rate_check(uuid, text, integer, integer, text)', 'EXECUTE'),
          'authenticated cannot call it');
SELECT ok(NOT has_function_privilege('anon', 'public.antispam_rate_check(uuid, text, integer, integer, text)', 'EXECUTE'),
          'nor anon');
SELECT ok(has_function_privilege('service_role', 'public.antispam_rate_check(uuid, text, integer, integer, text)', 'EXECUTE'),
          'service_role can');

SELECT * FROM finish();
ROLLBACK;
