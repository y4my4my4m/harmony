-- Server AutoMod, member timeouts and instance anti-spam after 20261005100001_server_automod.sql.
--
-- Server A (alice owns it) is created inside the test, so it receives the recommended preset.
-- Members: bob, carol (holds "trusted"), dave, erin, frank, gina, hank, ivan (holds "managers":
-- MANAGE_SERVER, TIMEOUT_MEMBERS) and remote (a federated profile). mallory is not a member.
-- Server B is bob's.
-- now() is fixed for the transaction, so every row written here falls inside every rate window;
-- user ids are split per section to keep the counts independent.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(101);

-- Fixture ---------------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('a5a00000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@test.local'),
  ('a5a00000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave@test.local'),
  ('a5a00000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin@test.local'),
  ('a5a00000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank@test.local'),
  ('a5a00000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gina@test.local'),
  ('a5a00000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hank@test.local'),
  ('a5a00000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ivan@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('a5b00000-0000-0000-0000-000000000003', 'a5a00000-0000-0000-0000-000000000003', 'carol', 'Carol', true),
  ('a5b00000-0000-0000-0000-000000000004', 'a5a00000-0000-0000-0000-000000000004', 'dave', 'Dave', true),
  ('a5b00000-0000-0000-0000-000000000005', 'a5a00000-0000-0000-0000-000000000005', 'erin', 'Erin', true),
  ('a5b00000-0000-0000-0000-000000000006', 'a5a00000-0000-0000-0000-000000000006', 'frank', 'Frank', true),
  ('a5b00000-0000-0000-0000-000000000007', 'a5a00000-0000-0000-0000-000000000007', 'gina', 'Gina', true),
  ('a5b00000-0000-0000-0000-000000000008', 'a5a00000-0000-0000-0000-000000000008', 'hank', 'Hank', true),
  ('a5b00000-0000-0000-0000-00000000000a', 'a5a00000-0000-0000-0000-00000000000a', 'ivan', 'Ivan', true);
INSERT INTO public.profiles (id, username, display_name, is_local, domain) VALUES
  ('a5b00000-0000-0000-0000-000000000009', 'remote', 'Remote', false, 'remote.example'),
  ('a5b00000-0000-0000-0000-000000000011', 'joiner1', 'J1', true, 'localhost'),
  ('a5b00000-0000-0000-0000-000000000012', 'joiner2', 'J2', true, 'localhost'),
  ('a5b00000-0000-0000-0000-000000000013', 'joiner3', 'J3', true, 'localhost');

INSERT INTO public.servers (id, name, owner) VALUES
  ('a5c00000-0000-0000-0000-000000000001', 'AutoMod A', '11111111-0000-0000-0000-000000000001'),
  ('a5c00000-0000-0000-0000-000000000002', 'AutoMod B', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.servers (id, name, owner, is_local_server, host_domain) VALUES
  ('a5c00000-0000-0000-0000-000000000003', 'Remote S', '11111111-0000-0000-0000-000000000001', false, 'remote.example');

INSERT INTO public.channel_categories (id, server_id, name) VALUES
  ('a5e00000-0000-0000-0000-000000000001', 'a5c00000-0000-0000-0000-000000000001', 'quiet');
INSERT INTO public.channels (id, server_id, name, type, category) VALUES
  ('a5d00000-0000-0000-0000-000000000001', 'a5c00000-0000-0000-0000-000000000001', 'chat', 0, NULL),
  ('a5d00000-0000-0000-0000-000000000002', 'a5c00000-0000-0000-0000-000000000001', 'mod-log', 0, NULL),
  ('a5d00000-0000-0000-0000-000000000003', 'a5c00000-0000-0000-0000-000000000001', 'other', 0, NULL),
  ('a5d00000-0000-0000-0000-000000000004', 'a5c00000-0000-0000-0000-000000000001', 'third', 0, NULL),
  ('a5d00000-0000-0000-0000-000000000005', 'a5c00000-0000-0000-0000-000000000001', 'exempt', 0, NULL),
  ('a5d00000-0000-0000-0000-000000000006', 'a5c00000-0000-0000-0000-000000000001', 'in-quiet', 0, 'a5e00000-0000-0000-0000-000000000001');

INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('a5f00000-0000-0000-0000-000000000001', 'a5c00000-0000-0000-0000-000000000001', 'trusted', 1, 0),
  ('a5f00000-0000-0000-0000-000000000002', 'a5c00000-0000-0000-0000-000000000001', 'managers', 2, 2176),
  ('a5f00000-0000-0000-0000-000000000003', 'a5c00000-0000-0000-0000-000000000002', 'b-role', 1, 0);

-- Raid detection would otherwise count the joins below.
UPDATE public.server_automod_settings
   SET raid_settings = raid_settings || '{"enabled": false}'::jsonb
 WHERE server_id = 'a5c00000-0000-0000-0000-000000000001';

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000003', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000004', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000005', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000006', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000007', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000008', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-00000000000a', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000009', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'a5c00000-0000-0000-0000-000000000002', 'accepted');

INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('a5b00000-0000-0000-0000-000000000003', 'a5f00000-0000-0000-0000-000000000001', 'a5c00000-0000-0000-0000-000000000001'),
  ('a5b00000-0000-0000-0000-00000000000a', 'a5f00000-0000-0000-0000-000000000002', 'a5c00000-0000-0000-0000-000000000001');

INSERT INTO public.invites (code, server_id, created_by) VALUES
  ('OWNCODE1', 'a5c00000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
  ('OTHERCODE', 'a5c00000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002');

-- alice is the instance admin for the anti-spam section.
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.bots (id, username, display_name, owner_id)
VALUES ('a5900000-0000-0000-0000-000000000001', 'modbot', 'Mod Bot', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.post(p_user uuid, p_channel uuid, p_content jsonb,
                             p_system boolean DEFAULT false, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
  VALUES (p_channel, p_user, p_content, p_system, p_meta);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- A client row carrying its own created_at.
CREATE FUNCTION pg_temp.post_at(p_user uuid, p_channel uuid, p_text text)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content, created_at)
  VALUES (p_channel, p_user, jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)),
          '2001-01-01T00:00:00Z');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE FUNCTION pg_temp.say(p_user uuid, p_channel uuid, p_text text)
RETURNS integer LANGUAGE sql AS $fn$
  SELECT pg_temp.post(p_user, p_channel, jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)));
