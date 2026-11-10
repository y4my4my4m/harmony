-- 20261110400001_bot_slash_commands.sql: command registration, the member list and invocation,
-- delivery and answers, the push, RLS, the reserved metadata key and AutoMod for answers.
--
-- Server S (alice owns it):
--   bob      member, role speakers
--   carol    member, role speakers, account two days old
--   dave     member, timed out
--   erin     member, role mods (BAN_MEMBERS, MANAGE_MESSAGES)
--   frank    pending
--   gina     member
--   hal      member
--   mallory  not a member
--   botdev   owns every bot, member of nothing
-- Channels of S: gen; hid (@everyone denies VIEW_CHANNEL); nos (denies SEND_MESSAGES); slow
-- (slowmode 30 s); voice (type 1); botc (@everyone denies SEND_MESSAGES, speakers allow it);
-- thr (@everyone denies SEND_MESSAGES_IN_THREADS); priv (@everyone denies VIEW_CHANNEL, speakers
-- allow VIEW_CHANNEL and SEND_MESSAGES). Threads: tgen, tlock (locked), tarch (archived) in gen;
-- tthr in thr. SE: encryption required. SC: a copy (is_local_server false). SO: another server.
-- Bots, all installed in S: weather (online, also in SE and SC), quiet (no presence row), stale
-- (heartbeat 2 min old), sleepy (status offline), retired (bot inactive), removed (install
-- inactive), listed (allowed_channel_ids botc), mute (send_messages off), other (online), bulk (not
-- installed).
-- now() is fixed for the transaction, so every invocation falls in every window; sections delete
-- the rows they leave.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(206);

