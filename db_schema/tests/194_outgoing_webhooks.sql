-- 20261028600001_outgoing_webhooks.sql: who registers a webhook, its Vault secret, verification by
-- PING, which events reach it, the instance's limits and switches, the delivery state machine,
-- the circuit breaker, auto-disable, staff controls, and the member change feed.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added here:
--   bot194      alice's bot
--   hooks194    role with MANAGE_WEBHOOKS (bit 6), given to bob
--   secret194   a text channel of server_1 that @everyone cannot view (VIEW_CHANNEL, bit 1, denied)
--   admin194    an instance admin; mod194 an instance moderator; neither in server_1
--   alice is no instance staff here

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(75);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1940000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin194@test.local'),
  ('f1940000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mod194@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin, is_moderator) VALUES
  ('f1940000-0000-0000-0000-0000000000d1', 'f1940000-0000-0000-0000-0000000000a1', 'admin194', 'Admin', true, true, false),
  ('f1940000-0000-0000-0000-0000000000d2', 'f1940000-0000-0000-0000-0000000000a2', 'mod194', 'Mod', true, false, true);
INSERT INTO public.bots (id, username, display_name, owner_id, is_public)
VALUES ('f1940000-0000-0000-0000-0000000000b1', 'bot194', 'Bot 194', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1940000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'hooks194', 3, 64);
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1940000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'secret194', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f1940000-0000-0000-0000-0000000000c1', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
DELETE FROM public.instance_config WHERE config_key = 'webhook_settings';
-- Fixture alice is an instance admin; here she is a member only.
UPDATE public.profiles SET is_admin = false, is_moderator = false WHERE id = '11111111-0000-0000-0000-000000000001';

CREATE TEMP TABLE w194 (k text PRIMARY KEY, body jsonb);
GRANT ALL ON w194 TO authenticated, service_role;
CREATE FUNCTION pg_temp.wid(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT (body ->> 'id')::uuid FROM w194 WHERE k = p_k
$$;
GRANT EXECUTE ON FUNCTION pg_temp.wid(text) TO authenticated, service_role;
-- As the worker after a 2xx to each pending PING of the webhook.
CREATE FUNCTION pg_temp.answer_pings(p_webhook uuid) RETURNS void LANGUAGE sql AS $$
    SELECT public.record_outgoing_webhook_attempt(d.id, true, 204, NULL)
      FROM public.outgoing_webhook_deliveries d
     WHERE d.webhook_id = p_webhook AND d.event = 'PING' AND d.status = 'pending'
$$;
CREATE FUNCTION pg_temp.settings(p jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO public.instance_config (config_key, config_value) VALUES ('webhook_settings', p)
    ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value
$$;
CREATE FUNCTION pg_temp.deliveries(p_webhook uuid, p_id text) RETURNS integer LANGUAGE sql AS $$
    SELECT count(*)::int FROM public.outgoing_webhook_deliveries WHERE webhook_id = p_webhook AND payload ->> 'id' = p_id
$$;
CREATE FUNCTION pg_temp.enqueue(p_event text, p_channel uuid, p_id text) RETURNS integer LANGUAGE sql AS $$
    SELECT public.enqueue_outgoing_webhook_event(p_event, '55555555-0000-0000-0000-000000000005', p_channel,
        ARRAY['f1940000-0000-0000-0000-0000000000b1']::uuid[], jsonb_build_object('id', p_id))
$$;

-- Privileges. -------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.create_outgoing_webhook(uuid, uuid, text, text, text[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.create_outgoing_webhook(uuid, uuid, text, text, text[])', 'EXECUTE'),
          'members create webhooks; anon does not');
SELECT ok(NOT has_function_privilege('authenticated', 'public.enqueue_outgoing_webhook_event(text, uuid, uuid, uuid[], jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.claim_outgoing_webhook_delivery(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_outgoing_webhook_attempt(uuid, boolean, integer, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.outgoing_webhook_probes()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.claim_outgoing_webhook_delivery(uuid)', 'EXECUTE'),
          'queueing and sending are the services''');
SELECT ok(NOT has_table_privilege('authenticated', 'public.outgoing_webhooks', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.outgoing_webhook_deliveries', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.outgoing_webhook_host_minutes', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.server_member_changes', 'SELECT'),
          'clients read no webhook table directly');
SELECT ok(NOT has_function_privilege('authenticated', 'public.webhook_settings()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.webhook_availability()', 'EXECUTE'),
          'clients read what is available to them, not the settings');
SELECT is(to_regclass('public.bot_webhooks'), NULL, 'bot_webhooks is gone');

-- Creating. ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.webhook_availability() ->> 'can_create_outgoing', 'true', 'by default anyone managing webhooks creates them');
INSERT INTO w194 VALUES ('bot', public.create_outgoing_webhook(
    'f1940000-0000-0000-0000-0000000000b1', NULL, 'Events', 'https://hooks.example/bot', ARRAY['MESSAGE_CREATE', 'MESSAGE_CREATE', 'SERVER_MEMBER_ADD']));
INSERT INTO w194 VALUES ('server', public.create_outgoing_webhook(
    NULL, '55555555-0000-0000-0000-000000000005', 'Log', 'https://hooks.example/server', ARRAY['MESSAGE_CREATE', 'SERVER_BAN_ADD']));
SELECT ok((SELECT body ->> 'secret' FROM w194 WHERE k = 'bot') ~ '^whsec_[A-Za-z0-9+/]{43}=$',
          'the owner gets a Standard Webhooks secret once');
SELECT is((SELECT body -> 'events' FROM w194 WHERE k = 'bot'), '["MESSAGE_CREATE", "SERVER_MEMBER_ADD"]'::jsonb,
          'events are kept once each, in order');
SELECT is((SELECT body ->> 'secret_hint' FROM w194 WHERE k = 'bot'), right((SELECT body ->> 'secret' FROM w194 WHERE k = 'bot'), 4),
          'and a hint of it');
SELECT is((SELECT body ->> 'verified_at' FROM w194 WHERE k = 'bot'), NULL, 'a new webhook is not verified');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x', 'http://hooks.example/', ARRAY['MESSAGE_CREATE'])$q$,
    'OUTGOING_WEBHOOK_INVALID_URL%', 'a URL must be https');
SELECT lives_ok(
    $q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'local', 'http://localhost:8080/hook', ARRAY['MESSAGE_CREATE'])$q$,
    'http is taken for localhost');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x', 'https://user@hooks.example/', ARRAY['MESSAGE_CREATE'])$q$,
    'OUTGOING_WEBHOOK_INVALID_URL%', 'a URL carries no credentials');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x', 'https://hooks.example/', ARRAY['TYPING_START'])$q$,
    'OUTGOING_WEBHOOK_INVALID_EVENTS%', 'only events this instance sends');