$fn$;

-- The texts that got through.
CREATE FUNCTION pg_temp.leaks(p_user uuid, p_channel uuid, p_texts text[])
RETURNS text[] LANGUAGE plpgsql AS $fn$
DECLARE t text; out text[] := '{}';
BEGIN
  FOREACH t IN ARRAY p_texts LOOP
    IF pg_temp.say(p_user, p_channel, t) > 0 THEN out := out || t; END IF;
  END LOOP;
  RETURN out;
END $fn$;

CREATE FUNCTION pg_temp.mentions(p_n integer) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_agg(jsonb_build_object('type', 'mention', 'userId', gen_random_uuid()::text, 'username', 'u' || g))
    FROM generate_series(1, p_n) g;
$fn$;

-- A server A rule as upsert_server_automod_rule takes it; the tables are closed to clients.
CREATE FUNCTION pg_temp.rule(p_type text, p_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT jsonb_build_object('id', r.id, 'name', r.name, 'rule_type', r.rule_type, 'enabled', r.enabled,
                            'config', r.config, 'actions', r.actions,
                            'exempt_role_ids', to_jsonb(r.exempt_role_ids),
                            'exempt_channel_ids', to_jsonb(r.exempt_channel_ids))
    FROM public.server_automod_rules r
   WHERE r.server_id = 'a5c00000-0000-0000-0000-000000000001'
     AND r.rule_type = p_type AND (p_name IS NULL OR r.name = p_name)
   LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION pg_temp.post(uuid, uuid, jsonb, boolean, jsonb), pg_temp.say(uuid, uuid, text),
                         pg_temp.leaks(uuid, uuid, text[]), pg_temp.mentions(integer),
                         pg_temp.rule(text, text), pg_temp.post_at(uuid, uuid, text)
    TO authenticated, service_role;

-- Defaults --------------------------------------------------------------------------------
SELECT is((SELECT enabled FROM public.server_automod_settings WHERE server_id = 'a5c00000-0000-0000-0000-000000000001'),
          true, 'a new local server gets AutoMod enabled');
SELECT results_eq(
    $q$SELECT rule_type FROM public.server_automod_rules
        WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND enabled ORDER BY position$q$,
    $q$VALUES ('mention_spam'), ('message_flood'), ('duplicate_spam')$q$,
    'the recommended preset enables mention spam, flood and duplicate rules');
SELECT results_eq(
    $q$SELECT rule_type FROM public.server_automod_rules
        WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND NOT enabled ORDER BY position$q$,
    $q$VALUES ('invites'), ('keyword_preset'), ('new_member')$q$,
    'invites, the slur preset and new-member restrictions ship disabled');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.server_automod_settings WHERE server_id = 'a5c00000-0000-0000-0000-000000000003'),
          'a remote server gets no AutoMod settings');