-- Assertions also run as the service role.
GRANT USAGE ON SCHEMA tests TO service_role;
CREATE TEMP TABLE out257 (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out257 TO PUBLIC;

-- Fixture -----------------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('a2570000-0000-0000-0000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 'u' || n || '@e257.test'
  FROM generate_series(1, 7) n;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2571000-0000-0000-0000-000000000001', 'a2570000-0000-0000-0000-000000000001', 'carol257', 'Carol', true),
  ('f2571000-0000-0000-0000-000000000002', 'a2570000-0000-0000-0000-000000000002', 'dave257', 'Dave', true),
  ('f2571000-0000-0000-0000-000000000003', 'a2570000-0000-0000-0000-000000000003', 'erin257', 'Erin', true),
  ('f2571000-0000-0000-0000-000000000004', 'a2570000-0000-0000-0000-000000000004', 'frank257', 'Frank', true),
  ('f2571000-0000-0000-0000-000000000005', 'a2570000-0000-0000-0000-000000000005', 'gina257', 'Gina', true),
  ('f2571000-0000-0000-0000-000000000006', 'a2570000-0000-0000-0000-000000000006', 'hal257', 'Hal', true),
  ('f2571000-0000-0000-0000-000000000007', 'a2570000-0000-0000-0000-000000000007', 'botdev257', 'Botdev', true);
UPDATE public.profiles SET created_at = now() - interval '2 days' WHERE id = 'f2571000-0000-0000-0000-000000000001';

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2572000-0000-0000-0000-000000000001', 'Slash', '11111111-0000-0000-0000-000000000001'),
  ('f2572000-0000-0000-0000-000000000002', 'Sealed', '11111111-0000-0000-0000-000000000001'),
  ('f2572000-0000-0000-0000-000000000004', 'Other', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f2572000-0000-0000-0000-000000000003', 'Copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.server_encryption_settings (server_id, encryption_mode) VALUES
  ('f2572000-0000-0000-0000-000000000002', 'required');

INSERT INTO public.user_servers (user_id, server_id, status)
SELECT u, s, CASE WHEN u = 'f2571000-0000-0000-0000-000000000004' THEN 'pending' ELSE 'accepted' END
  FROM unnest(ARRAY['11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
                    'f2571000-0000-0000-0000-000000000001', 'f2571000-0000-0000-0000-000000000002',
                    'f2571000-0000-0000-0000-000000000003', 'f2571000-0000-0000-0000-000000000004',
                    'f2571000-0000-0000-0000-000000000005', 'f2571000-0000-0000-0000-000000000006']::uuid[]) u
 CROSS JOIN (VALUES ('f2572000-0000-0000-0000-000000000001'::uuid)) v(s)
ON CONFLICT (user_id, server_id) DO NOTHING;
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000002', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2572000-0000-0000-0000-000000000002', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000003', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2572000-0000-0000-0000-000000000003', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000004', 'accepted')
ON CONFLICT (user_id, server_id) DO NOTHING;
UPDATE public.user_servers SET nickname = 'Caz'
 WHERE user_id = 'f2571000-0000-0000-0000-000000000001' AND server_id = 'f2572000-0000-0000-0000-000000000001';

-- BAN_MEMBERS is bit 10, MANAGE_MESSAGES bit 21.
INSERT INTO public.server_roles (id, server_id, name, color, position, permissions) VALUES
  ('f2574000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001', 'speakers', '#00ff00', 3, 0),
  ('f2574000-0000-0000-0000-000000000002', 'f2572000-0000-0000-0000-000000000001', 'mods', '#ff0000', 5, 1024 | 2097152),
  ('f2574000-0000-0000-0000-000000000003', 'f2572000-0000-0000-0000-000000000004', 'elsewhere', NULL, 1, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2574000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001'),
  ('f2571000-0000-0000-0000-000000000001', 'f2574000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001'),
  ('f2571000-0000-0000-0000-000000000003', 'f2574000-0000-0000-0000-000000000002', 'f2572000-0000-0000-0000-000000000001');

INSERT INTO public.channels (id, server_id, name, type, slowmode_seconds) VALUES
  ('f2573000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001', 'gen', 0, 0),
  ('f2573000-0000-0000-0000-000000000002', 'f2572000-0000-0000-0000-000000000001', 'hid', 0, 0),
  ('f2573000-0000-0000-0000-000000000003', 'f2572000-0000-0000-0000-000000000001', 'nos', 0, 0),
  ('f2573000-0000-0000-0000-000000000004', 'f2572000-0000-0000-0000-000000000001', 'slow', 0, 30),
  ('f2573000-0000-0000-0000-000000000005', 'f2572000-0000-0000-0000-000000000001', 'voice', 1, 0),
  ('f2573000-0000-0000-0000-000000000006', 'f2572000-0000-0000-0000-000000000001', 'botc', 0, 0),
  ('f2573000-0000-0000-0000-000000000007', 'f2572000-0000-0000-0000-000000000001', 'thr', 0, 0),
  ('f2573000-0000-0000-0000-000000000008', 'f2572000-0000-0000-0000-000000000001', 'priv', 0, 0),
  ('f2573000-0000-0000-0000-000000000009', 'f2572000-0000-0000-0000-000000000002', 'sealed', 0, 0),
  ('f2573000-0000-0000-0000-00000000000a', 'f2572000-0000-0000-0000-000000000003', 'copied', 0, 0),
  ('f2573000-0000-0000-0000-00000000000b', 'f2572000-0000-0000-0000-000000000004', 'elsewhere', 0, 0);

-- VIEW_CHANNEL is bit 1, SEND_MESSAGES bit 12, SEND_MESSAGES_IN_THREADS bit 13.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT c.id, 'role', r.id, NULL, 0, c.deny
  FROM (VALUES ('f2573000-0000-0000-0000-000000000002'::uuid, 2::bigint),
               ('f2573000-0000-0000-0000-000000000003'::uuid, 4096::bigint),
               ('f2573000-0000-0000-0000-000000000006'::uuid, 4096::bigint),
               ('f2573000-0000-0000-0000-000000000007'::uuid, 8192::bigint),
               ('f2573000-0000-0000-0000-000000000008'::uuid, 2::bigint)) c(id, deny)
  JOIN public.server_roles r ON r.server_id = 'f2572000-0000-0000-0000-000000000001' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f2573000-0000-0000-0000-000000000006', 'role', 'f2574000-0000-0000-0000-000000000001', NULL, 4096, 0),
  ('f2573000-0000-0000-0000-000000000008', 'role', 'f2574000-0000-0000-0000-000000000001', NULL, 2 | 4096, 0);

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f2576000-0000-0000-0000-000000000001', 'f2573000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"thread starter"}]'),
  ('f2576000-0000-0000-0000-000000000002', 'f2573000-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"thread starter"}]'),
  ('f2576000-0000-0000-0000-000000000003', 'f2573000-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob was here"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, locked, archived) VALUES
  ('f2575000-0000-0000-0000-000000000001', 'f2573000-0000-0000-0000-000000000001', 'f2576000-0000-0000-0000-000000000001', 'open', '11111111-0000-0000-0000-000000000001', false, false),
  ('f2575000-0000-0000-0000-000000000002', 'f2573000-0000-0000-0000-000000000001', 'f2576000-0000-0000-0000-000000000001', 'locked', '11111111-0000-0000-0000-000000000001', true, false),
  ('f2575000-0000-0000-0000-000000000003', 'f2573000-0000-0000-0000-000000000001', 'f2576000-0000-0000-0000-000000000001', 'archived', '11111111-0000-0000-0000-000000000001', false, true),
  ('f2575000-0000-0000-0000-000000000004', 'f2573000-0000-0000-0000-000000000007', 'f2576000-0000-0000-0000-000000000002', 'denied', '11111111-0000-0000-0000-000000000001', false, false);

INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason)
VALUES ('f2572000-0000-0000-0000-000000000001', 'f2571000-0000-0000-0000-000000000002', now() + interval '1 hour', 'test');

INSERT INTO public.bots (id, username, display_name, avatar_url, owner_id, is_active) VALUES
  ('f2577000-0000-0000-0000-000000000001', 'weather257', 'Weather', 'https://cdn.test/w.png', 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000002', 'quiet257',   'Quiet',   NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000003', 'stale257',   'Stale',   NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000004', 'sleepy257',  'Sleepy',  NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000005', 'retired257', 'Retired', NULL, 'f2571000-0000-0000-0000-000000000007', false),
  ('f2577000-0000-0000-0000-000000000006', 'removed257', 'Removed', NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000007', 'listed257',  'Listed',  NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000008', 'mute257',    'Mute',    NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-000000000009', 'other257',   'Other',   NULL, 'f2571000-0000-0000-0000-000000000007', true),
  ('f2577000-0000-0000-0000-00000000000a', 'bulk257',    'Bulk',    NULL, 'f2571000-0000-0000-0000-000000000007', true);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, is_active, send_messages)
SELECT b, 'f2572000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
       b <> 'f2577000-0000-0000-0000-000000000006', b <> 'f2577000-0000-0000-0000-000000000008'
  FROM unnest(ARRAY['f2577000-0000-0000-0000-000000000001', 'f2577000-0000-0000-0000-000000000002',
                    'f2577000-0000-0000-0000-000000000003', 'f2577000-0000-0000-0000-000000000004',
                    'f2577000-0000-0000-0000-000000000005', 'f2577000-0000-0000-0000-000000000006',
                    'f2577000-0000-0000-0000-000000000007', 'f2577000-0000-0000-0000-000000000008',
                    'f2577000-0000-0000-0000-000000000009']::uuid[]) b;
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by) VALUES
  ('f2577000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001'),
  ('f2577000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001');
UPDATE public.bot_server_permissions SET allowed_channel_ids = ARRAY['f2573000-0000-0000-0000-000000000006']::uuid[]
 WHERE bot_id = 'f2577000-0000-0000-0000-000000000007';
INSERT INTO public.bot_presence (bot_id, status, last_heartbeat_at) VALUES
  ('f2577000-0000-0000-0000-000000000001', 'online', now()),
  ('f2577000-0000-0000-0000-000000000003', 'online', now() - interval '2 minutes'),
  ('f2577000-0000-0000-0000-000000000004', 'offline', now()),
  ('f2577000-0000-0000-0000-000000000005', 'online', now()),
  ('f2577000-0000-0000-0000-000000000006', 'online', now()),
  ('f2577000-0000-0000-0000-000000000007', 'idle', now()),
  ('f2577000-0000-0000-0000-000000000008', 'online', now()),
  ('f2577000-0000-0000-0000-000000000009', 'dnd', now());

CREATE FUNCTION pg_temp.svc() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM tests.clear_authentication();
  PERFORM set_config('role', 'service_role', true);
END $fn$;
CREATE FUNCTION pg_temp.cmd(p_bot uuid, p_name text) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT id FROM public.bot_commands WHERE bot_id = p_bot AND name = p_name;
$fn$;
CREATE FUNCTION pg_temp.inv(p_channel uuid, p_thread uuid, p_bot uuid, p_name text,
                            p_path text[] DEFAULT '{}', p_options jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT public.invoke_bot_command(p_channel, p_thread, pg_temp.cmd(p_bot, p_name), p_path, p_options);
$fn$;
-- Weather's options as bob gives them in gen.
CREATE FUNCTION pg_temp.wx(p_options jsonb, p_path text[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001',
                     'weather', p_path, p_options);
$fn$;
CREATE FUNCTION pg_temp.iid(p_k text) RETURNS uuid LANGUAGE sql AS $fn$
  SELECT (v ->> 'id')::uuid FROM out257 WHERE k = p_k;
$fn$;
CREATE FUNCTION pg_temp.row257(p_k text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT to_jsonb(bi) FROM public.bot_interactions bi WHERE bi.id = (SELECT (v ->> 'id')::uuid FROM out257 WHERE k = p_k);
$fn$;
CREATE FUNCTION pg_temp.listed(p_channel uuid, p_thread uuid DEFAULT NULL) RETURNS text[] LANGUAGE sql AS $fn$
  SELECT ARRAY(SELECT (e #>> '{bot,username}') || '/' || (e ->> 'name')
                 FROM jsonb_array_elements(public.get_channel_bot_commands(p_channel, p_thread)) WITH ORDINALITY AS t(e, i)
                ORDER BY t.i);
$fn$;
CREATE FUNCTION pg_temp.txt(p_text text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text));
$fn$;
-- Rows written by a bot message in gen; 0 when AutoMod dropped it.
CREATE FUNCTION pg_temp.say(p_user text, p_text text) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, bot_id, content, metadata)
  VALUES ('f2573000-0000-0000-0000-000000000001', 'f2577000-0000-0000-0000-000000000001', pg_temp.txt(p_text),
          CASE WHEN p_user IS NULL THEN '{"bot": true}'::jsonb
               ELSE jsonb_build_object('bot', true, 'interaction',
                      jsonb_build_object('id', gen_random_uuid(), 'name', 'say', 'user_id', p_user)) END);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
-- As pg_temp.say for a member's command; p_followup marks the answer a follow-up.
CREATE FUNCTION pg_temp.answer(p_user text, p_text text, p_followup boolean) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, bot_id, content, metadata)
  VALUES ('f2573000-0000-0000-0000-000000000001', 'f2577000-0000-0000-0000-000000000001', pg_temp.txt(p_text),
          jsonb_build_object('bot', true, 'interaction',
            jsonb_build_object('id', gen_random_uuid(), 'name', 'say', 'user_id', p_user)
              || CASE WHEN p_followup THEN '{"followup": true}'::jsonb ELSE '{}'::jsonb END));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
-- Push payloads for one interaction, oldest first.
CREATE FUNCTION pg_temp.pushes(p_k text) RETURNS SETOF jsonb LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT m.payload FROM realtime.messages m
   WHERE m.event = 'user_event' AND m.payload ->> 'type' = 'bot_interaction:update'
     AND m.payload ->> 'id' = (SELECT v ->> 'id' FROM out257 WHERE k = p_k)
   ORDER BY m.inserted_at, m.id;
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.pushes(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.svc(), pg_temp.cmd(uuid, text), pg_temp.inv(uuid, uuid, uuid, text, text[], jsonb),
                         pg_temp.wx(jsonb, text[]), pg_temp.iid(text), pg_temp.row257(text),
                         pg_temp.listed(uuid, uuid), pg_temp.txt(text), pg_temp.say(text, text)
    TO PUBLIC;

-- Surface -----------------------------------------------------------------------------------
SELECT is_empty($q$
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('get_bot_commands', 'bot_commands_replace', 'bot_command_upsert', 'claim_bot_interactions',
                         'bot_interaction_fail', 'bot_interaction_ack', 'bot_interaction_reply',
                         'bot_interaction_record', 'bot_channel_access', 'purge_bot_interactions')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
            OR NOT p.prosecdef OR NOT p.proconfig @> ARRAY['search_path=public, pg_temp'])$q$,
  'service-role RPCs: definer, pinned search_path, executed by service_role alone');
SELECT is_empty($q$
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('get_channel_bot_commands', 'invoke_bot_command', 'get_my_bot_interactions')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
            OR NOT p.prosecdef OR NOT p.proconfig @> ARRAY['search_path=public, pg_temp'])$q$,
  'client RPCs: definer, pinned search_path, executed by authenticated and not anon or PUBLIC');
SELECT is_empty($q$
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('bot_permission_mask', 'bot_permission_names', 'bot_install_mask', 'bot_command_number',
                         'bot_interaction_ms', 'bot_interaction_error', 'bot_interaction_content', 'bot_command_json',
                         'bot_command_caller_state', 'bot_command_options', 'bot_interaction_resolved',
                         'bot_interaction_event', 'bot_command_name', 'bot_command_upsert_row', 'bot_interaction_push')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('service_role', p.oid, 'EXECUTE'))$q$,
  'helpers are executed by no API role');