SELECT lives_ok($q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x3', 'https://hooks.example/3', ARRAY['MESSAGE_CREATE'])$q$, 'a third');
SELECT lives_ok($q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x4', 'https://hooks.example/4', ARRAY['MESSAGE_CREATE'])$q$, 'a fourth');
SELECT lives_ok($q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x5', 'https://hooks.example/5', ARRAY['MESSAGE_CREATE'])$q$, 'a fifth');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook(NULL, '55555555-0000-0000-0000-000000000005', 'x6', 'https://hooks.example/6', ARRAY['MESSAGE_CREATE'])$q$,
    'OUTGOING_WEBHOOK_LIMIT:%', 'five per server at most');
SELECT ok(NOT (SELECT public.list_outgoing_webhooks(NULL, '55555555-0000-0000-0000-000000000005')) @? '$[*].secret',
          'a listing never shows a secret');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.outgoing_webhook_deliveries WHERE webhook_id = pg_temp.wid('bot') AND event = 'PING'),
          1, 'creating queues the PING that verifies the webhook');

SELECT pg_temp.settings('{"per_user": 7}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.create_outgoing_webhook('f1940000-0000-0000-0000-0000000000b1', NULL, 'b2', 'https://hooks.example/b2', ARRAY['MESSAGE_CREATE'])$q$,
                'a seventh of alice''s');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook('f1940000-0000-0000-0000-0000000000b1', NULL, 'b3', 'https://hooks.example/b3', ARRAY['MESSAGE_CREATE'])$q$,
    'OUTGOING_WEBHOOK_LIMIT_USER%', 'the instance caps webhooks per person, bots'' and servers'' together');
