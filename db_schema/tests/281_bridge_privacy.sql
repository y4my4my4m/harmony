-- Bridge privacy after 20261112600001_bridge_privacy.sql and 20261112600002_bridge_author_index.sql.
--
-- Fixture server_1 (alice owns, bob is a member, mallory is neither) with #general, federating.
-- Added: bridge281 run by bot281, paired with #general, and relayed rows of two Discord authors,
--   dana  ...9001   m1 live, m2 imported, m3 live and the parent of a thread, a thread notice,
--                   a reaction, an AutoMod event
--   eve   ...9002   m4 live, a reaction
-- queue_federation_job is replaced so jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(49);

UPDATE public.servers SET is_local_server = true, federation_enabled = true
 WHERE id = '55555555-0000-0000-0000-000000000005';

CREATE TABLE tests.jobs281 (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs281 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2810000-0000-0000-0000-0000000000b1', 'bot281', 'Bot 281', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2810000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2810000-0000-0000-0000-0000000000b1', '900000000000000281', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2810000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2810000000000000001', 'both');

CREATE FUNCTION pg_temp.relayed(p_id uuid, p_did text, p_author text, p_extra jsonb DEFAULT '{}') RETURNS void
LANGUAGE sql AS $fn$
    INSERT INTO public.messages (id, bot_id, channel_id, content, metadata)
    VALUES (p_id, 'f2810000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'from ' || p_author)),
            jsonb_build_object('discord_user', jsonb_build_object('id', p_author, 'username', 'u' || right(p_author, 1)),
                               'discord_message_id', p_did, 'bot', true, 'created_via', 'bot_api') || p_extra)
$fn$;

SELECT pg_temp.relayed('f2810000-0000-0000-0000-0000000000a1', '2810000000000010001', '2810000000000009001');
SELECT pg_temp.relayed('f2810000-0000-0000-0000-0000000000a3', '2810000000000010003', '2810000000000009001');
SELECT pg_temp.relayed('f2810000-0000-0000-0000-0000000000a4', '2810000000000010004', '2810000000000009002');
-- m2 as the import stores it: quiet, never federated.
SELECT set_config('harmony.history_import', 'true', true);
SELECT pg_temp.relayed('f2810000-0000-0000-0000-0000000000a2', '2810000000000010002', '2810000000000009001',
                       '{"history_import": true, "created_via": "history_import"}');
SELECT set_config('harmony.history_import', 'false', true);

INSERT INTO public.threads (id, channel_id, parent_message_id, name)
VALUES ('f2810000-0000-0000-0000-0000000000c1', '66666666-0000-0000-0000-000000000006',
        'f2810000-0000-0000-0000-0000000000a3', 'thread 281');
-- eve's reply keeps the thread from being emptied when its parent goes.
INSERT INTO public.messages (id, bot_id, channel_id, thread_id, content, metadata)
VALUES ('f2810000-0000-0000-0000-0000000000a7', 'f2810000-0000-0000-0000-0000000000b1',
        '66666666-0000-0000-0000-000000000006', 'f2810000-0000-0000-0000-0000000000c1',
        '[{"type": "text", "text": "in the thread"}]'::jsonb,
        '{"discord_user": {"id": "2810000000000009002", "username": "u2"}, "discord_message_id": "2810000000000010007", "bot": true}'::jsonb);
INSERT INTO public.messages (id, channel_id, content, is_system, metadata)
VALUES ('f2810000-0000-0000-0000-0000000000a5', '66666666-0000-0000-0000-000000000006',
        '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
        '{"type": "thread_created", "thread_name": "thread 281", "bridge_source": "discord",
          "discord_user": {"id": "2810000000000009001", "username": "u1"}}'::jsonb);
INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, channel_id, metadata) VALUES
  ('f2810000-0000-0000-0000-0000000000a4', 'f2810000-0000-0000-0000-0000000000b1', 'a', '66666666-0000-0000-0000-000000000006',
   '{"discord_user": {"id": "2810000000000009001"}}'),
  ('f2810000-0000-0000-0000-0000000000a4', 'f2810000-0000-0000-0000-0000000000b1', 'b', '66666666-0000-0000-0000-000000000006',
   '{"discord_user": {"id": "2810000000000009002"}}');
INSERT INTO public.automod_events (server_id, channel_id, bot_id, event_type, details) VALUES
  ('55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', 'f2810000-0000-0000-0000-0000000000b1',
   'message', '{"author_key": "discord:2810000000000009001", "author_name": "u1"}'),
  ('55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', 'f2810000-0000-0000-0000-0000000000b1',
   'message', '{"author_key": "discord:2810000000000009002", "author_name": "u2"}');
DELETE FROM tests.jobs281;

CREATE FUNCTION pg_temp.live(p_id uuid) RETURNS boolean LANGUAGE sql AS
$fn$ SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.id = p_id) $fn$;

