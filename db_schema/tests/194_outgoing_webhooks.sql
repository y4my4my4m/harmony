-- 20261028600001_outgoing_webhooks.sql: who registers a webhook, its Vault secret, which events
-- reach it, the delivery state machine, auto-disable, and the member change feed.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added here:
--   bot194      alice's bot
--   hooks194    role with MANAGE_WEBHOOKS (bit 6), given to bob
--   secret194   a text channel of server_1 that @everyone cannot view (VIEW_CHANNEL, bit 1, denied)

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(40);

INSERT INTO public.bots (id, username, display_name, owner_id, is_public)
VALUES ('f1940000-0000-0000-0000-0000000000b1', 'bot194', 'Bot 194', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1940000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'hooks194', 3, 64);
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1940000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'secret194', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f1940000-0000-0000-0000-0000000000c1', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

CREATE TEMP TABLE w194 (k text PRIMARY KEY, body jsonb);
GRANT ALL ON w194 TO authenticated, service_role;
CREATE FUNCTION pg_temp.wid(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT (body ->> 'id')::uuid FROM w194 WHERE k = p_k
$$;
GRANT EXECUTE ON FUNCTION pg_temp.wid(text) TO authenticated, service_role;

-- Privileges. -------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.create_outgoing_webhook(uuid, uuid, text, text, text[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.create_outgoing_webhook(uuid, uuid, text, text, text[])', 'EXECUTE'),
          'members create webhooks; anon does not');
SELECT ok(NOT has_function_privilege('authenticated', 'public.enqueue_outgoing_webhook_event(text, uuid, uuid, uuid[], jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.claim_outgoing_webhook_delivery(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_outgoing_webhook_attempt(uuid, boolean, integer, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.claim_outgoing_webhook_delivery(uuid)', 'EXECUTE'),
          'queueing and sending are the services''');
SELECT ok(NOT has_table_privilege('authenticated', 'public.outgoing_webhooks', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.outgoing_webhook_deliveries', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.server_member_changes', 'SELECT'),
          'clients read no webhook table directly');
SELECT is(to_regclass('public.bot_webhooks'), NULL, 'bot_webhooks is gone');

-- Creating. ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
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
    'OUTGOING_WEBHOOK_LIMIT%', 'five per server at most');
SELECT ok(NOT (SELECT public.list_outgoing_webhooks(NULL, '55555555-0000-0000-0000-000000000005')) @? '$[*].secret',
          'a listing never shows a secret');

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
SELECT tests.clear_authentication();
SELECT is((SELECT s.decrypted_secret FROM public.outgoing_webhooks w JOIN vault.decrypted_secrets s ON s.id = w.secret_id
            WHERE w.id = pg_temp.wid('bot')),
          (SELECT body ->> 'secret' FROM w194 WHERE k = 'rotated'), 'a rotation stores the new secret in Vault');
SELECT is((SELECT count(*)::int FROM vault.decrypted_secrets WHERE decrypted_secret = (SELECT body ->> 'secret' FROM w194 WHERE k = 'bot')),
          0, 'and removes the old one');

-- Queueing. ---------------------------------------------------------------------------------------
SET LOCAL ROLE service_role;
CREATE TEMP TABLE q194 AS SELECT
    public.enqueue_outgoing_webhook_event('MESSAGE_CREATE', '55555555-0000-0000-0000-000000000005',
        '66666666-0000-0000-0000-000000000006', ARRAY['f1940000-0000-0000-0000-0000000000b1']::uuid[], '{"id":"m1"}') AS general,
    public.enqueue_outgoing_webhook_event('MESSAGE_CREATE', '55555555-0000-0000-0000-000000000005',
        'f1940000-0000-0000-0000-0000000000c1', ARRAY[]::uuid[], '{"id":"m2"}') AS secret,
    public.enqueue_outgoing_webhook_event('SERVER_BAN_ADD', '55555555-0000-0000-0000-000000000005',
        NULL, ARRAY['f1940000-0000-0000-0000-0000000000b1']::uuid[], '{"user":"u"}') AS ban,
    public.enqueue_outgoing_webhook_event('TYPING_START', '55555555-0000-0000-0000-000000000005',
        NULL, NULL, '{}') AS unknown;
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.outgoing_webhook_deliveries d WHERE d.payload ->> 'id' = 'm1'
            AND d.webhook_id IN (pg_temp.wid('bot'), pg_temp.wid('server'), pg_temp.wid('bob'))),
          3, 'a message reaches the reading bot''s webhook and each server webhook taking it');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.outgoing_webhook_deliveries WHERE payload ->> 'id' = 'm2' AND webhook_id = pg_temp.wid('bob'))
          AND EXISTS (SELECT 1 FROM public.outgoing_webhook_deliveries WHERE payload ->> 'id' = 'm2' AND webhook_id = pg_temp.wid('server')),
          'in a channel bob cannot view, his server webhook takes nothing; the owner''s does');
SELECT is((SELECT ban FROM q194), 1, 'a ban reaches only a webhook taking bans');
SELECT is((SELECT unknown FROM q194), 0, 'an event this instance does not send reaches none');

DELETE FROM public.user_roles WHERE role_id = 'f1940000-0000-0000-0000-0000000000e1';
SET LOCAL ROLE service_role;
SELECT public.enqueue_outgoing_webhook_event('MESSAGE_CREATE', '55555555-0000-0000-0000-000000000005',
    '66666666-0000-0000-0000-000000000006', NULL, '{"id":"m3"}');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.outgoing_webhook_deliveries WHERE payload ->> 'id' = 'm3' AND webhook_id = pg_temp.wid('bob')),
          0, 'a server webhook whose creator no longer manages webhooks takes nothing');

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
SELECT is((SELECT count(*)::int FROM public.claim_outgoing_webhook_delivery((SELECT id FROM d194))),
          0, 'and not due for 30 seconds');
UPDATE public.outgoing_webhook_deliveries SET attempts = 7, next_attempt_at = now() WHERE id = (SELECT id FROM d194);
SELECT is(public.record_outgoing_webhook_attempt((SELECT id FROM d194), false, 500, 'boom'),
          'failed', 'the eighth failure ends it');
SELECT is(public.record_outgoing_webhook_attempt(
              (SELECT d.id FROM public.outgoing_webhook_deliveries d WHERE d.payload ->> 'id' = 'm1' AND d.webhook_id = pg_temp.wid('server')),
              true, 204, NULL),
          'delivered', 'a success delivers it');
SELECT is((SELECT failing_since FROM public.outgoing_webhooks WHERE id = pg_temp.wid('server')), NULL,
          'and clears the webhook''s failures');

UPDATE public.outgoing_webhooks SET failing_since = now() - interval '4 days' WHERE id = pg_temp.wid('bot');
SELECT public.record_outgoing_webhook_attempt(
    (SELECT d.id FROM public.outgoing_webhook_deliveries d WHERE d.payload ->> 'user' = 'u' AND d.webhook_id = pg_temp.wid('server')),
    true, 200, NULL);
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