-- A server from before the migration has no settings row.
DELETE FROM public.server_automod_rules WHERE server_id = '55555555-0000-0000-0000-000000000005';
DELETE FROM public.server_automod_settings WHERE server_id = '55555555-0000-0000-0000-000000000005';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.post('22222222-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', pg_temp.mentions(30)),
          1, 'an unconfigured server is not moderated');
SELECT throws_ok($q$SELECT public.get_server_automod('a5c00000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a member without MANAGE_SERVER cannot read AutoMod rules');
SELECT throws_ok($q$SELECT public.automod_check_message(m, 'INSERT', 'postgres') FROM public.messages m LIMIT 1$q$,
                 '42501', NULL, 'automod_check_message refuses a direct call');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_server_automod('55555555-0000-0000-0000-000000000005') ->> 'status', 'unconfigured',
          'the owner sees an existing server as unconfigured');
SELECT is(public.enable_server_automod_preset('55555555-0000-0000-0000-000000000005') ->> 'status', 'enabled',
          'the opt-in installs and enables the preset');
SELECT is(public.get_server_automod('a5c00000-0000-0000-0000-000000000001') ->> 'status', 'enabled',
          'the owner reads AutoMod state');

-- Privileges ------------------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT is_empty(
    $q$SELECT table_name, grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('server_automod_settings', 'server_automod_rules', 'server_member_timeouts',
                             'automod_events', 'suspicious_activity', 'automod_fingerprints')
          AND grantee IN ('anon', 'authenticated', 'PUBLIC')$q$,
    'clients hold no table privileges on AutoMod tables');
SELECT is_empty(
    $q$SELECT p.oid::regprocedure FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND (p.proname LIKE 'automod\_%' OR p.proname LIKE 'antispam\_%')
          AND p.proname <> 'automod_check_message'
          AND (has_function_privilege('anon', p.oid, 'EXECUTE')
               OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))$q$,
    'internal AutoMod and anti-spam functions are not executable by clients');
SELECT is_empty(
    $q$SELECT p.oid::regprocedure FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('get_server_automod', 'update_server_automod_settings', 'upsert_server_automod_rule',
                            'set_server_member_timeout', 'get_suspicious_activity', 'review_suspicious_activity',
                            'automod_check_message')
          AND has_function_privilege('anon', p.oid, 'EXECUTE')$q$,
    'anon executes no AutoMod RPC');

-- Keywords --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.update_server_automod_settings('a5c00000-0000-0000-0000-000000000001',
                   '{"alert_channel_id": "a5d00000-0000-0000-0000-000000000002"}'::jsonb)$q$,
                'the owner sets an alert channel');
SELECT throws_ok($q$SELECT public.update_server_automod_settings('a5c00000-0000-0000-0000-000000000001',
                    '{"alert_channel_id": "66666666-0000-0000-0000-000000000006"}'::jsonb)$q$,
                 '22023', NULL, 'the alert channel must belong to the server');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   '{"name": "Words", "rule_type": "keyword",
                     "config": {"keywords": ["badword", "scam*", "free nitro"]},
                     "actions": {"block": true, "alert": true, "block_message": "Keep it clean."}}'::jsonb)$q$,
                'the owner adds a keyword rule');
SELECT set_config('tests.words_rule', pg_temp.rule('keyword', 'Words') ->> 'id', true);

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.say('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001', 'this is a BADWORD'),
          0, 'a keyword is blocked regardless of case');
SELECT is(pg_temp.leaks('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001', ARRAY[
              'b a d w o r d', 'b.a.d.w.o.r.d', 'bаdwоrd', E'bad\u200bword', E'b\u00adadw\u2060ord',
              'ＢＡＤＷＯＲＤ', '𝐛𝐚𝐝𝐰𝐨𝐫𝐝', 'ⓑⓐⓓⓦⓞⓡⓓ', 'baaaadwoooord', 'b4dw0rd', E'b\u0337a\u0337d\u0337w\u0337o\u0337r\u0337d\u0337', 'ʙᴀᴅᴡᴏʀᴅ',
              'βadwοrd', 'bad.word', 'bad-word', 'SCAMMER alert', 'Free   Nitro here', 'free-nitro']),
          '{}'::text[], 'case, spacing, homoglyph, zero-width, compatibility-form, repeat and leetspeak variants are blocked');
SELECT is(pg_temp.leaks('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001', ARRAY[
              'badwords are a whole other word', 'I am a cat', 'the bad words', 'nitrogen is free']),
          ARRAY['badwords are a whole other word', 'I am a cat', 'the bad words', 'nitrogen is free'],
          'whole-word keywords leave longer words and unrelated text alone');