SELECT is((SELECT count(*)::int FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('get_bot_commands', 'bot_commands_replace', 'bot_command_upsert', 'claim_bot_interactions',
                                'bot_interaction_fail', 'bot_interaction_ack', 'bot_interaction_reply',
                                'bot_interaction_record', 'get_channel_bot_commands', 'invoke_bot_command',
                                'get_my_bot_interactions', 'bot_channel_access')
              AND pg_get_userbyid(p.proowner) = 'postgres'), 12, 'the RPCs are owned by postgres');
SELECT ok(NOT has_table_privilege('anon', 'public.bot_commands', 'SELECT')
          AND has_table_privilege('authenticated', 'public.bot_commands', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.bot_commands', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.bot_commands', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.bot_commands', 'DELETE')
          AND has_table_privilege('service_role', 'public.bot_commands', 'INSERT'),
  'bot_commands: anon reads nothing, authenticated reads, the service role writes');
SELECT ok(NOT has_table_privilege('anon', 'public.bot_interactions', 'SELECT')
          AND has_table_privilege('authenticated', 'public.bot_interactions', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.bot_interactions', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.bot_interactions', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.bot_interactions', 'DELETE')
          AND has_table_privilege('service_role', 'public.bot_interactions', 'UPDATE'),
  'bot_interactions: authenticated reads, nothing else of a client');
SELECT is(ARRAY(SELECT polname::text FROM pg_policy WHERE polrelid = 'public.bot_commands'::regclass ORDER BY 1),
          ARRAY['bot_commands_select_owner', 'bot_commands_service_role'],
          'bot_commands keeps the owner read and the service role; the public read and owner writes are gone');
SELECT is(ARRAY(SELECT polname::text FROM pg_policy WHERE polrelid = 'public.bot_interactions'::regclass ORDER BY 1),
          ARRAY['bot_interactions_select_own', 'bot_interactions_service_role'], 'bot_interactions policies');
SELECT has_trigger('public', 'bot_interactions', 'z_bot_interactions_push', 'the push trigger exists');
SELECT is((SELECT count(*)::int FROM cron.job WHERE jobname = 'purge-bot-interactions'
             AND command = 'SELECT public.purge_bot_interactions()'), 1, 'the purge is scheduled');

-- Registration ------------------------------------------------------------------------------
INSERT INTO public.bot_commands (bot_id, name, description, command_type)
VALUES ('f2577000-0000-0000-0000-000000000001', 'legacy', 'A prefix row', 'prefix');
SELECT pg_temp.svc();
INSERT INTO out257 VALUES ('replace1', public.bot_commands_replace('f2577000-0000-0000-0000-000000000001', $j$[
  {"name": "weather", "description": "Forecast", "options": [
     {"type": 3, "name": "city", "description": "City", "required": true, "min_length": 2, "max_length": 20},
     {"type": 4, "name": "days", "description": "Days", "min_value": 1, "max_value": 7},
     {"type": 10, "name": "ratio", "description": "Ratio", "min_value": 0, "max_value": 1},
     {"type": 5, "name": "metric", "description": "Metric"},
     {"type": 3, "name": "unit", "description": "Unit", "choices": [{"name": "C", "value": "c"}, {"name": "F", "value": "f"}]},
     {"type": 6, "name": "who", "description": "Who"},
     {"type": 7, "name": "where", "description": "Where"},
     {"type": 8, "name": "role", "description": "Role"}]},
  {"name": "ban", "description": "Ban", "options": [], "required_permissions": ["BAN_MEMBERS"]},
  {"name": "bridge", "description": "Bridge", "options": [
     {"type": 2, "name": "server", "description": "Server", "options": [
        {"type": 1, "name": "clone", "description": "Clone", "options": [
           {"type": 3, "name": "name", "description": "Name", "required": true}]}]},
     {"type": 1, "name": "status", "description": "Status", "options": []}]},
  {"name": "天気", "description": "天気予報", "options": []},
  {"name": "old", "description": "Old", "options": []}]$j$::jsonb));
INSERT INTO out257
SELECT 'ids1', jsonb_object_agg(name, id) FROM public.bot_commands WHERE bot_id = 'f2577000-0000-0000-0000-000000000001';
SELECT is(ARRAY(SELECT e ->> 'name' FROM jsonb_array_elements((SELECT v FROM out257 WHERE k = 'replace1')) WITH ORDINALITY t(e, i) ORDER BY i),
          ARRAY(SELECT n FROM unnest(ARRAY['weather', 'ban', 'bridge', '天気', 'old']) n ORDER BY n),
          'bot_commands_replace returns the slash rows by name; the prefix row is gone');
SELECT is((SELECT e -> 'required_permissions' FROM jsonb_array_elements(public.get_bot_commands('f2577000-0000-0000-0000-000000000001')) e
            WHERE e ->> 'name' = 'ban'), '["BAN_MEMBERS"]'::jsonb, 'required_permissions reads back as names');
SELECT is((SELECT required_permissions FROM public.bot_commands
            WHERE bot_id = 'f2577000-0000-0000-0000-000000000001' AND name = 'ban'), 1024::bigint,
          'and is stored as the BAN_MEMBERS bit');
SELECT ok((SELECT bool_and(e ? 'id' AND e ? 'description' AND e ? 'options' AND e ? 'created_at' AND e ? 'updated_at'
                           AND jsonb_typeof(e -> 'required_permissions') = 'array')
             FROM jsonb_array_elements(public.get_bot_commands('f2577000-0000-0000-0000-000000000001')) e),
          'each command carries id, description, options, required_permissions and timestamps');

SELECT is(public.bot_commands_replace('f2577000-0000-0000-0000-000000000001', $j$[
  {"name": "weather", "description": "Forecast v2", "options": [
     {"type": 3, "name": "city", "description": "City", "required": true, "min_length": 2, "max_length": 20},
     {"type": 4, "name": "days", "description": "Days", "min_value": 1, "max_value": 7},
     {"type": 10, "name": "ratio", "description": "Ratio", "min_value": 0, "max_value": 1},
     {"type": 5, "name": "metric", "description": "Metric"},
     {"type": 3, "name": "unit", "description": "Unit", "choices": [{"name": "C", "value": "c"}, {"name": "F", "value": "f"}]},
     {"type": 6, "name": "who", "description": "Who"},
     {"type": 7, "name": "where", "description": "Where"},
     {"type": 8, "name": "role", "description": "Role"}]},
  {"name": "ban", "description": "Ban", "options": [], "required_permissions": ["ban_members"]},
  {"name": "bridge", "description": "Bridge", "options": [
     {"type": 2, "name": "server", "description": "Server", "options": [
        {"type": 1, "name": "clone", "description": "Clone", "options": [
           {"type": 3, "name": "name", "description": "Name", "required": true}]}]},
     {"type": 1, "name": "status", "description": "Status", "options": []}]},
  {"name": "天気", "description": "天気予報", "options": []}]$j$::jsonb) -> 0 ->> 'name' IS NOT NULL, true,
  'a second replace runs');
SELECT is((SELECT jsonb_object_agg(name, id) FROM public.bot_commands WHERE bot_id = 'f2577000-0000-0000-0000-000000000001'),
          (SELECT v - 'old' FROM out257 WHERE k = 'ids1'),
          'kept names keep their ids; the dropped name is deleted');
SELECT is((SELECT description FROM public.bot_commands WHERE bot_id = 'f2577000-0000-0000-0000-000000000001' AND name = 'weather'),
          'Forecast v2', 'a kept name takes the new definition');
SELECT throws_ok($q$SELECT public.bot_commands_replace('f2577000-0000-0000-0000-000000000001',
                    '[{"name": "x", "description": "x", "required_permissions": ["FLY"]}]')$q$,
                 'P0001', 'BOT_COMMAND_UNKNOWN_PERMISSION:FLY', 'an unknown permission name is refused');
SELECT throws_ok($q$SELECT public.bot_commands_replace('f2577000-0000-0000-0000-000000000001',
                    '[{"name": "ping", "description": "a"}, {"name": "ping", "description": "b"}]')$q$,
                 'P0001', 'BOT_COMMAND_DUPLICATE:ping', 'a name twice in one set is refused');
SELECT throws_ok($q$SELECT public.bot_commands_replace('f2577000-0000-0000-0000-00000000000a',
                    (SELECT jsonb_agg(jsonb_build_object('name', 'c' || g, 'description', 'd')) FROM generate_series(1, 101) g))$q$,
                 'P0001', 'BOT_COMMAND_LIMIT', '101 commands are refused');
SELECT is((SELECT count(*)::int FROM public.bot_commands WHERE bot_id = 'f2577000-0000-0000-0000-000000000001'), 4,
          'a refused replace changes nothing');
SELECT is(jsonb_array_length(public.bot_commands_replace('f2577000-0000-0000-0000-00000000000a',
            (SELECT jsonb_agg(jsonb_build_object('name', 'c' || g, 'description', 'd')) FROM generate_series(1, 100) g))),
          100, '100 commands are stored');
SELECT throws_ok($q$SELECT public.bot_command_upsert('f2577000-0000-0000-0000-00000000000a', '{"name": "c101", "description": "d"}')$q$,
                 'P0001', 'BOT_COMMAND_LIMIT', 'a 101st command is refused');
SELECT is(public.bot_command_upsert('f2577000-0000-0000-0000-00000000000a', '{"name": "c7", "description": "seven"}')
            - 'command',
          '{"created": false}'::jsonb, 'replacing one of 100 by name is allowed and reports created false');
SELECT is((SELECT count(*)::int || ' ' || max(description) FILTER (WHERE name = 'c7') FROM public.bot_commands
            WHERE bot_id = 'f2577000-0000-0000-0000-00000000000a'), '100 seven', 'and takes the new definition in place');
SELECT throws_ok($q$SELECT public.bot_command_upsert('f2577000-0000-0000-0000-000000000009',
                    '{"name": "echo", "description": "e", "required_permissions": ["NOPE"]}')$q$,
                 'P0001', 'BOT_COMMAND_UNKNOWN_PERMISSION:NOPE', 'upsert refuses an unknown permission');
SELECT is((public.bot_command_upsert('f2577000-0000-0000-0000-000000000009', '{"name": "echo", "description": "e"}')
            -> 'created')::text, 'true', 'upsert of a new name reports created true');
SELECT lives_ok($q$SELECT public.bot_commands_replace(b, '[{"name": "ping", "description": "Ping"}]')
                     FROM unnest(ARRAY['f2577000-0000-0000-0000-000000000002', 'f2577000-0000-0000-0000-000000000003',
                                       'f2577000-0000-0000-0000-000000000004', 'f2577000-0000-0000-0000-000000000005',
                                       'f2577000-0000-0000-0000-000000000006', 'f2577000-0000-0000-0000-000000000007',
                                       'f2577000-0000-0000-0000-000000000008']::uuid[]) b$q$,
                'every other bot registers ping');
SELECT lives_ok($q$SELECT public.bot_command_upsert('f2577000-0000-0000-0000-000000000009', '{"name": "ping", "description": "Ping"}')$q$,
                'other adds ping');
SELECT tests.clear_authentication();
INSERT INTO public.bot_commands (bot_id, name, description, command_type)
VALUES ('f2577000-0000-0000-0000-000000000009', 'prefixy', 'A prefix row', 'prefix');

-- Who reads bot_commands ---------------------------------------------------------------------
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000007');
SELECT is((SELECT count(*)::int FROM public.bot_commands WHERE bot_id = 'f2577000-0000-0000-0000-000000000001'), 4,
          'the bot owner reads its commands');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.bot_commands), 0, 'a member reads no command rows directly');
