-- 20261124100001_call_signal_relay.sql, limits: account_signals_per_minute on send_signal,
-- account_rings_per_minute on ring_dm_call 'initiate', refused as ANTISPAM_RATE_LIMITED naming the
-- limit; staff and limit_exempt_accounts pass; a cancel is never refused.
--
-- Fixtures: alice owns server_1, bob is a member; alice and bob share DM 7777.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(19);

SELECT is((SELECT public.antispam_settings() -> 'account_signals_per_minute'), '300'::jsonb,
          'signals default to 300 a minute');
SELECT is((SELECT public.antispam_settings() -> 'account_rings_per_minute'), '10'::jsonb,
          'rings default to 10 a minute');

-- Small limits keep the test short.
INSERT INTO public.instance_config (config_key, config_value)
VALUES ('antispam', '{"account_signals_per_minute": 3, "account_rings_per_minute": 2}'::jsonb)
ON CONFLICT (config_key) DO UPDATE
   SET config_value = public.instance_config.config_value || EXCLUDED.config_value;

CREATE FUNCTION pg_temp.signal() RETURNS void LANGUAGE sql AS $$
    SELECT public.send_signal('harmony-voice-dm-77777777-0000-0000-0000-000000000007', 'signals',
                              '{"messages":[{"type":"media-state","data":{}}]}'::jsonb)
$$;
CREATE FUNCTION pg_temp.ring(p_signal text) RETURNS integer LANGUAGE sql AS $$
    SELECT public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                               ARRAY['11111111-0000-0000-0000-000000000001']::uuid[], p_signal, 'voice')
$$;

-- Signals -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT pg_temp.signal(); SELECT pg_temp.signal(); SELECT pg_temp.signal()$q$,
                'signals up to the limit pass');
SELECT throws_like($q$SELECT pg_temp.signal()$q$, 'ANTISPAM_RATE_LIMITED:%',
                   'the next signal in the minute is refused');
SELECT is((SELECT count(*)::int FROM realtime.messages
            WHERE topic = 'harmony-voice-dm-77777777-0000-0000-0000-000000000007'), 3,
          'a refused signal is not relayed');
SELECT throws_ok($q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"end"}'::jsonb)$q$,
                 'P0001', NULL, 'every topic shares the limit');

CREATE TEMP TABLE refusal (details text, hint text);
GRANT ALL ON refusal TO authenticated;
DO $$
BEGIN
    PERFORM pg_temp.signal();
EXCEPTION WHEN raise_exception THEN
    DECLARE d text; h text;
    BEGIN
        GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, h = PG_EXCEPTION_HINT;
        INSERT INTO refusal VALUES (d, h);
    END;
END;
$$;
SELECT is((SELECT details::jsonb FROM refusal), '{"kind": "signal", "limit": 3, "window_seconds": 60}'::jsonb,
          'the refusal names its limit');
SELECT is((SELECT hint FROM refusal), 'Limit reached: account_signals_per_minute.', 'and its setting');
SELECT tests.clear_authentication();

-- Rings: local (ring_dm_call) and federated (the backend's antispam_take_ring) on one count --
SELECT lives_ok($q$SELECT public.antispam_take_ring('22222222-0000-0000-0000-000000000002')$q$,
                'a federated ring is taken for its caller');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT pg_temp.ring('initiate')$q$, 'a local ring fills the same minute');
SELECT throws_like($q$SELECT pg_temp.ring('initiate')$q$, 'ANTISPAM_RATE_LIMITED:%',
                   'the next local ring in the minute is refused');
SELECT is(pg_temp.ring('end'), 1, 'a cancel past the limit still reaches the receiver');
SELECT is(pg_temp.ring('timeout'), 1, 'so does a timeout');
SELECT tests.clear_authentication();
SELECT throws_like($q$SELECT public.antispam_take_ring('22222222-0000-0000-0000-000000000002')$q$, 'ANTISPAM_RATE_LIMITED:%',
                   'so is the next federated ring');
SELECT ok(NOT has_function_privilege('authenticated', 'public.antispam_take_ring(uuid)', 'EXECUTE'),
          'clients cannot take rings for others');

-- Exemptions and settings -------------------------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.signal(); SELECT pg_temp.signal(); SELECT pg_temp.signal(); SELECT pg_temp.signal()$q$,
                'an instance admin is not limited');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.automod_recent_activity
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND kind = 'signal'), 0,
          'and leaves no count');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.update_instance_antispam_settings('{"account_signals_per_minute": 500, "account_rings_per_minute": 0}'::jsonb)
           -> 'account_signals_per_minute'), '500'::jsonb,
          'an admin sets the signal limit');
SELECT tests.clear_authentication();
SELECT is((SELECT public.antispam_settings() -> 'account_rings_per_minute'), '0'::jsonb,
          'and turns the ring limit off');

SELECT * FROM finish();
ROLLBACK;