SELECT tests.clear_authentication();
SELECT pg_temp.settings('{"outgoing_mode": "staff"}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.webhook_availability() ->> 'can_create_outgoing', 'false', 'staff-only mode: alice may not create');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook('f1940000-0000-0000-0000-0000000000b1', NULL, 'b3', 'https://hooks.example/b3', ARRAY['MESSAGE_CREATE'])$q$,
    'OUTGOING_WEBHOOK_DISABLED%', 'and is refused');
SELECT tests.clear_authentication();
SELECT pg_temp.settings('{"blocked_domains": ["evil.example"]}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_like(
    $q$SELECT public.update_outgoing_webhook((SELECT (w ->> 'id')::uuid FROM jsonb_array_elements(
        public.list_outgoing_webhooks(NULL, '55555555-0000-0000-0000-000000000005')) w WHERE w ->> 'name' = 'x5'),
        p_url => 'https://hooks.evil.example/x')$q$,
    'OUTGOING_WEBHOOK_BLOCKED_DOMAIN%', 'a blocked domain is refused, its subdomains too');
SELECT tests.clear_authentication();
DELETE FROM public.instance_config WHERE config_key = 'webhook_settings';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_like(
    $q$SELECT public.create_outgoing_webhook('f1940000-0000-0000-0000-0000000000b1', NULL, 'x', 'https://evil.example/', ARRAY['MESSAGE_CREATE'])$q$,
    'OUTGOING_WEBHOOK_FORBIDDEN%', 'a webhook of someone else''s bot is refused');
SELECT throws_like(
    $q$SELECT public.list_outgoing_webhooks(NULL, '55555555-0000-0000-0000-000000000005')$q$,
    'OUTGOING_WEBHOOK_FORBIDDEN%', 'a member without MANAGE_WEBHOOKS sees none of the server''s');
SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1940000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT public.delete_outgoing_webhook((SELECT (w ->> 'id')::uuid FROM jsonb_array_elements(
        public.list_outgoing_webhooks(NULL, '55555555-0000-0000-0000-000000000005')) w WHERE w ->> 'name' = 'x4'))$q$,
    'with MANAGE_WEBHOOKS a member manages the server''s');
INSERT INTO w194 VALUES ('bob', public.create_outgoing_webhook(
    NULL, '55555555-0000-0000-0000-000000000005', 'Bob log', 'https://hooks.example/bob', ARRAY['MESSAGE_CREATE']));
SELECT tests.clear_authentication();

-- Editing and the secret. -------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.update_outgoing_webhook(pg_temp.wid('bot'), p_name => 'Renamed')) -> 'events',
          '["MESSAGE_CREATE", "SERVER_MEMBER_ADD"]'::jsonb, 'an edit without events keeps them');
SELECT is((public.update_outgoing_webhook(pg_temp.wid('server'), p_active => false)) ->> 'disabled_reason',
          'owner', 'turning a webhook off says the owner did');
SELECT is((public.update_outgoing_webhook(pg_temp.wid('server'), p_active => true)) ->> 'disabled_reason',
          NULL, 'and on again clears it');
INSERT INTO w194 VALUES ('rotated', public.rotate_outgoing_webhook_secret(pg_temp.wid('bot')));
SELECT throws_like($q$SELECT public.test_outgoing_webhook(pg_temp.wid('bot'))$q$,
                   'OUTGOING_WEBHOOK_TOO_SOON%', 'one test event per 10 seconds');
SELECT tests.clear_authentication();
SELECT is((SELECT s.decrypted_secret FROM public.outgoing_webhooks w JOIN vault.decrypted_secrets s ON s.id = w.secret_id
            WHERE w.id = pg_temp.wid('bot')),
          (SELECT body ->> 'secret' FROM w194 WHERE k = 'rotated'), 'a rotation stores the new secret in Vault');
SELECT is((SELECT count(*)::int FROM vault.decrypted_secrets WHERE decrypted_secret = (SELECT body ->> 'secret' FROM w194 WHERE k = 'bot')),
          0, 'and removes the old one');

-- Verification and queueing. ----------------------------------------------------------------------
SELECT is(pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'm0'), 0,
          'an unverified webhook takes no event');