-- Clients cannot write system rows or server-only metadata (20261005600001); AutoMod never
-- sees either.
SELECT throws_ok($q$SELECT pg_temp.post('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001',
                       '[{"type":"text","text":"badword"}]'::jsonb, true, '{"type":"group_created"}'::jsonb)$q$,
          '42501', NULL, 'a client cannot write an is_system row');
SELECT throws_ok($q$SELECT pg_temp.post('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001',
                       '[{"type":"text","text":"badword"}]'::jsonb, false, '{"federated": true, "bot": true}'::jsonb)$q$,
          '42501', NULL, 'metadata claiming federation or a bot is refused');

SELECT is(pg_temp.say('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001', 'hello there'),
          1, 'a clean message is written');
SELECT set_config('tests.bob_msg', (SELECT id::text FROM public.messages
                                      WHERE user_id = '22222222-0000-0000-0000-000000000002'
                                        AND content = '[{"type":"text","text":"hello there"}]'::jsonb LIMIT 1), true);
UPDATE public.messages SET content = '[{"type":"text","text":"now a b.a.d.w.o.r.d"}]'::jsonb
 WHERE id = current_setting('tests.bob_msg')::uuid;
SELECT is((SELECT content ->> 0 FROM public.messages WHERE id = current_setting('tests.bob_msg')::uuid),
          '{"text": "hello there", "type": "text"}', 'an edit that adds a banned word is dropped');

SELECT throws_ok($q$SELECT pg_temp.say('a5b00000-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000001', 'badword')$q$,
                 '42501', NULL, 'a row naming another author is left to RLS, not dropped');

SELECT results_eq(
    $q$SELECT public.get_automod_block_notice('a5d00000-0000-0000-0000-000000000001') ->> 'rule_type',
              public.get_automod_block_notice('a5d00000-0000-0000-0000-000000000001') ->> 'message'$q$,
    $q$VALUES ('keyword'::text, 'Keep it clean.'::text)$q$,
    'the author reads the block reason and the rule''s message');

SELECT set_config('request.headers', '{"accept":"application/vnd.pgrst.object+json"}', true);
SELECT throws_like($q$SELECT pg_temp.say('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000001', 'badword')$q$,
                   'AUTOMOD_BLOCKED%', 'a singular PostgREST request is answered with an error');
SELECT set_config('request.headers', '{}', true);

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT pg_temp.say('33333333-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000001', 'badword')$q$,
                 '42501', NULL, 'a non-member''s blocked word still fails RLS');

SELECT tests.clear_authentication();
-- 19: the two client rows refused by the write guard above never reach AutoMod.
SELECT results_eq(
    $q$SELECT event_type, hits, actions FROM public.automod_events
        WHERE user_id = '22222222-0000-0000-0000-000000000002' AND rule_id = current_setting('tests.words_rule')::uuid
        ORDER BY event_type$q$,
    $q$VALUES ('edit'::text, 1, ARRAY['alert', 'block']), ('message'::text, 19, ARRAY['alert', 'block'])$q$,
    'repeats within 30 s fold into one event per kind');
SELECT is((SELECT count(*)::integer FROM public.messages
            WHERE channel_id = 'a5d00000-0000-0000-0000-000000000002'
              AND metadata ->> 'type' = 'automod_alert' AND user_id IS NULL AND is_system),
          2, 'one authorless alert is posted per event');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.automod_events WHERE user_id IN ('a5b00000-0000-0000-0000-000000000003',
                                                                           '33333333-0000-0000-0000-000000000003')),
          'no event is recorded against a framed author or a non-member');

-- Exemptions ------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.say('11111111-0000-0000-0000-000000000001', 'a5d00000-0000-0000-0000-000000000001', 'badword'),
          1, 'the owner is exempt');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   jsonb_build_object('id', current_setting('tests.words_rule'), 'name', 'Words', 'rule_type', 'keyword',
                     'config', '{"keywords": ["badword", "scam*", "free nitro"]}'::jsonb,
                     'actions', '{"block": true, "alert": true}'::jsonb,
                     'exempt_role_ids', '["a5f00000-0000-0000-0000-000000000001"]'::jsonb,
                     'exempt_channel_ids', '["a5d00000-0000-0000-0000-000000000005", "a5e00000-0000-0000-0000-000000000001"]'::jsonb))$q$,
                'the owner exempts a role, a channel and a category');
SELECT throws_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                    '{"name": "x", "rule_type": "keyword", "config": {"keywords": ["x"]},
                      "exempt_role_ids": ["a5f00000-0000-0000-0000-000000000003"]}'::jsonb)$q$,
                 '22023', NULL, 'an exempt role from another server is rejected');

SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000003');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000001', 'badword'),
          1, 'an exempt role passes the rule');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.say('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000005', 'badword')
          + pg_temp.say('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000006', 'badword'),
          2, 'exempt channels and channels in an exempt category pass the rule');
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-00000000000a');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-00000000000a', 'a5d00000-0000-0000-0000-000000000001', 'badword'),
          1, 'a MANAGE_SERVER holder is exempt');

-- Regex, presets, validation --------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   '{"name": "Patterns", "rule_type": "keyword",
                     "config": {"regex_patterns": ["(free|cheap)\\s*(nitro|robux)"]}}'::jsonb)$q$,
                'the owner adds a regex rule');
SELECT throws_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                    '{"name": "Bad", "rule_type": "keyword", "config": {"regex_patterns": ["(unclosed"]}}'::jsonb)$q$,
                 '22023', NULL, 'an invalid regular expression is rejected');
SELECT throws_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                    '{"name": "Bad", "rule_type": "keyword", "config": {"regex_patterns": ["(a+)\\1"]}}'::jsonb)$q$,
                 '22023', NULL, 'a back-reference is rejected');
SELECT throws_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                    '{"name": "Bad", "rule_type": "nope"}'::jsonb)$q$,
                 '22023', NULL, 'an unknown rule type is rejected');
SELECT throws_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                    '{"name": "Bad", "rule_type": "invites", "actions": {"block": false, "alert": false}}'::jsonb)$q$,
                 '22023', NULL, 'a rule without an action is rejected');
SELECT throws_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                    '{"name": "Bad", "rule_type": "invites", "actions": {"timeout_seconds": 2419201}}'::jsonb)$q$,
                 '22023', NULL, 'a timeout beyond 28 days is rejected');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   '{"name": "Swearing", "rule_type": "keyword_preset",
                     "config": {"presets": ["profanity"], "allow_list": ["fucking"]}}'::jsonb)$q$,
                'the owner enables the profanity preset with an allowed word');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.leaks('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000003', ARRAY[
              'get CHEAP   robux now', 'Fuuuuck this', 'what the f.u.c.k', 'sh1t happens', 'this is fucking great',
              'a cockpit and a scunthorpe class assessment']),
          ARRAY['this is fucking great', 'a cockpit and a scunthorpe class assessment'],
          'regex and preset rules block; allowed words and embedded substrings pass');

-- Mention spam ----------------------------------------------------------------------------
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000003');
SELECT is(pg_temp.post('a5b00000-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000003', pg_temp.mentions(21)),
          0, 'more than 20 unique mentions are blocked');
SELECT is(pg_temp.post('a5b00000-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000003', pg_temp.mentions(20)),
          1, 'twenty mentions pass');
SELECT is(pg_temp.post('a5b00000-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000003', pg_temp.mentions(20)),
          1, 'a second batch stays under the 50-per-minute window');
SELECT is(pg_temp.post('a5b00000-0000-0000-0000-000000000003', 'a5d00000-0000-0000-0000-000000000003', pg_temp.mentions(11)),
          0, 'the mention window blocks a mention raid spread across messages');

-- Flood and duplicates --------------------------------------------------------------------
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000004');
-- Five of dave's messages claim a created_at in 2001; rate rules count insert time.
SELECT is((SELECT sum(pg_temp.say('a5b00000-0000-0000-0000-000000000004', 'a5d00000-0000-0000-0000-000000000003', 'msg ' || g))
             FROM generate_series(1, 5) g)::integer
          + (SELECT count(*)::integer FROM generate_series(6, 10) g,
                    LATERAL (SELECT pg_temp.post_at('a5b00000-0000-0000-0000-000000000004',
                                                    'a5d00000-0000-0000-0000-000000000003', 'msg ' || g)) x
              WHERE x.post_at = 1),
          10, 'ten messages inside the window pass');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000004', 'a5d00000-0000-0000-0000-000000000004', 'msg 11'),
          0, 'the eleventh message in 10 s is blocked in any channel, backdated rows included');
SELECT tests.clear_authentication();
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000004', 'a5d00000-0000-0000-0000-000000000004', 'imported'),
          1, 'rows written by postgres are not rate-limited');

SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000005');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000005', 'a5d00000-0000-0000-0000-000000000001', 'Visit my brand new stream')
          + pg_temp.say('a5b00000-0000-0000-0000-000000000005', 'a5d00000-0000-0000-0000-000000000003', 'visit my BRAND new stream'),
          2, 'the same text in two channels passes');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000005', 'a5d00000-0000-0000-0000-000000000004', E'Visit my brand\u200b new stream'),
          0, 'the same text in a third channel is blocked');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000005', 'a5d00000-0000-0000-0000-000000000004', 'something else entirely'),
          1, 'different text in the third channel passes');