SELECT throws_ok($q$INSERT INTO public.bot_commands (bot_id, name) VALUES ('f2577000-0000-0000-0000-000000000001', 'evil')$q$,
                 '42501', NULL, 'a client inserts no command');
SELECT ok((public.get_bot_profile('f2577000-0000-0000-0000-000000000001') -> 'commands') @> '[{"name": "weather"}]',
          'get_bot_profile still lists commands to a member');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT count(*) FROM public.bot_commands$q$, '42501', NULL, 'anon reads no command rows');
SELECT throws_ok($q$SELECT public.get_channel_bot_commands('f2573000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'anon cannot list commands');

-- Listing -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000001'),
          ARRAY['other257/echo', 'other257/ping', 'quiet257/ping', 'sleepy257/ping', 'stale257/ping',
                'weather257/bridge', 'weather257/weather', 'weather257/天気'],
          'a member lists posting bots by name, then command; offline bots included; ban, inactive, unlisted and mute bots and prefix rows absent');
SELECT ok((SELECT bool_and(e ? 'id' AND e ? 'description' AND e ? 'options'
                           AND (e -> 'bot') ?& ARRAY['id', 'username', 'display_name', 'avatar_url'])
             FROM jsonb_array_elements(public.get_channel_bot_commands('f2573000-0000-0000-0000-000000000001')) e),
          'each listed command carries its options and its bot');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000001', 'f2575000-0000-0000-0000-000000000001'),
          pg_temp.listed('f2573000-0000-0000-0000-000000000001'), 'a thread of the channel lists the same');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000006'), ARRAY['listed257/ping'],
          'botc: the listed bot posts there; @everyone''s deny keeps every other bot out');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000002'), '{}'::text[], 'a channel the member cannot view lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000003'), '{}'::text[], 'a channel the member cannot send in lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000005'), '{}'::text[], 'a voice channel lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000009'), '{}'::text[], 'an encrypted channel lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-00000000000a'), '{}'::text[], 'a copy''s channel lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000007', 'f2575000-0000-0000-0000-000000000004'), '{}'::text[],
          'a thread where the member lacks SEND_MESSAGES_IN_THREADS lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000004', 'f2575000-0000-0000-0000-000000000001'), '{}'::text[],
          'a thread of another channel lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000001', 'f2575000-0000-0000-0000-000000000002'), '{}'::text[],
          'a locked thread lists nothing');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000001', 'f2575000-0000-0000-0000-0000000000ff'), '{}'::text[],
          'a thread that does not exist lists nothing');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000003');
SELECT ok('weather257/ban' = ANY (pg_temp.listed('f2573000-0000-0000-0000-000000000001')),
          'a member holding BAN_MEMBERS sees ban');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok('weather257/ban' = ANY (pg_temp.listed('f2573000-0000-0000-0000-000000000001')), 'the owner sees ban');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000001'), '{}'::text[], 'a non-member lists nothing');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000004');
SELECT is(pg_temp.listed('f2573000-0000-0000-0000-000000000001'), '{}'::text[], 'a pending member lists nothing');