SELECT pg_temp.answer_pings(pg_temp.wid(k)) FROM unnest(ARRAY['bot', 'server', 'bob']) k;
SELECT ok((SELECT bool_and(verified_at IS NOT NULL) FROM public.outgoing_webhooks
            WHERE id IN (pg_temp.wid('bot'), pg_temp.wid('server'), pg_temp.wid('bob'))),
          'a 2xx to the PING verifies it');
SELECT pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'm1');
SELECT is(pg_temp.deliveries(pg_temp.wid('bot'), 'm1') + pg_temp.deliveries(pg_temp.wid('server'), 'm1')
          + pg_temp.deliveries(pg_temp.wid('bob'), 'm1'),
          3, 'a message reaches the reading bot''s webhook and each verified server webhook taking it');
SELECT pg_temp.enqueue('MESSAGE_CREATE', 'f1940000-0000-0000-0000-0000000000c1', 'm2');
SELECT ok(pg_temp.deliveries(pg_temp.wid('bob'), 'm2') = 0 AND pg_temp.deliveries(pg_temp.wid('server'), 'm2') = 1,
          'in a channel bob cannot view, his server webhook takes nothing; the owner''s does');
SELECT is(pg_temp.enqueue('SERVER_BAN_ADD', NULL, 'ban'), 1, 'a ban reaches only a webhook taking bans');
SELECT is(pg_temp.enqueue('TYPING_START', NULL, 'typing'), 0, 'an event this instance does not send reaches none');

DELETE FROM public.user_roles WHERE role_id = 'f1940000-0000-0000-0000-0000000000e1';
SELECT pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'm3');
SELECT is(pg_temp.deliveries(pg_temp.wid('bob'), 'm3'), 0,
          'a server webhook whose creator no longer manages webhooks takes nothing');

-- The bot's webhook took m1, m2 and m3 this minute.
SELECT pg_temp.settings('{"rate_per_minute": 4}');
SELECT pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'r1');
SELECT pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'r2');
SELECT results_eq(
    $q$SELECT pg_temp.deliveries(pg_temp.wid('bot'), 'r2'), dropped_events, last_drop_reason
         FROM public.outgoing_webhooks WHERE id = pg_temp.wid('bot')$q$,
    $q$VALUES (0, 1, 'rate_limited'::text)$q$,
    'past its rate per minute a webhook drops the event and counts it');
SELECT pg_temp.settings('{"blocked_domains": ["hooks.example"]}');
SELECT is(pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'blocked'), 0,
          'nothing is queued for a destination the instance blocked since');
SELECT pg_temp.settings('{"outgoing_mode": "off"}');
SELECT is(pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'off'), 0,
          'with outgoing webhooks off nothing is queued');
SELECT is((SELECT count(*)::int FROM public.outgoing_webhook_routes()), 0, 'and the gateway is given no route');
DELETE FROM public.instance_config WHERE config_key = 'webhook_settings';

-- Delivering. -------------------------------------------------------------------------------------
-- As the functions' owner: pgTAP is not visible to service_role.
CREATE TEMP TABLE d194 AS
SELECT d.id FROM public.outgoing_webhook_deliveries d WHERE d.payload ->> 'id' = 'm1' AND d.webhook_id = pg_temp.wid('bot');
SELECT is((SELECT count(*)::int FROM public.claim_outgoing_webhook_delivery((SELECT id FROM d194)) s
            WHERE s.url = 'https://hooks.example/bot' AND s.secret = (SELECT body ->> 'secret' FROM w194 WHERE k = 'rotated')),
          1, 'the worker claims a due delivery: URL, secret and payload');
SELECT is((SELECT count(*)::int FROM public.claim_outgoing_webhook_delivery((SELECT id FROM d194))),
          0, 'a claimed delivery is not claimed again');
SELECT is(public.record_outgoing_webhook_attempt((SELECT id FROM d194), false, 503, 'Service Unavailable'),
          'pending', 'a failure leaves it pending');
SELECT ok((SELECT payload IS NOT NULL FROM public.outgoing_webhook_deliveries WHERE id = (SELECT id FROM d194)),
          'with its payload for the next attempt');
UPDATE public.outgoing_webhook_deliveries SET attempts = 7, next_attempt_at = now() WHERE id = (SELECT id FROM d194);
SELECT is(public.record_outgoing_webhook_attempt((SELECT id FROM d194), false, 500, 'boom'),
          'failed', 'the eighth failure ends it');