-- The remaining sections post from fewer accounts than the flood rule allows for.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   pg_temp.rule('message_flood') || '{"enabled": false}'::jsonb)$q$,
                'the owner turns the flood rule off');

-- Timeouts --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   jsonb_build_object('id', current_setting('tests.words_rule'), 'name', 'Words', 'rule_type', 'keyword',
                     'config', '{"keywords": ["badword"]}'::jsonb,
                     'actions', '{"block": true, "alert": false, "timeout_seconds": 600}'::jsonb))$q$,
                'the owner adds a 10-minute timeout to the keyword rule');

SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000006');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000006', 'a5d00000-0000-0000-0000-000000000001', 'first, all fine'),
          1, 'frank posts before the timeout');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000006', 'a5d00000-0000-0000-0000-000000000001', 'badword'),
          0, 'the matching message is blocked');
SELECT tests.clear_authentication();
SELECT ok((SELECT until > now() + interval '9 minutes' AND source = 'automod'
             FROM public.server_member_timeouts
            WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND user_id = 'a5b00000-0000-0000-0000-000000000006'),
          'the rule times the author out');
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000006');
SELECT throws_like($q$SELECT pg_temp.say('a5b00000-0000-0000-0000-000000000006', 'a5d00000-0000-0000-0000-000000000003', 'hello')$q$,
                   'MEMBER_TIMED_OUT:%', 'a timed-out member cannot post');
SELECT throws_like($q$UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'::jsonb
                       WHERE user_id = 'a5b00000-0000-0000-0000-000000000006' AND is_system IS NOT TRUE$q$,
                   'MEMBER_TIMED_OUT:%', 'a timed-out member cannot edit');
SELECT tests.clear_authentication();
SELECT lives_ok($q$DELETE FROM public.user_servers
                    WHERE user_id = 'a5b00000-0000-0000-0000-000000000006'
                      AND server_id = 'a5c00000-0000-0000-0000-000000000001'$q$,
                'a timed-out member can still leave; the leave notice is not blocked');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('a5c00000-0000-0000-0000-000000000001',
                    'a5b00000-0000-0000-0000-000000000004', 60)$q$,
                 '42501', NULL, 'TIMEOUT_MEMBERS is required to time someone out');
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-00000000000a');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('a5c00000-0000-0000-0000-000000000001',
                    '11111111-0000-0000-0000-000000000001', 60)$q$,
                 '42501', NULL, 'a moderator cannot time out the server owner');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('a5c00000-0000-0000-0000-000000000001',
                   'a5b00000-0000-0000-0000-000000000005', 60, 'cool down')$q$,
                'the owner times erin out');
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000005');
SELECT throws_like($q$SELECT pg_temp.say('a5b00000-0000-0000-0000-000000000005', 'a5d00000-0000-0000-0000-000000000003', 'hi')$q$,
                   'MEMBER_TIMED_OUT:%', 'a moderator timeout blocks posting');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('a5c00000-0000-0000-0000-000000000001',
                   'a5b00000-0000-0000-0000-000000000005', 0)$q$,
                'the owner lifts the timeout');
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000005');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000005', 'a5d00000-0000-0000-0000-000000000003', 'back again'),
          1, 'a lifted timeout lets the member post');

-- Bots and federation ---------------------------------------------------------------------
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
INSERT INTO public.messages (channel_id, bot_id, content)
VALUES ('a5d00000-0000-0000-0000-000000000001', 'a5900000-0000-0000-0000-000000000001', '[{"type":"text","text":"badword from a bot"}]');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.messages
            WHERE bot_id = 'a5900000-0000-0000-0000-000000000001' AND channel_id = 'a5d00000-0000-0000-0000-000000000001'),
          1, 'bots are exempt by default');
UPDATE public.server_automod_settings SET exempt_bots = false WHERE server_id = 'a5c00000-0000-0000-0000-000000000001';
SET LOCAL ROLE service_role;
INSERT INTO public.messages (channel_id, bot_id, content)
VALUES ('a5d00000-0000-0000-0000-000000000001', 'a5900000-0000-0000-0000-000000000001', '[{"type":"text","text":"badword again"}]');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.messages
            WHERE bot_id = 'a5900000-0000-0000-0000-000000000001' AND channel_id = 'a5d00000-0000-0000-0000-000000000001'),
          1, 'with exempt_bots off a bot''s blocked word is dropped');