-- Invocation refusals -----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo"}')$q$, 'P0001', 'BOT_COMMAND_FORBIDDEN', 'a non-member is refused');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo"}')$q$, 'P0001', 'BOT_COMMAND_FORBIDDEN', 'a pending member is refused');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_TIMED_OUT', 'a timed-out member is refused');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000002', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_FORBIDDEN', 'a channel the member cannot view');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000003', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_FORBIDDEN', 'a channel the member cannot send in');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000007', 'f2575000-0000-0000-0000-000000000004',
                                       'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_FORBIDDEN', 'a thread needs SEND_MESSAGES_IN_THREADS');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000009', NULL, 'f2577000-0000-0000-0000-000000000001', 'ban')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'an encrypted channel');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-00000000000a', NULL, 'f2577000-0000-0000-0000-000000000001', 'ban')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a copy''s channel');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000005', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a voice channel');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000005', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'an inactive bot');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000006', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'an inactive install');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000006', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a bot @everyone''s override keeps from posting');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000007', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a bot whose channel list omits the channel');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000008', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a bot whose install lacks send_messages');
SELECT throws_ok($q$SELECT public.invoke_bot_command('f2573000-0000-0000-0000-000000000001', NULL,
                                                     'f2578000-0000-0000-0000-000000000001', '{}', '{}')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a command that does not exist');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'prefixy')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a prefix command');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'ban')$q$,
                 'P0001', 'BOT_COMMAND_FORBIDDEN', 'a member without the command''s permission');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', 'f2575000-0000-0000-0000-000000000002',
                                       'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_THREAD_LOCKED', 'a locked thread');
SELECT ok(EXISTS (SELECT 1
                    FROM jsonb_array_elements(public.get_channel_bot_commands('f2573000-0000-0000-0000-000000000001',
                                                                              'f2575000-0000-0000-0000-000000000003')) e
                   WHERE e ->> 'name' = 'ping'),
          'an archived thread offers commands, as it takes messages');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000004', 'f2575000-0000-0000-0000-000000000001',
                                       'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a thread of another channel');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', 'f2575000-0000-0000-0000-0000000000ff',
                                       'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_UNAVAILABLE', 'a thread that does not exist yet');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000002', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_BOT_OFFLINE', 'a bot with no presence row is offline');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000003', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_BOT_OFFLINE', 'a bot whose heartbeat is 2 minutes old is offline');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000004', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_BOT_OFFLINE', 'a bot whose status is offline is offline');

-- Option values ------------------------------------------------------------------------------
SELECT throws_ok($q$SELECT pg_temp.wx('{}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:city', 'a required option missing');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": ""}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:city', 'an empty string is no value');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": 5}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:city', 'a string option given a number');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "T"}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:city', 'shorter than min_length');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "abcdefghijklmnopqrstu"}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:city',
                 'longer than max_length');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "days": 1.5}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:days',
                 'an integer option given a fraction');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "days": "3"}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:days',
                 'an integer option given a string');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "days": 8}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:days',
                 'above max_value');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "days": 0}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:days',
                 'below min_value');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "ratio": 1.01}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:ratio',
                 'a number above max_value');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "metric": "yes"}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:metric',
                 'a boolean option given a string');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "unit": "k"}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:unit',
                 'a value outside the choices');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "who": "33333333-0000-0000-0000-000000000003"}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:who', 'a user who is not a member');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "who": "f2571000-0000-0000-0000-000000000004"}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:who', 'a pending member');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "who": "bob"}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:who',
                 'a user option that is not a uuid');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "where": "f2573000-0000-0000-0000-000000000002"}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:where', 'a channel hidden from the member');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "where": "f2573000-0000-0000-0000-00000000000b"}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:where', 'a channel of another server');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "role": "f2574000-0000-0000-0000-000000000003"}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:role', 'a role of another server');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo", "zzz": 1}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:zzz',
                 'an option the command lacks');
SELECT throws_ok($q$SELECT pg_temp.wx('["Tokyo"]')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION', 'options that are not an object');
SELECT throws_ok($q$SELECT pg_temp.wx('{"city": "Tokyo"}', '{daily}')$q$, 'P0001', 'BOT_COMMAND_INVALID_OPTION:daily',
                 'a path into a command without subcommands');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'bridge')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:bridge', 'a command with subcommands needs a path');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'bridge',
                                       '{server}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:server', 'a group alone is no subcommand');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'bridge',
                                       '{server,nope}', '{"name": "x"}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:nope', 'an unknown subcommand of a group');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'bridge',
                                       '{status,x}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:status', 'a subcommand used as a group');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'bridge',
                                       '{server,clone}', '{}')$q$,
                 'P0001', 'BOT_COMMAND_INVALID_OPTION:name', 'a subcommand''s required option');
SELECT is((SELECT count(*)::int FROM public.bot_interactions), 0, 'no refusal stored a row');

-- Invocations -------------------------------------------------------------------------------
INSERT INTO out257 VALUES ('full', pg_temp.wx(jsonb_build_object(
    'city', 'Tokyo', 'days', 3.0, 'ratio', 0.5, 'metric', true, 'unit', 'c',
    'who', 'F2571000-0000-0000-0000-000000000001', 'where', 'f2573000-0000-0000-0000-000000000008',
    'role', 'f2574000-0000-0000-0000-000000000001')));
SELECT is((SELECT v - 'id' FROM out257 WHERE k = 'full'), '{"respond_in_ms": 5000, "expires_in_ms": 900000}'::jsonb,
          'invoke returns the windows in milliseconds');
SELECT is((SELECT count(*)::int FROM public.bot_interactions WHERE id = pg_temp.iid('full')), 1, 'the invoker reads its row');
SELECT is(pg_temp.row257('full') -> 'data',
          jsonb_build_object('id', pg_temp.cmd('f2577000-0000-0000-0000-000000000001', 'weather'), 'name', 'weather', 'type', 1,
                             'options', '[{"name": "city", "type": 3, "value": "Tokyo"},
                                          {"name": "days", "type": 4, "value": 3},
                                          {"name": "ratio", "type": 10, "value": 0.5},
                                          {"name": "metric", "type": 5, "value": true},
                                          {"name": "unit", "type": 3, "value": "c"},
                                          {"name": "who", "type": 6, "value": "f2571000-0000-0000-0000-000000000001"},
                                          {"name": "where", "type": 7, "value": "f2573000-0000-0000-0000-000000000008"},
                                          {"name": "role", "type": 8, "value": "f2574000-0000-0000-0000-000000000001"}]'::jsonb),
          'data is stored Discord-shaped, ids lowercase, integers whole');
SELECT is((pg_temp.row257('full') ->> 'status') || ' ' || (pg_temp.row257('full') ->> 'command_name')
            || ' ' || (pg_temp.row257('full') ->> 'server_id'),
          'pending weather f2572000-0000-0000-0000-000000000001', 'the row is pending, named and placed');
INSERT INTO out257 VALUES ('clone', pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL,
    'f2577000-0000-0000-0000-000000000001', 'bridge', '{server,clone}', '{"name": "Mirror"}'));
SELECT is(pg_temp.row257('clone') #> '{data,options}',
          '[{"name": "server", "type": 2, "options": [{"name": "clone", "type": 1,
             "options": [{"name": "name", "type": 3, "value": "Mirror"}]}]}]'::jsonb,
          'group and subcommand nest as Discord sends them');
SELECT is(pg_temp.row257('clone') ->> 'command_name', 'bridge server clone', 'command_name is the full path');
SELECT lives_ok($q$INSERT INTO out257 VALUES ('kanji', pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL,
                     'f2577000-0000-0000-0000-000000000001', '天気'))$q$, 'a Japanese command name is invoked');
SELECT lives_ok($q$INSERT INTO out257 VALUES ('listed', pg_temp.inv('f2573000-0000-0000-0000-000000000006', NULL,
                     'f2577000-0000-0000-0000-000000000007', 'ping'))$q$,
                'the channel list grants a bot a channel @everyone''s override closes');
SELECT tests.clear_authentication();
SELECT is((SELECT usage_count FROM public.bot_commands WHERE id = pg_temp.cmd('f2577000-0000-0000-0000-000000000001', 'weather')),
          1, 'invoking counts a use');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'ban')$q$,
                'the owner holds every permission');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000001', 'ban')$q$,
                'a member holding BAN_MEMBERS invokes ban');
SELECT lives_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000004', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                'MANAGE_MESSAGES: a first invocation under slowmode');
SELECT lives_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000004', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                'MANAGE_MESSAGES is exempt from slowmode');