SELECT ok((SELECT payload IS NULL FROM public.outgoing_webhook_deliveries WHERE id = (SELECT id FROM d194)),
          'and drops its payload');
SELECT is(public.record_outgoing_webhook_attempt(
              (SELECT d.id FROM public.outgoing_webhook_deliveries d WHERE d.payload ->> 'id' = 'm1' AND d.webhook_id = pg_temp.wid('server')),
              true, 204, NULL),
          'delivered', 'a success delivers it');
SELECT is((SELECT failing_since FROM public.outgoing_webhooks WHERE id = pg_temp.wid('server')), NULL,
          'and clears the webhook''s failures');

INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload)
SELECT pg_temp.wid('server'), 'MESSAGE_CREATE', jsonb_build_object('id', 'f' || g) FROM generate_series(1, 3) g;
CREATE TEMP TABLE f194 AS
SELECT id FROM public.outgoing_webhook_deliveries WHERE payload ->> 'id' IN ('f1', 'f2', 'f3') ORDER BY payload ->> 'id';
SELECT public.claim_outgoing_webhook_delivery(id) FROM f194 ORDER BY id LIMIT 2;
SELECT is((SELECT defer_ms FROM public.claim_outgoing_webhook_delivery(
              (SELECT id FROM f194 WHERE id NOT IN (SELECT id FROM public.outgoing_webhook_deliveries WHERE claimed_at IS NOT NULL)))),
          2000, 'two attempts of a webhook in flight defer a third');
INSERT INTO public.outgoing_webhook_host_minutes (host, minute, attempts)
VALUES ('hooks.example', date_trunc('minute', now()), 1000)
ON CONFLICT (host, minute) DO UPDATE SET attempts = 1000;
INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload) VALUES (pg_temp.wid('bot'), 'MESSAGE_CREATE', '{"id":"h1"}');
SELECT ok((SELECT defer_ms > 0 FROM public.claim_outgoing_webhook_delivery(
              (SELECT id FROM public.outgoing_webhook_deliveries WHERE payload ->> 'id' = 'h1'))),
          'a destination host at its rate defers the attempt to the next minute');
DELETE FROM public.outgoing_webhook_host_minutes;

-- Circuit breaker and auto-disable. ---------------------------------------------------------------
UPDATE public.outgoing_webhooks SET consecutive_failures = 10, last_failure_at = now() - interval '6 minutes'
 WHERE id = pg_temp.wid('server');
SELECT pg_temp.enqueue('MESSAGE_CREATE', '66666666-0000-0000-0000-000000000006', 'p1');
SELECT results_eq(
    $q$SELECT pg_temp.deliveries(pg_temp.wid('server'), 'p1'), last_drop_reason
         FROM public.outgoing_webhooks WHERE id = pg_temp.wid('server')$q$,
    $q$VALUES (0, 'paused'::text)$q$,
    'after ten failures in a row a webhook drops new events');
UPDATE public.outgoing_webhook_deliveries SET status = 'failed', payload = NULL WHERE webhook_id = pg_temp.wid('server') AND status = 'pending';
-- The probes' rows are read in a later statement: one statement sees no row its function inserted.
CREATE TEMP TABLE probe194 AS SELECT p.id FROM public.outgoing_webhook_probes() AS p(id);
SELECT is((SELECT count(*)::int FROM probe194 p
            JOIN public.outgoing_webhook_deliveries d ON d.id = p.id WHERE d.webhook_id = pg_temp.wid('server') AND d.event = 'PING'),
          1, 'and is probed with a PING once nothing is pending');
CREATE TEMP TABLE probe194b AS SELECT p.id FROM public.outgoing_webhook_probes() AS p(id);
SELECT is((SELECT count(*)::int FROM probe194b p
            JOIN public.outgoing_webhook_deliveries d ON d.id = p.id WHERE d.webhook_id = pg_temp.wid('server')),
          0, 'one probe at a time');
SELECT pg_temp.answer_pings(pg_temp.wid('server'));
SELECT is((SELECT consecutive_failures FROM public.outgoing_webhooks WHERE id = pg_temp.wid('server')), 0,
          'a probe''s 2xx resumes it');

