-- 20261116400001_self_assignable_roles.sql with 20261124100001_call_signal_relay.sql:
-- account_role_picks_per_minute on set_my_self_assignable_role, taking and dropping on one count,
-- refused as ANTISPAM_RATE_LIMITED naming the limit; staff pass.
--
--   server_1 (55555555-...05)  owner alice, member bob
--   pick (1)                   self-assignable, no bits
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

SELECT is((SELECT public.antispam_settings() -> 'account_role_picks_per_minute'), '60'::jsonb,
          'role picks default to 60 a minute');

-- A small limit keeps the test short.
INSERT INTO public.instance_config (config_key, config_value)
VALUES ('antispam', '{"account_role_picks_per_minute": 4}'::jsonb)
ON CONFLICT (config_key) DO UPDATE
   SET config_value = public.instance_config.config_value || EXCLUDED.config_value;

INSERT INTO public.server_roles (id, server_id, name, position, permissions, self_assignable) VALUES
  ('37700000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'pick', 1, 0, true),
  ('37700000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'plain', 1, 0, false);

CREATE FUNCTION pg_temp.pick(p_on boolean) RETURNS boolean LANGUAGE sql AS $$
    SELECT public.set_my_self_assignable_role('37700000-0000-0000-0000-000000000001', p_on)
$$;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_my_self_assignable_role('37700000-0000-0000-0000-000000000002', true)$q$,
                 '42501', 'NOT_SELF_ASSIGNABLE', 'a pick that its checks refuse');
SELECT lives_ok($q$SELECT pg_temp.pick(true); SELECT pg_temp.pick(false); SELECT pg_temp.pick(true)$q$,
                'picks up to the limit pass');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.automod_recent_activity
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND kind = 'role_pick'), 3,
          'each counts once, the refused one not');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.pick(false), false, 'the fourth call of the minute passes');
SELECT throws_like($q$SELECT pg_temp.pick(true)$q$, 'ANTISPAM_RATE_LIMITED:%', 'the next pick in the minute is refused');
SELECT throws_like($q$SELECT pg_temp.pick(false)$q$, 'ANTISPAM_RATE_LIMITED:%', 'and so is a drop');

CREATE TEMP TABLE refusal (details text, hint text);
GRANT ALL ON refusal TO authenticated;
DO $$
BEGIN
    PERFORM pg_temp.pick(true);
EXCEPTION WHEN raise_exception THEN
    DECLARE d text; h text;
    BEGIN
        GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, h = PG_EXCEPTION_HINT;
        INSERT INTO refusal VALUES (d, h);
    END;
END;
$$;
SELECT is((SELECT details::jsonb FROM refusal), '{"kind": "role_pick", "limit": 4, "window_seconds": 60}'::jsonb,
          'the refusal names its limit');
SELECT is((SELECT hint FROM refusal), 'Limit reached: account_role_picks_per_minute.', 'and its setting');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '37700000-0000-0000-0000-000000000001'),
          0, 'a refused pick writes no role');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE target_id = '22222222-0000-0000-0000-000000000002'
              AND details ->> 'role_id' = '37700000-0000-0000-0000-000000000001'),
          4, 'and no audit row');

UPDATE public.automod_recent_activity SET created_at = created_at - interval '61 seconds'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND kind = 'role_pick';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.pick(true), true, 'a minute later the pick passes');

SELECT tests.clear_authentication();
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.pick(true); SELECT pg_temp.pick(false); SELECT pg_temp.pick(true); SELECT pg_temp.pick(false); SELECT pg_temp.pick(true)$q$,
                'an instance admin is not limited');
SELECT is((public.update_instance_antispam_settings('{"account_role_picks_per_minute": 0}'::jsonb)
           -> 'account_role_picks_per_minute'), '0'::jsonb, 'and turns the limit off');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