-- Slowmode, rate limit ----------------------------------------------------------------------
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000004', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                'a first invocation under slowmode');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000004', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_SLOWMODE:30', 'a second within slowmode');
SELECT tests.clear_authentication();
INSERT INTO public.messages (channel_id, user_id, content)
VALUES ('f2573000-0000-0000-0000-000000000004', 'f2571000-0000-0000-0000-000000000005', '[{"type":"text","text":"hi"}]');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000005');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000004', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_SLOWMODE:30', 'a message of the member counts for slowmode');
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000006');
SELECT is((SELECT count(pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping'))::int
             FROM generate_series(1, 5) g),
          5, 'five invocations in ten seconds');
SELECT is((SELECT count(*)::int FROM public.bot_interactions), 5, 'each stored');
SELECT throws_ok($q$SELECT pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping')$q$,
                 'P0001', 'BOT_COMMAND_RATE_LIMITED:10', 'a sixth is rate limited');

-- RLS and get_my_bot_interactions -----------------------------------------------------------
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.bot_interactions WHERE id = pg_temp.iid('full')), 0,
          'another member reads none of the invoker''s rows');
SELECT is(public.get_my_bot_interactions(ARRAY[pg_temp.iid('full')]), '[]'::jsonb,
          'get_my_bot_interactions returns nothing of another account');
SELECT throws_ok($q$INSERT INTO public.bot_interactions (bot_id, server_id, channel_id, user_id, command_name)
                    VALUES ('f2577000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001',
                            'f2573000-0000-0000-0000-000000000001', 'f2571000-0000-0000-0000-000000000001', 'x')$q$,
                 '42501', NULL, 'a client inserts no interaction');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$UPDATE public.bot_interactions SET status = 'responded' WHERE id = pg_temp.iid('full')$q$,
                 '42501', NULL, 'the invoker updates none of its rows');
SELECT throws_ok($q$DELETE FROM public.bot_interactions WHERE id = pg_temp.iid('full')$q$,
                 '42501', NULL, 'nor deletes one');
SELECT is(jsonb_array_length(public.get_my_bot_interactions(ARRAY[pg_temp.iid('full'), pg_temp.iid('kanji'), pg_temp.iid('late')])),
          2, 'get_my_bot_interactions returns the caller''s rows among the ids');
SELECT is((SELECT e - 'respond_in_ms' - 'expires_in_ms'
             FROM jsonb_array_elements(public.get_my_bot_interactions(ARRAY[pg_temp.iid('full'), pg_temp.iid('kanji')])) e
            WHERE e ->> 'id' = pg_temp.iid('full')::text),
          jsonb_build_object('id', pg_temp.iid('full'), 'bot_id', 'f2577000-0000-0000-0000-000000000001',
                             'channel_id', 'f2573000-0000-0000-0000-000000000001', 'thread_id', NULL,
                             'command_name', 'weather', 'status', 'pending', 'error', NULL, 'ephemeral', false,
                             'response_message_id', NULL, 'replies', '[]'::jsonb),
          'each with its state');
SELECT ok((SELECT bool_and((e ->> 'respond_in_ms')::bigint BETWEEN 0 AND 5000 AND (e ->> 'expires_in_ms')::bigint BETWEEN 0 AND 900000)
             FROM jsonb_array_elements(public.get_my_bot_interactions(ARRAY[pg_temp.iid('full')])) e),
          'with the remaining windows');

-- Forged metadata.interaction ---------------------------------------------------------------
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('f2573000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
                            '[{"type":"text","text":"hi"}]',
                            '{"interaction": {"id": "x", "name": "say", "user_id": "22222222-0000-0000-0000-000000000002"}}')$q$,
                 '42501', 'metadata key reserved for the server: interaction', 'a client message carries no interaction');
SELECT throws_ok($q$UPDATE public.messages SET metadata = '{"interaction": {"name": "say"}}'
                     WHERE id = 'f2576000-0000-0000-0000-000000000003'$q$,
                 '42501', 'metadata key reserved for the server: interaction', 'nor gains one by an edit');

-- Delivery ----------------------------------------------------------------------------------
SELECT tests.clear_authentication();
DELETE FROM realtime.messages;
SELECT pg_temp.svc();
INSERT INTO out257 VALUES ('claim1', public.claim_bot_interactions(ARRAY['f2577000-0000-0000-0000-000000000001']::uuid[]));
SELECT is((SELECT array_agg(e ->> 'id' ORDER BY e ->> 'id') FROM jsonb_array_elements((SELECT v FROM out257 WHERE k = 'claim1')) e),
          (SELECT array_agg(id::text ORDER BY id::text) FROM public.bot_interactions
            WHERE bot_id = 'f2577000-0000-0000-0000-000000000001'),
          'claim delivers every pending row of the bot');
SELECT is((SELECT count(*)::int FROM public.bot_interactions
            WHERE bot_id = 'f2577000-0000-0000-0000-000000000001' AND status <> 'delivered'), 0, 'each is delivered');
SELECT is(public.claim_bot_interactions(ARRAY['f2577000-0000-0000-0000-000000000001']::uuid[]), '[]'::jsonb,
          'a second claim finds nothing');
INSERT INTO out257
SELECT 'event', e FROM jsonb_array_elements((SELECT v FROM out257 WHERE k = 'claim1')) e WHERE e ->> 'id' = pg_temp.iid('full')::text;
SELECT is((SELECT (v - 'data' - 'member' - 'created_at' - 'respond_by' - 'expires_at') #- '{user,avatar_url}'
             FROM out257 WHERE k = 'event'),
          jsonb_build_object('id', pg_temp.iid('full'), 'bot_id', 'f2577000-0000-0000-0000-000000000001', 'type', 2,
                             'server_id', 'f2572000-0000-0000-0000-000000000001',
                             'channel_id', 'f2573000-0000-0000-0000-000000000001', 'thread_id', NULL,
                             'user', jsonb_build_object('id', '22222222-0000-0000-0000-000000000002', 'username', 'bob',
                                                        'display_name', 'Bob', 'bot', false)),
          'the event names the invoker and the room');
SELECT is((SELECT v -> 'member' -> 'roles' FROM out257 WHERE k = 'event'), '["f2574000-0000-0000-0000-000000000001"]'::jsonb,
          'member.roles lists the invoker''s roles without @everyone');
SELECT ok((SELECT (v -> 'member' -> 'permissions') @> '["VIEW_CHANNEL", "SEND_MESSAGES"]'
                  AND NOT (v -> 'member' -> 'permissions') @> '["BAN_MEMBERS"]' FROM out257 WHERE k = 'event'),
          'member.permissions are the names held in the channel');
SELECT is((SELECT v #> '{data,resolved,channels}' FROM out257 WHERE k = 'event'),
          '{"f2573000-0000-0000-0000-000000000008": {"id": "f2573000-0000-0000-0000-000000000008", "type": 0}}'::jsonb,
          'a channel option the bot cannot view resolves to id and type');
SELECT is((SELECT v #> '{data,resolved,users,f2571000-0000-0000-0000-000000000001,username}' FROM out257 WHERE k = 'event'),
          '"carol257"'::jsonb, 'a user option resolves to the user');
SELECT is((SELECT v #> '{data,resolved,members,f2571000-0000-0000-0000-000000000001}' FROM out257 WHERE k = 'event'),
          '{"nickname": "Caz", "roles": ["f2574000-0000-0000-0000-000000000001"]}'::jsonb, 'and the member');
SELECT is((SELECT v #> '{data,resolved,roles,f2574000-0000-0000-0000-000000000001}' FROM out257 WHERE k = 'event'),
          '{"id": "f2574000-0000-0000-0000-000000000001", "name": "speakers", "color": "#00ff00", "position": 3}'::jsonb,
          'a role option resolves to the role');
SELECT is((SELECT e #> '{data,resolved}' FROM jsonb_array_elements((SELECT v FROM out257 WHERE k = 'claim1')) e
            WHERE e ->> 'id' = pg_temp.iid('clone')::text), '{}'::jsonb, 'resolved is empty without such options');
SELECT is(ARRAY(SELECT p ->> 'status' FROM pg_temp.pushes('full') p), ARRAY['delivered'], 'delivery is pushed');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(DISTINCT m.topic) FROM realtime.messages m WHERE m.payload ->> 'id' = pg_temp.iid('full')::text),
          ARRAY['user:22222222-0000-0000-0000-000000000002'], 'on the invoker''s user topic');
SELECT pg_temp.svc();
SELECT ok((SELECT p ?& ARRAY['bot_id', 'channel_id', 'thread_id', 'command_name', 'error', 'ephemeral',
                              'response_message_id', 'reply', 'reply_count', 'expires_in_ms']
             FROM pg_temp.pushes('full') p LIMIT 1),
          'the push carries the contract''s fields');

-- Acknowledgement ---------------------------------------------------------------------------
SELECT throws_ok($q$SELECT public.bot_interaction_ack('f2577000-0000-0000-0000-000000000009', pg_temp.iid('full'), false, false)$q$,
                 'P0001', 'INTERACTION_UNKNOWN', 'another bot''s interaction is unknown');
SELECT throws_ok($q$SELECT public.bot_interaction_ack('f2577000-0000-0000-0000-000000000001', gen_random_uuid(), false, false)$q$,
                 'P0001', 'INTERACTION_UNKNOWN', 'a missing interaction is unknown');
SELECT throws_ok($q$SELECT public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), 'original', false)$q$,
                 'P0001', 'INTERACTION_NOT_ACKNOWLEDGED', 'no reply before an acknowledgement');