SELECT ok(EXISTS (SELECT 1 FROM public.automod_events
                   WHERE bot_id = 'a5900000-0000-0000-0000-000000000001' AND user_id IS NULL AND 'block' = ANY (actions)),
          'the bot block is recorded');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.get_server_automod_events('a5c00000-0000-0000-0000-000000000001')) e
                   WHERE e ->> 'bot_name' = 'Mod Bot'),
          'the AutoMod log names the bot');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, bot_id, content)
                    VALUES ('a5d00000-0000-0000-0000-000000000001', 'a5900000-0000-0000-0000-000000000001',
                            '[{"type":"text","text":"posing as a bot"}]')$q$,
                 '42501', NULL, 'a client cannot write a bot-authored row');

SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
INSERT INTO public.messages (channel_id, user_id, content, metadata)
VALUES ('a5d00000-0000-0000-0000-000000000001', 'a5b00000-0000-0000-0000-000000000009',
        '[{"type":"text","text":"remote BADWORD"}]', '{"federated": true}');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages WHERE user_id = 'a5b00000-0000-0000-0000-000000000009'
                         AND content::text ILIKE '%badword%')
          AND EXISTS (SELECT 1 FROM public.automod_events WHERE user_id = 'a5b00000-0000-0000-0000-000000000009'),
          'a federated author''s blocked message is dropped and recorded');

-- Invites, links, new members -------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   pg_temp.rule('invites') || '{"enabled": true}'::jsonb)$q$,
                'the owner turns the invite filter on');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.leaks('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000004', ARRAY[
              'join discord.gg/abc123', 'https://discord.com/invite/xyz', 'come to https://mony.dev/invite/OTHERCODE',
              'other.example/invite/zzz', 'our own https://mony.dev/invite/OWNCODE1', 'no invite here']),
          ARRAY['our own https://mony.dev/invite/OWNCODE1', 'no invite here'],
          'invites to other servers are blocked; the server''s own invite passes');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   '{"name": "Links", "rule_type": "links", "config": {"mode": "allow_list", "domains": ["example.com"]}}'::jsonb)$q$,
                'the owner allows links to one domain');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.leaks('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000004', ARRAY[
              'docs at https://docs.example.com/page', 'see https://evil.test/x', 'go to evil.xyz now',
              'www.notexample.com', 'open file.txt please', 'email me at me@example.org']),
          ARRAY['docs at https://docs.example.com/page', 'open file.txt please', 'email me at me@example.org'],
          'the link allow-list passes listed domains and blocks the rest');
SELECT is(pg_temp.post('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000004',
                       '[{"type":"url","url":"https://evil.test/page","preview":true}]'::jsonb),
          0, 'url parts are checked too');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.delete_server_automod_rule((pg_temp.rule('links', 'Links') ->> 'id')::uuid)$q$,
                'the owner deletes the links rule');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a5c00000-0000-0000-0000-000000000001',
                   pg_temp.rule('new_member')
                   || '{"enabled": true, "config": {"restrict_links": true, "restrict_attachments": true}}'::jsonb)$q$,
                'the owner turns new-member restrictions on');
SELECT tests.clear_authentication();
UPDATE public.profiles SET created_at = now() - interval '2 days' WHERE id = '22222222-0000-0000-0000-000000000002';
UPDATE public.user_servers SET created_at = now() - interval '2 days'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = 'a5c00000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000007');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000007', 'a5d00000-0000-0000-0000-000000000004', 'see https://example.org')
          + pg_temp.post('a5b00000-0000-0000-0000-000000000007', 'a5d00000-0000-0000-0000-000000000004',
                         '[{"type":"file","url":"https://x/y.png","fileType":"image"}]'::jsonb),
          0, 'a new account that just joined cannot post links or attachments');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000007', 'a5d00000-0000-0000-0000-000000000004', 'just words'),
          1, 'a new member''s plain text passes');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.say('22222222-0000-0000-0000-000000000002', 'a5d00000-0000-0000-0000-000000000004', 'see https://example.org'),
          1, 'an established member posts links');

-- Raid detection --------------------------------------------------------------------------
SELECT tests.clear_authentication();
UPDATE public.server_automod_settings
   SET raid_settings = '{"enabled": true, "join_threshold": 3, "window_seconds": 60, "action": "slowmode", "slowmode_seconds": 30}'::jsonb
 WHERE server_id = 'a5c00000-0000-0000-0000-000000000001';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('a5b00000-0000-0000-0000-000000000011', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000012', 'a5c00000-0000-0000-0000-000000000001', 'accepted'),
  ('a5b00000-0000-0000-0000-000000000013', 'a5c00000-0000-0000-0000-000000000001', 'accepted');
SELECT is((SELECT count(*)::integer FROM public.automod_events
            WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND event_type = 'raid'),
          1, 'a join spike records one raid event');
SELECT is((SELECT count(*)::integer FROM public.channels
            WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND type = 0 AND slowmode_seconds = 30),
          (SELECT count(*)::integer FROM public.channels WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND type = 0),
          'the slowmode raid action slows every text channel');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_raid_lockdown('a5c00000-0000-0000-0000-000000000001', false) -> 'settings' -> 'raid_state' ->> 'active',
          'false', 'the owner lifts the lockdown');