-- Access --------------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_privacy_set_optout(uuid, text, text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.bridge_privacy_erase(uuid, text, text, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_privacy_optout_ids(uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_privacy_status(uuid, text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_privacy_set_optout(uuid, text, text, boolean)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_privacy_erase(uuid, text, text, integer)', 'EXECUTE'),
          'the gateway functions are for the service role alone');
SELECT ok(NOT has_function_privilege('service_role', 'public.bridge_privacy_erase_core(uuid, text, text, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_privacy_erase_core(uuid, text, text, integer)', 'EXECUTE'),
          'no role calls the erase core');
SELECT ok(NOT has_function_privilege('anon', 'public.bridge_privacy_remove_remote_user(uuid, text, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.bridge_privacy_purge_instance(text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.bridge_privacy_remove_remote_user(uuid, text, text)', 'EXECUTE'),
          'the manager functions are for signed-in callers');
SELECT ok(NOT has_table_privilege('authenticated', 'public.bridge_remote_optouts', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.bridge_remote_optouts', 'DELETE')
          AND NOT has_table_privilege('anon', 'public.bridge_remote_optouts', 'SELECT'),
          'clients cannot write the opt-out table');

-- Opt out, status, version ----------------------------------------------------------------------------
SELECT is(public.bridge_privacy_status('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001') ->> 'opted_out',
          'false', 'nobody is opted out at first');
CREATE TEMP TABLE v281 AS
SELECT public.bridge_privacy_optout_ids('55555555-0000-0000-0000-000000000005', 'discord') ->> 'version' AS v0;
UPDATE public.discord_bridges SET updated_at = '2020-01-01T00:00:00Z' WHERE id = 'f2810000-0000-0000-0000-0000000000d1';
SELECT is(public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001', true)
              - 'since',
          '{"opted_out": true, "source": "self", "self": true}'::jsonb, 'opting out answers the new status');
SELECT ok((SELECT updated_at > '2020-01-01T00:00:00Z' FROM public.discord_bridges WHERE id = 'f2810000-0000-0000-0000-0000000000d1'),
          'the bridge row moves, so the gateway pushes the new list version');
UPDATE public.discord_bridges SET updated_at = '2020-01-01T00:00:00Z' WHERE id = 'f2810000-0000-0000-0000-0000000000d1';
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001', true);
SELECT ok((SELECT updated_at = '2020-01-01T00:00:00Z' FROM public.discord_bridges WHERE id = 'f2810000-0000-0000-0000-0000000000d1'),
          'opting out twice changes nothing');
SELECT is(public.bridge_privacy_optout_ids('55555555-0000-0000-0000-000000000005', 'discord') -> 'remote_user_ids',
          '["2810000000000009001"]'::jsonb, 'the list holds the id');
SELECT isnt(public.bridge_privacy_optout_ids('55555555-0000-0000-0000-000000000005', 'discord') ->> 'version',
            (SELECT v0 FROM v281), 'the version changed');
SELECT throws_ok($q$SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'matrix', '@a:b', true)$q$,
                 '0A000', 'unsupported_platform', 'a platform without an author key is refused');
SELECT throws_ok($q$SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', 'dana', true)$q$,
                 '22023', 'invalid_remote_user', 'a Discord id is digits');

-- Guard -----------------------------------------------------------------------------------------------
SELECT throws_ok($q$SELECT pg_temp.relayed(gen_random_uuid(), '2810000000000010009', '2810000000000009001')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'a new relayed row of an opted-out author is refused');
SELECT lives_ok($q$SELECT pg_temp.relayed('f2810000-0000-0000-0000-0000000000a6', '2810000000000010006', '2810000000000009002')$q$,
                'another author''s row is stored');
SELECT throws_ok($q$UPDATE public.messages SET content = '[{"type": "text", "text": "edited"}]'
                     WHERE id = 'f2810000-0000-0000-0000-0000000000a1'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'an edit of the opted-out author''s row is refused');
SELECT lives_ok($q$UPDATE public.messages SET is_pinned = true WHERE id = 'f2810000-0000-0000-0000-0000000000a1'$q$,
                'a write that leaves the content alone passes');

-- Opting in ---------------------------------------------------------------------------------------------
SELECT is(public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001', false)
              ->> 'opted_out', 'false', 'opting in removes a self row');
SELECT lives_ok($q$UPDATE public.messages SET content = '[{"type": "text", "text": "edited"}]'
                    WHERE id = 'f2810000-0000-0000-0000-0000000000a1'$q$,
                'and the edit passes again');
UPDATE public.messages SET is_pinned = false WHERE id = 'f2810000-0000-0000-0000-0000000000a1';
DELETE FROM tests.jobs281;

-- Removal by a manager -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001')$q$,
                 '42501', NULL, 'a member without Manage Server cannot remove a bridged user');
SELECT is((SELECT count(*) FROM public.bridge_remote_optouts), 0::bigint, 'and reads no opt-out');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.bridge_privacy_purge_server('55555555-0000-0000-0000-000000000005', 'discord')$q$,
                 '42501', NULL, 'an outsider cannot purge the server');
SELECT throws_ok($q$SELECT public.bridge_privacy_purge_instance('discord')$q$,
                 '42501', NULL, 'nor the instance');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE e281 AS
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001') AS j;
SELECT is((SELECT j FROM e281), '{"erased": 4, "more": false}'::jsonb, 'the owner removes dana: four rows, nothing left');
SELECT is((SELECT (source, created_by)::text FROM public.bridge_remote_optouts
            WHERE remote_user_id = '2810000000000009001'),
          '(manager,11111111-0000-0000-0000-000000000001)', 'dana is opted out by the manager, who reads the row');
SELECT tests.clear_authentication();

SELECT ok(NOT pg_temp.live('f2810000-0000-0000-0000-0000000000a1'), 'the live message is deleted');
SELECT ok(NOT pg_temp.live('f2810000-0000-0000-0000-0000000000a2'), 'the imported message is deleted');
SELECT is((SELECT (is_deleted, content, metadata)::text FROM public.messages WHERE id = 'f2810000-0000-0000-0000-0000000000a3'),
          '(t,"[{""text"": """", ""type"": ""text""}]","{""bot"": true, ""created_via"": ""bot_api"", ""bridge_erased"": true}")',
          'the thread parent stays as a tombstone without content or author');
SELECT ok(EXISTS (SELECT 1 FROM public.threads WHERE id = 'f2810000-0000-0000-0000-0000000000c1'), 'its thread stays');
SELECT is((SELECT metadata ? 'discord_user' FROM public.messages WHERE id = 'f2810000-0000-0000-0000-0000000000a5'),
          false, 'the thread notice no longer names dana');
SELECT is((SELECT metadata ->> 'type' FROM public.messages WHERE id = 'f2810000-0000-0000-0000-0000000000a5'),
          'thread_created', 'and is otherwise intact');
SELECT is((SELECT array_agg(custom_emoji_content ORDER BY custom_emoji_content)::text FROM public.reactions
            WHERE message_id = 'f2810000-0000-0000-0000-0000000000a4'), '{b}', 'dana''s reaction is gone, eve''s stays');
SELECT is((SELECT array_agg(details ->> 'author_name')::text FROM public.automod_events
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND details ? 'author_key'),
          '{u2}', 'dana''s AutoMod event is gone, eve''s stays');
SELECT ok(pg_temp.live('f2810000-0000-0000-0000-0000000000a4') AND pg_temp.live('f2810000-0000-0000-0000-0000000000a6'),
          'eve''s messages are untouched');
SELECT is((SELECT array_agg(data ->> 'message_id' ORDER BY data ->> 'message_id')::text FROM tests.jobs281
            WHERE name = 'federate-channel-message-delete'),
          '{f2810000-0000-0000-0000-0000000000a1,f2810000-0000-0000-0000-0000000000a3}',
          'a federated Delete is queued for the rows that federated, none for the imported one');

SELECT is(public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001', false)
              ->> 'source', 'manager', 'opting in does not lift a manager''s removal');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001')$q$,
                 '42501', NULL, 'a member cannot restore');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009001'),
          true, 'the manager restores dana');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*) FROM public.bridge_remote_optouts), 0::bigint, 'no opt-out is left');