SELECT is(public.bot_interaction_ack('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), false, false) - 'expires_at',
          jsonb_build_object('id', pg_temp.iid('full'), 'status', 'responding', 'ephemeral', false,
                             'channel_id', 'f2573000-0000-0000-0000-000000000001', 'thread_id', NULL,
                             'user_id', '22222222-0000-0000-0000-000000000002', 'command_name', 'weather'),
          'a public reply acknowledges as responding');
SELECT throws_ok($q$SELECT public.bot_interaction_ack('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), false, false)$q$,
                 'P0001', 'INTERACTION_ACKNOWLEDGED', 'a second acknowledgement is refused: one winner');
SELECT throws_ok($q$SELECT public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), 'original', false)$q$,
                 'P0001', 'INTERACTION_RESPONSE_IN_PROGRESS', 'the original is in progress until recorded');
SELECT lives_ok($q$SELECT public.bot_interaction_record('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'),
                                                         'f2576000-0000-0000-0000-000000000003', NULL)$q$, 'record the message');
SELECT is((pg_temp.row257('full') ->> 'status') || ' ' || (pg_temp.row257('full') ->> 'response_message_id'),
          'responded f2576000-0000-0000-0000-000000000003', 'the row is responded with the message');
SELECT is(public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), 'original', false),
          '{"action": "edit_message", "message_id": "f2576000-0000-0000-0000-000000000003"}'::jsonb,
          'a later original edits the message');
SELECT lives_ok($q$SELECT public.bot_interaction_record('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), NULL, 'automod_blocked')$q$,
                'record outside responding');
SELECT is(pg_temp.row257('full') ->> 'status', 'responded', 'changes nothing');
SELECT is(public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('full'), 'followup', false),
          '{"action": "create_message"}'::jsonb, 'a public follow-up creates a message');
SELECT throws_ok(format($q$SELECT public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', %L, 'followup', true, %L)$q$,
                        pg_temp.iid('full'), pg_temp.txt(repeat('x', public.get_instance_config_int('max_message_length', 2000, 50000) + 1))),
                 'P0001', 'INTERACTION_REPLY_TOO_LONG:' || public.get_instance_config_int('max_message_length', 2000, 50000),
                 'a reply over the message limit is refused');

-- A public reply AutoMod refuses, then retried.
SELECT lives_ok($q$SELECT public.bot_interaction_ack('f2577000-0000-0000-0000-000000000001', pg_temp.iid('clone'), false, false)$q$,
                'acknowledge clone');
SELECT lives_ok($q$SELECT public.bot_interaction_record('f2577000-0000-0000-0000-000000000001', pg_temp.iid('clone'), NULL, 'automod_blocked')$q$,
                'record a refused insert');
SELECT is((pg_temp.row257('clone') ->> 'status') || ' ' || (pg_temp.row257('clone') ->> 'error'), 'failed automod_blocked',
          'the row fails with the reason');
SELECT is(public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('clone'), 'original', false),
          '{"action": "create_message"}'::jsonb, 'an original after the failure creates a message');
SELECT is(pg_temp.row257('clone') ->> 'status', 'responding', 'and the row is responding again');

-- Ephemeral replies.
SELECT is(public.bot_interaction_ack('f2577000-0000-0000-0000-000000000001', pg_temp.iid('kanji'), false, true,
                                     pg_temp.txt('only you')) ->> 'status', 'responded', 'a private reply is stored at once');