SELECT is((SELECT count(*)::integer FROM public.channels
            WHERE server_id = 'a5c00000-0000-0000-0000-000000000001' AND slowmode_seconds <> 0),
          0, 'lifting restores the previous slowmode');

-- Instance anti-spam ----------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.update_instance_antispam_settings('{"new_account_messages_per_minute": 1}'::jsonb)$q$,
                 '42501', NULL, 'only instance admins change anti-spam settings');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.update_instance_antispam_settings(
              '{"new_account_messages_per_minute": 2, "new_account_block_links": true,
                "new_account_max_stranger_mentions": 1, "new_account_posts_per_hour": 5}'::jsonb)
              ->> 'new_account_messages_per_minute',
          '2', 'an admin sets new-account limits');
SELECT throws_ok($q$SELECT public.update_instance_antispam_settings('{"federation_spam_mode": "nuke"}'::jsonb)$q$,
                 '22023', NULL, 'an unknown federation mode is rejected');

SELECT tests.authenticate_as('a5a00000-0000-0000-0000-000000000008');
SELECT is(pg_temp.say('a5b00000-0000-0000-0000-000000000008', 'a5d00000-0000-0000-0000-000000000003', 'one')
          + pg_temp.say('a5b00000-0000-0000-0000-000000000008', 'a5d00000-0000-0000-0000-000000000004', 'two'),
          2, 'a new account sends up to the per-minute limit');
SELECT throws_like($q$SELECT pg_temp.say('a5b00000-0000-0000-0000-000000000008', 'a5d00000-0000-0000-0000-000000000003', 'three')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next message is rate-limited');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.say('11111111-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', 'https://example.org'),
          1, 'instance admins are not limited');

SELECT tests.authenticate_as('a5a00000-0000-0000-0000-00000000000a');
SELECT throws_like($q$SELECT pg_temp.say('a5b00000-0000-0000-0000-00000000000a', 'a5d00000-0000-0000-0000-000000000003', 'see evil.xyz')$q$,
                   'ANTISPAM_LINKS_BLOCKED%', 'a new account cannot post links');
SELECT throws_like($q$INSERT INTO public.posts (author_id, content) VALUES ('a5b00000-0000-0000-0000-00000000000a',
                       '[{"type":"text","text":"hi "},
                         {"type":"mention","userId":"11111111-0000-0000-0000-000000000001","username":"alice"},
                         {"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob"}]'::jsonb)$q$,
                   'ANTISPAM_STRANGER_MENTIONS:%', 'a new account cannot mention more strangers than allowed');
SELECT lives_ok($q$INSERT INTO public.posts (author_id, content) VALUES ('a5b00000-0000-0000-0000-00000000000a',
                       '[{"type":"text","text":"hi "},
                         {"type":"mention","userId":"11111111-0000-0000-0000-000000000001","username":"alice"}]'::jsonb)$q$,
                'one stranger mention is within the limit');

-- Suspicious activity queue ---------------------------------------------------------------
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
INSERT INTO public.suspicious_activity (id, kind, action, actor_id, actor_uri, actor_domain, target_ids, reasons,
                                        activity_id, activity, summary)
VALUES ('a5700000-0000-0000-0000-000000000001', 'federation_mention', 'held', 'a5b00000-0000-0000-0000-000000000009',
        'https://remote.example/users/remote', 'remote.example', ARRAY['22222222-0000-0000-0000-000000000002'::uuid],
        ARRAY['new_actor', 'no_relationship'], 'https://remote.example/activities/1',
        '{"type": "Create", "id": "https://remote.example/activities/1"}', 'buy cheap pills');
RESET ROLE;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.get_suspicious_activity()$q$, '42501', NULL,
                 'a regular user cannot read the suspicious-activity queue');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_suspicious_activity() -> 0 ->> 'actor_username', 'remote', 'an admin reads the queue');
SELECT is(public.review_suspicious_activity('a5700000-0000-0000-0000-000000000001', 'release') ->> 'status',
          'released', 'an admin releases a held activity');
SELECT throws_ok($q$SELECT public.review_suspicious_activity('a5700000-0000-0000-0000-000000000001', 'release')$q$,
                 '22023', NULL, 'a held activity is released once');

SELECT * FROM finish();
ROLLBACK;