UPDATE public.outgoing_webhooks SET failing_since = now() - interval '4 days' WHERE id = pg_temp.wid('bot');
INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload)
VALUES (pg_temp.wid('bot'), 'MESSAGE_CREATE', '{"id":"m4"}');
SELECT public.record_outgoing_webhook_attempt(
    (SELECT d.id FROM public.outgoing_webhook_deliveries d WHERE d.payload ->> 'id' = 'm4'), false, NULL, 'connect ECONNREFUSED');
SELECT results_eq(
    $q$SELECT is_active, disabled_reason FROM public.outgoing_webhooks WHERE id = pg_temp.wid('bot')$q$,
    $q$VALUES (false, 'failing'::text)$q$,
    'three days of failures disable the webhook');
SELECT is((SELECT data #>> '{webhook,name}' FROM public.notifications
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND type = 'outgoing_webhook_disabled'),
          'Renamed', 'and tell the bot''s owner');

-- Staff. ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.admin_list_outgoing_webhooks()$q$, '42501', 'Instance staff only',
                 'a member does not list the instance''s webhooks');
SELECT tests.authenticate_as('f1940000-0000-0000-0000-0000000000a2');
SELECT ok((SELECT public.admin_list_outgoing_webhooks()) @? '$[*] ? (@.name == "Log" && @.host == "hooks.example")',
          'a moderator lists every webhook with its destination');
SELECT is((public.admin_set_outgoing_webhook_active(pg_temp.wid('server'), false)) ->> 'disabled_reason', 'staff',
          'and turns one off');
SELECT throws_ok($q$SELECT public.admin_update_webhook_settings('{"rate_per_minute": 5}')$q$, '42501', 'Instance admins only',
                 'settings are an admin''s');
SELECT throws_ok($q$SELECT public.admin_delete_outgoing_webhook(pg_temp.wid('server'))$q$, '42501', 'Instance admins only',
                 'and so is deleting');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_like($q$SELECT public.update_outgoing_webhook(pg_temp.wid('server'), p_active => true)$q$,
                   'OUTGOING_WEBHOOK_STAFF_DISABLED%', 'the owner cannot turn on a webhook staff turned off');
SELECT tests.authenticate_as('f1940000-0000-0000-0000-0000000000a1');
SELECT is(public.admin_update_webhook_settings('{"rate_per_minute": 50, "blocked_domains": ["Bad.Example", "not a domain"]}')
              -> 'blocked_domains',
          '["bad.example"]'::jsonb, 'an admin sets the limits; blocked domains are lowercased, nonsense dropped');
SELECT throws_ok($q$SELECT public.admin_update_webhook_settings('{"outgoing_mode": "sometimes"}')$q$, '22023',
                 'outgoing_mode is everyone, staff or off', 'a mode must be one of three');
SELECT lives_ok($q$SELECT public.admin_delete_outgoing_webhook(pg_temp.wid('server'))$q$, 'an admin deletes a webhook');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE action_type IN ('outgoing_webhook_disabled', 'outgoing_webhook_deleted', 'webhook_settings_updated')),
          3, 'each staff action is in the admin audit log');

-- Incoming webhooks off. --------------------------------------------------------------------------
SELECT pg_temp.settings('{"incoming_enabled": false}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_like($q$SELECT public.create_channel_webhook('66666666-0000-0000-0000-000000000006', 'CI')$q$,
                   'WEBHOOK_DISABLED%', 'with incoming webhooks off none is created');
SELECT is(public.webhook_availability() ->> 'incoming_enabled', 'false', 'and the app is told');
SELECT tests.clear_authentication();
DELETE FROM public.instance_config WHERE config_key = 'webhook_settings';

-- Member changes. ---------------------------------------------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted');
DELETE FROM public.user_servers WHERE user_id = '33333333-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT results_eq(
    $q$SELECT change FROM public.server_member_changes
        WHERE user_id = '33333333-0000-0000-0000-000000000003' ORDER BY id$q$,
    $q$VALUES ('join'::text), ('leave'::text)$q$,
    'a join and a leave of a local server are recorded in order');

-- Deleting. ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.delete_outgoing_webhook(pg_temp.wid('bot'));
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.decrypted_secrets WHERE decrypted_secret = (SELECT body ->> 'secret' FROM w194 WHERE k = 'rotated')),
          0, 'deleting a webhook removes its secret');

SELECT * FROM finish();
ROLLBACK;
