-- The quiet-import flag after 20261110900004_history_import_quiet.sql.
--
-- Rows inserted while harmony.history_import is 'true' (public.is_history_import()) must leave no
-- trace beyond the row itself: no notification, push job, unread or channel head change,
-- federation job, realtime broadcast, link-preview fetch or thread bump. Each assertion pair
-- compares a control insert (flag off) with the same insert under the flag.
--
-- Fixture server_1: alice owns it, bob is a member. Added: bot248; carol248 (member, the quiet side's
-- newcomer where bob is the control's); r248, a
-- mentionable role held by alice; alice reads every message of #ctl248 and #quiet248; slowmode on
-- #slow248. The control side uses #ctl248 and thread tc248, the quiet side #quiet248 and tq248.
-- queue_federation_job is replaced so jobs (federation and push) can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(59);

UPDATE public.servers SET is_local_server = true, federation_enabled = true
 WHERE id = '55555555-0000-0000-0000-000000000005';

INSERT INTO public.bots (id, username, display_name, owner_id) VALUES
  ('f2480000-0000-0000-0000-0000000000b1', 'bot248', 'Bot 248', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.profiles (id, username, display_name, is_local) VALUES
  ('f2480000-0000-0000-0000-0000000000c1', 'carol248', 'Carol', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f2480000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');

INSERT INTO public.channels (id, server_id, name, type, slowmode_seconds) VALUES
  ('f2480000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'ctl248', 0, 0),
  ('f2480000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'quiet248', 0, 0),
  ('f2480000-0000-0000-0000-0000000000a3', '55555555-0000-0000-0000-000000000005', 'slow248', 0, 60);
INSERT INTO public.notification_channels (user_id, channel_id, notification_level) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2480000-0000-0000-0000-0000000000a1', 'all'),
  ('11111111-0000-0000-0000-000000000001', 'f2480000-0000-0000-0000-0000000000a2', 'all');
INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable)
VALUES ('f2480000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'r248', 1, 0, true);
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('11111111-0000-0000-0000-000000000001', 'f2480000-0000-0000-0000-0000000000e1',
        '55555555-0000-0000-0000-000000000005');

CREATE TABLE tests.jobs248 (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs248 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE TEMP SEQUENCE s248;

-- Inserts a message and returns its id. p_quiet runs the insert under the flag with created_at two
-- years back; p_upd is the offset of the supplied updated_at from created_at (NULL: not supplied).
-- The author is bot248 unless p_user is given.
CREATE FUNCTION pg_temp.put(p_channel uuid, p_content jsonb, p_quiet boolean, p_thread uuid DEFAULT NULL,
                            p_user uuid DEFAULT NULL, p_upd interval DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
    v uuid;
    v_at timestamptz := CASE WHEN p_quiet THEN now() - interval '2 years' ELSE now() END;
    v_bot uuid := CASE WHEN p_user IS NULL THEN 'f2480000-0000-0000-0000-0000000000b1'::uuid END;
    v_meta jsonb := jsonb_build_object('discord_message_id', nextval('s248')::text);
BEGIN
    IF p_quiet THEN PERFORM set_config('harmony.history_import', 'true', true); END IF;
    IF p_upd IS NULL THEN
        INSERT INTO public.messages (channel_id, user_id, bot_id, thread_id, content, metadata, created_at)
        VALUES (p_channel, p_user, v_bot, p_thread, p_content, v_meta, v_at) RETURNING id INTO v;
    ELSE
        INSERT INTO public.messages (channel_id, user_id, bot_id, thread_id, content, metadata, created_at, updated_at)
        VALUES (p_channel, p_user, v_bot, p_thread, p_content, v_meta, v_at, v_at + p_upd) RETURNING id INTO v;
    END IF;
    PERFORM set_config('harmony.history_import', 'false', true);
    RETURN v;
END;
$fn$;

-- Runs one statement under the flag (or not).
CREATE FUNCTION pg_temp.run(p_sql text, p_quiet boolean) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
    IF p_quiet THEN PERFORM set_config('harmony.history_import', 'true', true); END IF;
    EXECUTE p_sql;
    PERFORM set_config('harmony.history_import', 'false', true);
END;
$fn$;

CREATE FUNCTION pg_temp.txt(p text) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', p)) $fn$;

CREATE TEMP TABLE k248 (k text PRIMARY KEY, id uuid);
GRANT SELECT ON k248 TO authenticated;

-- One side: k-prefix p ('c' control, 'q' quiet), its channel, parent message, thread.
CREATE FUNCTION pg_temp.side(p_pfx text, p_channel uuid, p_thread uuid, p_quiet boolean, p_author uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
    v_parent uuid;
BEGIN
    v_parent := pg_temp.put(p_channel, pg_temp.txt('thread parent ' || p_pfx), p_quiet);
    INSERT INTO k248 VALUES (p_pfx || 'parent', v_parent);

    IF p_quiet THEN PERFORM set_config('harmony.history_import', 'true', true); END IF;
    INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, archived, created_at, updated_at,
                                last_message_at)
    VALUES (p_thread, p_channel, v_parent, 'old thread ' || p_pfx, '22222222-0000-0000-0000-000000000002', true,
            '2020-01-01 00:00+00', '2020-01-02 00:00+00', '2020-01-02 00:00+00');
    PERFORM set_config('harmony.history_import', 'false', true);

    -- A mention of bob, a link to alice's profile, and the search word.
    INSERT INTO k248 VALUES (p_pfx || 'mention', pg_temp.put(p_channel, jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', 'zebrafish ' || p_pfx),
        jsonb_build_object('type', 'mention', 'userId', '22222222-0000-0000-0000-000000000002', 'username', 'bob'),
        jsonb_build_object('type', 'url', 'url', 'https://localhost/@alice')), p_quiet, NULL, NULL, interval '1 day'));
    INSERT INTO k248 VALUES (p_pfx || 'role', pg_temp.put(p_channel, jsonb_build_array(
        jsonb_build_object('type', 'role_mention', 'roleId', 'f2480000-0000-0000-0000-0000000000e1',
                           'roleName', 'r248')), p_quiet));
    INSERT INTO k248 VALUES (p_pfx || 'plain', pg_temp.put(p_channel, pg_temp.txt('zebrafish plain ' || p_pfx), p_quiet));
    INSERT INTO k248 VALUES (p_pfx || 'reply', pg_temp.put(p_channel, pg_temp.txt('thread reply ' || p_pfx), p_quiet, p_thread));
    -- A newcomer's first message in the server.
    INSERT INTO k248 VALUES (p_pfx || 'bob', pg_temp.put(p_channel, pg_temp.txt('hello ' || p_pfx), p_quiet,
                                                         NULL, p_author));
    -- Changes after the insert: pin, edit, soft delete.
    PERFORM pg_temp.run(format('UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id = %L',
                               (SELECT id FROM k248 WHERE k = p_pfx || 'role')), p_quiet);
    PERFORM pg_temp.run(format($q$UPDATE public.messages SET content = %L WHERE id = %L$q$,
                               pg_temp.txt('edited ' || p_pfx), (SELECT id FROM k248 WHERE k = p_pfx || 'role')), p_quiet);
    PERFORM pg_temp.run(format('UPDATE public.messages SET is_deleted = true WHERE id = %L',
                               (SELECT id FROM k248 WHERE k = p_pfx || 'role')), p_quiet);
    PERFORM pg_temp.run(format($q$UPDATE public.threads SET name = 'renamed' WHERE id = %L$q$, p_thread), p_quiet);
END;
$fn$;

-- The flag --------------------------------------------------------------------------------------
SELECT is(public.is_history_import(), false, 'the flag is off by default');
SELECT set_config('harmony.history_import', 'true', true);
SELECT is(public.is_history_import(), true, 'it reads on when the setting is true');
SELECT set_config('harmony.history_import', 'false', true);
SELECT is(public.is_history_import(), false, 'and off when it is false');
SELECT ok(NOT has_function_privilege('anon', 'public.is_history_import()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.is_history_import()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.is_history_import()', 'EXECUTE'),
          'only the service role can call it');

-- Quiet side first (so bob has no first message yet), then the control. -----------------------------
SELECT pg_temp.side('q', 'f2480000-0000-0000-0000-0000000000a2', 'f2480000-0000-0000-0000-0000000000d2', true,
                     'f2480000-0000-0000-0000-0000000000c1');
SELECT pg_temp.side('c', 'f2480000-0000-0000-0000-0000000000a1', 'f2480000-0000-0000-0000-0000000000d1', false,
                     '22222222-0000-0000-0000-000000000002');

CREATE FUNCTION pg_temp.notes(p_type text, p_key text) RETURNS int LANGUAGE sql AS $fn$
    SELECT count(*)::int FROM public.notifications n
     WHERE n.type = p_type AND n.data->>'message_id' = (SELECT id::text FROM k248 WHERE k = p_key);
$fn$;
CREATE FUNCTION pg_temp.jobs(p_name text, p_pfx text) RETURNS int LANGUAGE sql AS $fn$
    SELECT count(*)::int FROM tests.jobs248 j
     WHERE j.name = p_name AND j.data->>'message_id' IN (SELECT id::text FROM k248 WHERE k LIKE p_pfx || '%');
$fn$;
CREATE FUNCTION pg_temp.bcast(p_pfx text) RETURNS int LANGUAGE sql AS $fn$
    SELECT count(*)::int FROM realtime.messages r
     WHERE r.topic = 'channel-messages-' || CASE p_pfx WHEN 'c' THEN 'f2480000-0000-0000-0000-0000000000a1'
                                                       ELSE 'f2480000-0000-0000-0000-0000000000a2' END;
$fn$;

-- Notifications -----------------------------------------------------------------------------------
SELECT is(pg_temp.notes('mention', 'cmention'), 1, 'control: a mention notifies');
SELECT is(pg_temp.notes('mention', 'qmention'), 0, 'quiet: a mention notifies no one');
SELECT is(pg_temp.notes('mention', 'crole'), 1, 'control: a role mention notifies');
SELECT is(pg_temp.notes('mention', 'qrole'), 0, 'quiet: a role mention notifies no one');
SELECT is(pg_temp.notes('channel_message', 'cplain'), 1, 'control: a channel set to all notifies');
SELECT is(pg_temp.notes('channel_message', 'qplain'), 0, 'quiet: a channel set to all notifies no one');
SELECT is(pg_temp.notes('thread_reply', 'creply'), 1, 'control: a thread reply notifies the thread creator');
SELECT is(pg_temp.notes('thread_reply', 'qreply'), 0, 'quiet: a thread reply notifies no one');
SELECT is(pg_temp.notes('newcomer_message', 'cbob'), 1, 'control: a newcomer''s first message alerts the staff');
SELECT is(pg_temp.notes('newcomer_message', 'qbob'), 0, 'quiet: it alerts no one');
SELECT is((SELECT count(*)::int FROM public.notifications n
            WHERE n.data->>'message_id' IN (SELECT id::text FROM k248 WHERE k LIKE 'q%')), 0,
          'quiet: no notification of any type names a quiet message');
SELECT is((SELECT count(*)::int FROM public.server_first_messages WHERE user_id = '22222222-0000-0000-0000-000000000002'), 1,
          'control: a first message is recorded');
SELECT is((SELECT count(*)::int FROM public.server_first_messages WHERE user_id = 'f2480000-0000-0000-0000-0000000000c1'), 0,
          'quiet: it is not');

-- Push --------------------------------------------------------------------------------------------
SELECT ok((SELECT count(*) FROM tests.jobs248 j JOIN public.notifications n ON n.id::text = j.data->>'notification_id'
            WHERE j.name = 'send-push-notification'
              AND n.data->>'message_id' IN (SELECT id::text FROM k248 WHERE k LIKE 'c%')) > 0,
          'control: notifications queue push jobs');
SELECT is((SELECT count(*)::int FROM tests.jobs248 j WHERE j.name = 'send-push-notification'
             AND j.data->'data'->>'message_id' IN (SELECT id::text FROM k248 WHERE k LIKE 'q%')), 0,
          'quiet: no push job names a quiet message');

-- Unread and last activity of the channel ---------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.message_heads WHERE channel_id = 'f2480000-0000-0000-0000-0000000000a1'), 1,
          'control: the channel has a head');
SELECT is((SELECT count(*)::int FROM public.message_heads WHERE channel_id = 'f2480000-0000-0000-0000-0000000000a2'), 0,
          'quiet: the channel has no head: no sequence, last message or last time');
SELECT ok((SELECT count(*) FROM public.unread_counts WHERE channel_id = 'f2480000-0000-0000-0000-0000000000a1') > 0,
          'control: unread rows exist');
SELECT is((SELECT count(*)::int FROM public.unread_counts WHERE channel_id = 'f2480000-0000-0000-0000-0000000000a2'), 0,
          'quiet: no unread row');

-- Federation ----------------------------------------------------------------------------------------
SELECT is(pg_temp.jobs('federate-channel-message', 'c'), 6, 'control: every message is queued to federate');
SELECT is(pg_temp.jobs('federate-channel-message', 'q'), 0, 'quiet: none is');
SELECT is((SELECT array_agg(DISTINCT federation_status) FROM public.messages
            WHERE id IN (SELECT id FROM k248 WHERE k LIKE 'q%')), ARRAY['skipped'],
          'quiet: the rows are marked skipped, not left pending');
SELECT is(pg_temp.jobs('federate-channel-pin', 'c'), 1, 'control: a pin federates');
SELECT is(pg_temp.jobs('federate-channel-pin', 'q'), 0, 'quiet: a pin does not');
SELECT is(pg_temp.jobs('federate-channel-message-edit', 'c'), 1, 'control: an edit federates');
SELECT is(pg_temp.jobs('federate-channel-message-edit', 'q'), 0, 'quiet: an edit does not');
SELECT is(pg_temp.jobs('federate-channel-message-delete', 'c'), 1, 'control: a delete federates');
SELECT is(pg_temp.jobs('federate-channel-message-delete', 'q'), 0, 'quiet: a delete does not');
SELECT ok((SELECT count(*) FROM tests.jobs248 WHERE name = 'federate-thread'
             AND data->>'thread_id' = 'f2480000-0000-0000-0000-0000000000d1') > 0,
          'control: a thread queues federation jobs');
SELECT is((SELECT count(*)::int FROM tests.jobs248 WHERE name = 'federate-thread'
             AND data->>'thread_id' = 'f2480000-0000-0000-0000-0000000000d2'), 0,
          'quiet: a thread creates none, and its update none');
SELECT is((SELECT federation_status FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d2'), 'skipped',
          'quiet: the thread is marked skipped');

-- Realtime ------------------------------------------------------------------------------------------
SELECT ok(pg_temp.bcast('c') > 0, 'control: messages are broadcast to the channel');
SELECT is(pg_temp.bcast('q'), 0, 'quiet: nothing is broadcast to the channel');
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic = 'thread-messages-f2480000-0000-0000-0000-0000000000d2'), 0,
          'quiet: nothing is broadcast to the thread');
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic LIKE 'server-structure:%'
             AND payload::text LIKE '%f2480000-0000-0000-0000-0000000000d2%'), 0,
          'quiet: the thread change is not broadcast');
SELECT ok((SELECT count(*) FROM realtime.messages WHERE topic LIKE 'server-structure:%'
             AND payload::text LIKE '%f2480000-0000-0000-0000-0000000000d1%') > 0,
          'control: the thread change is broadcast');

-- Link previews, updated_at ---------------------------------------------------------------------------
SELECT ok((SELECT metadata ? 'embeds' FROM public.messages WHERE id = (SELECT id FROM k248 WHERE k = 'cmention')),
          'control: a link to this instance gets a preview');
SELECT ok((SELECT NOT metadata ? 'embeds' FROM public.messages WHERE id = (SELECT id FROM k248 WHERE k = 'qmention')),
          'quiet: no preview is fetched');
SELECT is((SELECT updated_at - created_at FROM public.messages WHERE id = (SELECT id FROM k248 WHERE k = 'cmention')),
          interval '0', 'control: a supplied updated_at is replaced by created_at');
SELECT is((SELECT updated_at - created_at FROM public.messages WHERE id = (SELECT id FROM k248 WHERE k = 'qmention')),
          interval '1 day', 'quiet: a supplied updated_at after created_at is kept');
SELECT is((SELECT updated_at - created_at FROM public.messages WHERE id = (SELECT id FROM k248 WHERE k = 'qplain')),
          interval '0', 'quiet: without one, updated_at is created_at');

-- Threads ---------------------------------------------------------------------------------------------
SELECT is((SELECT archived FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d1'), false,
          'control: a reply unarchives the thread');
SELECT is((SELECT archived FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d2'), true,
          'quiet: a reply leaves it archived');
SELECT is((SELECT last_message_at FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d1') > now() - interval '1 minute',
          true, 'control: a reply moves the thread''s last message time');
SELECT is((SELECT last_message_at FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d2'),
          '2020-01-02 00:00+00'::timestamptz, 'quiet: the last message time stays');
SELECT is((SELECT last_message_id FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d2'), NULL::uuid,
          'quiet: the last message stays unset');
SELECT is((SELECT updated_at FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d2'),
          '2020-01-02 00:00+00'::timestamptz, 'quiet: even a rename leaves the thread''s updated_at');
SELECT is((SELECT updated_at > now() - interval '1 minute' FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d1'),
          true, 'control: a rename moves it');
SELECT is((SELECT message_count FROM public.threads WHERE id = 'f2480000-0000-0000-0000-0000000000d2'), 1,
          'quiet: the reply still counts');

-- AutoMod -----------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.upsert_server_automod_rule('55555555-0000-0000-0000-000000000005',
    '{"name": "No blocklisted248", "rule_type": "keyword", "config": {"keywords": ["blocklisted248"]},
      "actions": {"block": true}}'::jsonb);
SELECT tests.clear_authentication();
SELECT is(pg_temp.put('f2480000-0000-0000-0000-0000000000a1', pg_temp.txt('blocklisted248'), false, NULL,
                      '22222222-0000-0000-0000-000000000002'), NULL::uuid,
          'control: AutoMod blocks a live message');
SELECT isnt(pg_temp.put('f2480000-0000-0000-0000-0000000000a2', pg_temp.txt('blocklisted248'), true, NULL,
                        '22222222-0000-0000-0000-000000000002'), NULL::uuid,
            'quiet: AutoMod lets an imported message through');

-- Slowmode, search ---------------------------------------------------------------------------------------
SELECT lives_ok($q$SELECT pg_temp.put('f2480000-0000-0000-0000-0000000000a3', pg_temp.txt('first'), false, NULL,
                                      'f2480000-0000-0000-0000-0000000000c1')$q$,
                'a live message from a member');
SELECT lives_ok($q$SELECT pg_temp.put('f2480000-0000-0000-0000-0000000000a3', pg_temp.txt('imported'), true, NULL,
                                      'f2480000-0000-0000-0000-0000000000c1')$q$,
                'quiet: slowmode does not stop an imported message');
SELECT throws_ok($q$SELECT pg_temp.put('f2480000-0000-0000-0000-0000000000a3', pg_temp.txt('second'), false, NULL,
                                       'f2480000-0000-0000-0000-0000000000c1')$q$,
                 'P0001', NULL, 'control: slowmode stops the next live one');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(message_id ORDER BY message_id) FROM public.search_messages(
              p_query => 'zebrafish', p_channel_ids => ARRAY['f2480000-0000-0000-0000-0000000000a2']::uuid[])),
          (SELECT array_agg(id ORDER BY id) FROM k248 WHERE k IN ('qmention', 'qplain')),
          'quiet: the imported messages are found by search');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