-- Erase through the gateway, in batches ------------------------------------------------------------------
SELECT pg_temp.relayed(gen_random_uuid(), (2810000000000020000 + g)::text, '2810000000000009003') FROM generate_series(1, 5) g;
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009003', 2),
          '{"opted_out": true, "erased": 2, "more": true}'::jsonb, 'a batch of two of five');
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009003', 2) -> 'more',
          'true'::jsonb, 'two more');
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2810000000000009003', 2),
          '{"opted_out": true, "erased": 1, "more": false}'::jsonb, 'the last one');
SELECT is((SELECT count(*) FROM public.messages WHERE metadata #>> '{discord_user,id}' = '2810000000000009003'),
          0::bigint, 'none of that author is left');
SELECT is((SELECT source FROM public.bridge_remote_optouts WHERE remote_user_id = '2810000000000009003'),
          'self', 'erasing opts the author out');
SELECT is((SELECT count(*) FROM public.bridge_remote_optouts o WHERE o.remote_user_id = '2810000000000009003'),
          1::bigint, 'once');

-- Purge ---------------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_purge_server('55555555-0000-0000-0000-000000000005', 'discord'),
          '{"erased": 3, "more": false}'::jsonb, 'the owner purges the server: eve''s three messages');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*) FROM public.bridge_remote_optouts), 1::bigint, 'a purge keeps the opt-outs');
SELECT is((SELECT count(*) FROM public.messages WHERE metadata ? 'discord_user'), 0::bigint, 'no relayed author is left in a message');
SELECT is((SELECT count(*) FROM public.reactions WHERE metadata ? 'discord_user'), 0::bigint, 'nor in a reaction');

UPDATE public.profiles SET is_admin = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT pg_temp.relayed(gen_random_uuid(), '2810000000000030001', '2810000000000009004');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.bridge_privacy_purge_instance('discord'), '{"erased": 1, "more": false}'::jsonb,
          'an instance admin purges every server');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