SELECT is(pg_temp.row257('kanji') #> '{replies,0,content}', pg_temp.txt('only you'), 'as replies[0]');
SELECT is((SELECT p -> 'reply' -> 'content' FROM pg_temp.pushes('kanji') p WHERE p ->> 'status' = 'responded'),
          pg_temp.txt('only you'), 'the push carries the reply');
INSERT INTO out257 VALUES ('kanji_reply', pg_temp.row257('kanji') #> '{replies,0,id}');
SELECT is(public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('kanji'), 'original', false,
                                       pg_temp.txt('edited')) #> '{reply,content}', pg_temp.txt('edited'), 'the original is edited');
SELECT ok((pg_temp.row257('kanji') #>> '{replies,0,edited_at}') IS NOT NULL
          AND pg_temp.row257('kanji') #> '{replies,0,id}' = (SELECT v FROM out257 WHERE k = 'kanji_reply'),
          'keeping its id, with edited_at');
SELECT ok(EXISTS (SELECT 1 FROM pg_temp.pushes('kanji') p WHERE p #> '{reply,content}' = pg_temp.txt('edited')),
          'the push names the edited original as the newest reply');
SELECT is((SELECT count(*)::int FROM generate_series(1, 10) g,
                  LATERAL public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('kanji'), 'followup',
                                                       g % 2 = 0, pg_temp.txt('f' || g)) r), 10, 'ten follow-ups');
SELECT is(jsonb_array_length(pg_temp.row257('kanji') -> 'replies'), 6, 'private follow-ups append to replies');
SELECT throws_ok($q$SELECT public.bot_interaction_reply('f2577000-0000-0000-0000-000000000001', pg_temp.iid('kanji'), 'followup', true)$q$,
                 'P0001', 'INTERACTION_FOLLOWUP_LIMIT', 'an eleventh is refused');

-- Deferred private reply: a follow-up first, then the original.
SELECT is(public.bot_interaction_ack('f2577000-0000-0000-0000-000000000007', pg_temp.iid('listed'), true, true) ->> 'status',
          'deferred', 'a deferral');
SELECT is(public.bot_interaction_reply('f2577000-0000-0000-0000-000000000007', pg_temp.iid('listed'), 'followup', true,
                                       pg_temp.txt('first')) ->> 'action', 'stored', 'a private follow-up while deferred');
SELECT is(public.bot_interaction_reply('f2577000-0000-0000-0000-000000000007', pg_temp.iid('listed'), 'original', false,
                                       pg_temp.txt('answer')) ->> 'action', 'stored', 'the original after a deferral');
SELECT is(ARRAY(SELECT e #>> '{content,0,text}' FROM jsonb_array_elements(pg_temp.row257('listed') -> 'replies') e),
          ARRAY['answer', 'first'], 'the original goes to index 0');
SELECT is(pg_temp.row257('listed') ->> 'status', 'responded', 'and the row is responded');
SELECT tests.clear_authentication();
UPDATE public.bot_interactions SET expires_at = now() - interval '1 second' WHERE id = pg_temp.iid('listed');
SELECT pg_temp.svc();
SELECT throws_ok($q$SELECT public.bot_interaction_reply('f2577000-0000-0000-0000-000000000007', pg_temp.iid('listed'), 'followup', true)$q$,
                 'P0001', 'INTERACTION_EXPIRED', 'no reply past expires_at');

-- Late acknowledgement, expiry, lost channel, failures.
SELECT tests.authenticate_as('a2570000-0000-0000-0000-000000000003');
INSERT INTO out257 VALUES ('late', pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping'));
INSERT INTO out257 VALUES ('stale', pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'echo'));
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out257 VALUES ('lost', pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'ping'));
INSERT INTO out257 VALUES ('gone', pg_temp.inv('f2573000-0000-0000-0000-000000000001', NULL, 'f2577000-0000-0000-0000-000000000009', 'echo'));
SELECT tests.clear_authentication();
UPDATE public.bot_interactions SET respond_by = now() - interval '1 second' WHERE id = pg_temp.iid('stale');
DELETE FROM public.bot_interactions
 WHERE bot_id = 'f2577000-0000-0000-0000-000000000009' AND id NOT IN (pg_temp.iid('late'), pg_temp.iid('stale'),
                                                                      pg_temp.iid('lost'), pg_temp.iid('gone'));
UPDATE public.bot_server_permissions SET allowed_channel_ids = ARRAY['f2573000-0000-0000-0000-000000000006']::uuid[]
 WHERE bot_id = 'f2577000-0000-0000-0000-000000000009' AND server_id = 'f2572000-0000-0000-0000-000000000001';
UPDATE public.bot_interactions SET channel_id = 'f2573000-0000-0000-0000-000000000006' WHERE id = pg_temp.iid('late');
SELECT pg_temp.svc();
SELECT is((SELECT array_agg(e ->> 'id') FROM jsonb_array_elements(
             public.claim_bot_interactions(ARRAY['f2577000-0000-0000-0000-000000000009']::uuid[])) e),
          ARRAY[pg_temp.iid('late')::text], 'claim delivers only what the bot may still answer');
SELECT is(pg_temp.row257('stale') ->> 'status', 'expired', 'a row past respond_by expires at claim');
SELECT is((pg_temp.row257('lost') ->> 'status') || ' ' || (pg_temp.row257('lost') ->> 'error'), 'failed bot_cannot_post',
          'a row in a channel the bot lost fails');
SELECT tests.clear_authentication();
UPDATE public.bot_interactions SET respond_by = now() - interval '1 second' WHERE id = pg_temp.iid('late');
SELECT pg_temp.svc();
SELECT throws_ok($q$SELECT public.bot_interaction_ack('f2577000-0000-0000-0000-000000000009', pg_temp.iid('late'), true, false)$q$,
                 'P0001', 'INTERACTION_EXPIRED', 'a late acknowledgement is refused');
SELECT lives_ok($q$SELECT public.claim_bot_interactions(ARRAY['f2577000-0000-0000-0000-000000000009']::uuid[])$q$, 'the next claim');
SELECT is(pg_temp.row257('late') ->> 'status', 'expired', 'expires the delivered row');
SELECT throws_ok($q$SELECT public.bot_interaction_ack('f2577000-0000-0000-0000-000000000009', pg_temp.iid('lost'), false, false)$q$,
                 'P0001', 'INTERACTION_EXPIRED', 'a failed row takes no acknowledgement');
SELECT tests.clear_authentication();
UPDATE public.bot_interactions SET status = 'delivered' WHERE id = pg_temp.iid('gone');
SELECT pg_temp.svc();
SELECT lives_ok($q$SELECT public.bot_interaction_fail('f2577000-0000-0000-0000-000000000009', pg_temp.iid('gone'), 'offline')$q$,
                'the gateway fails a row no socket took');
SELECT is((pg_temp.row257('gone') ->> 'status') || ' ' || (pg_temp.row257('gone') ->> 'error'), 'failed offline', 'with offline');
SELECT throws_ok($q$SELECT public.bot_interaction_fail('f2577000-0000-0000-0000-000000000001', pg_temp.iid('gone'), 'offline')$q$,
                 'P0001', 'INTERACTION_UNKNOWN', 'fail names the bot''s own interaction');
SELECT tests.clear_authentication();
UPDATE public.bot_interactions SET status = 'delivered', error = NULL WHERE id = pg_temp.iid('gone');
SELECT pg_temp.svc();
SELECT lives_ok($q$SELECT public.bot_interaction_fail('f2577000-0000-0000-0000-000000000009', pg_temp.iid('gone'), 'meteor')$q$,
                'an unknown reason');
SELECT is(pg_temp.row257('gone') ->> 'error', 'failed', 'is stored as failed');
SELECT is((SELECT count(*)::int FROM pg_temp.pushes('gone') p WHERE p ->> 'error' = 'failed'), 1, 'a failure is pushed');

-- AutoMod ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('f2572000-0000-0000-0000-000000000001',
                   '{"name": "Words", "rule_type": "keyword", "config": {"keywords": ["badword"]},
                     "actions": {"block": true}}'::jsonb)$q$, 'the owner adds a keyword rule');
SELECT pg_temp.svc();
SELECT is(pg_temp.say('22222222-0000-0000-0000-000000000002', 'this is a badword'), 0,
          'a bot answer to a member''s command meets the keyword rule');
SELECT is(pg_temp.say(NULL, 'this is a badword'), 1, 'a bot''s own message stays exempt');
SELECT is(pg_temp.say('11111111-0000-0000-0000-000000000001', 'this is a badword'), 1, 'an answer to the owner is the owner''s');
SELECT is(pg_temp.say('f2578000-0000-0000-0000-0000000000ff', 'this is a badword'), 1,
          'an interaction naming no profile leaves the bot''s exemption');
SELECT throws_like($q$SELECT pg_temp.say('f2571000-0000-0000-0000-000000000002', 'hello')$q$, 'MEMBER_TIMED_OUT:%',
                   'an answer to a timed-out member is refused');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = config_value || '{"new_account_block_links": true}'::jsonb
 WHERE config_key = 'antispam';
SELECT pg_temp.svc();
SELECT throws_ok($q$SELECT pg_temp.say('22222222-0000-0000-0000-000000000002', 'see https://example.com/x')$q$,
                 'P0001', 'ANTISPAM_LINKS_BLOCKED', 'an answer to a new account meets the new-account link limit');
SELECT is(pg_temp.say('f2571000-0000-0000-0000-000000000001', 'see https://example.com/x'), 1,
          'an answer to an older account carries its link');

SELECT tests.clear_authentication();
DELETE FROM public.automod_recent_activity WHERE user_id = 'f2571000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('f2572000-0000-0000-0000-000000000001',
                   '{"name": "Flood", "rule_type": "message_flood", "config": {"max_messages": 2, "window_seconds": 60},
                     "actions": {"block": true}}'::jsonb)$q$, 'the owner adds a flood rule');
SELECT pg_temp.svc();
SELECT is(pg_temp.answer('f2571000-0000-0000-0000-000000000001', 'more 1', true)
          + pg_temp.answer('f2571000-0000-0000-0000-000000000001', 'more 2', true)
          + pg_temp.answer('f2571000-0000-0000-0000-000000000001', 'more 3', true), 3,
          'follow-ups are not counted toward the invoker''s flood limit');
SELECT is(pg_temp.answer('f2571000-0000-0000-0000-000000000001', 'first', false)
          + pg_temp.answer('f2571000-0000-0000-0000-000000000001', 'second', false), 2,
          'two answers within the flood limit');
SELECT is(pg_temp.answer('f2571000-0000-0000-0000-000000000001', 'third', false), 0,
          'a third answer within the window meets the flood rule as the invoker''s message');

-- Retention ---------------------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.bot_interactions (id, bot_id, server_id, channel_id, user_id, command_name, created_at, respond_by, expires_at)
VALUES ('f2579000-0000-0000-0000-000000000001', 'f2577000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001',
        'f2573000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'weather',
        now() - interval '2 days', now() - interval '2 days', now() - interval '25 hours'),
       ('f2579000-0000-0000-0000-000000000002', 'f2577000-0000-0000-0000-000000000001', 'f2572000-0000-0000-0000-000000000001',
        'f2573000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'weather',
        now() - interval '1 day', now() - interval '1 day', now() - interval '23 hours');
SELECT pg_temp.svc();
SELECT lives_ok($q$SELECT public.claim_bot_interactions(ARRAY['f2577000-0000-0000-0000-000000000002']::uuid[])$q$,
                'any claim purges');
SELECT is(ARRAY(SELECT id::text FROM public.bot_interactions WHERE id::text LIKE 'f2579000%' ORDER BY 1),
          ARRAY['f2579000-0000-0000-0000-000000000002'], 'rows 24 h past expires_at go; younger rows stay');

SELECT * FROM finish();
ROLLBACK;
