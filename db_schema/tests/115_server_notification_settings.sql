-- Server, category and channel notification settings after
-- 20261011200001_server_notification_settings.sql.
--
-- Fixture server_1: alice owns it and posts every message; bob is the member whose settings
-- are under test; mallory is no member; banned holds a banned row. Added: category k115 with
-- channels a115 and b115, and role r115 (mentionable) held by bob. #general has no category.
-- got(message) is bob's notifications for one message: type, :everyone or :role for role
-- mentions, '-' for none. kinds(channel) posts a plain message, a mention of bob, a mention of
-- r115 and @everyone, and returns got() of each.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(53);

INSERT INTO public.channel_categories (id, server_id, name)
VALUES ('f1150000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'k115');
INSERT INTO public.channels (id, server_id, name, type, category) VALUES
  ('f1150000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'a115', 0,
   'f1150000-0000-0000-0000-0000000000c1'),
  ('f1150000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'b115', 0,
   'f1150000-0000-0000-0000-0000000000c1');
INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable)
VALUES ('f1150000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'r115', 1, 0, true);
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1150000-0000-0000-0000-0000000000e1',
        '55555555-0000-0000-0000-000000000005');

SELECT set_config('tests.everyone115',
                  (SELECT id::text FROM public.server_roles
                    WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), true);

CREATE TABLE tests.jobs115 (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs115 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE FUNCTION pg_temp.post(p_channel uuid, p_content jsonb) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
    v uuid;
BEGIN
    INSERT INTO public.messages (channel_id, user_id, content)
    VALUES (p_channel, '11111111-0000-0000-0000-000000000001', p_content)
    RETURNING id INTO v;
    RETURN v;
END;
$fn$;

CREATE FUNCTION pg_temp.got(p_message uuid) RETURNS text LANGUAGE sql AS $fn$
    SELECT COALESCE(string_agg(n.type || CASE WHEN n.data->>'is_everyone' = 'true' THEN ':everyone'
                                              WHEN n.data->>'is_role_mention' = 'true' THEN ':role'
                                              ELSE '' END, ',' ORDER BY n.type), '-')
      FROM public.notifications n
     WHERE n.user_id = '22222222-0000-0000-0000-000000000002'
       AND n.data->>'message_id' = p_message::text;
$fn$;

CREATE FUNCTION pg_temp.plain() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"text","text":"plain"}]'::jsonb $fn$;
CREATE FUNCTION pg_temp.at_bob() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob"}]'::jsonb $fn$;
CREATE FUNCTION pg_temp.at_role() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"role_mention","roleId":"f1150000-0000-0000-0000-0000000000e1"}]'::jsonb $fn$;
CREATE FUNCTION pg_temp.at_everyone() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_array(jsonb_build_object('type', 'role_mention',
                                                 'roleId', current_setting('tests.everyone115'))) $fn$;

CREATE FUNCTION pg_temp.kinds(p_channel uuid) RETURNS text[] LANGUAGE plpgsql AS $fn$
DECLARE
    r text[] := '{}';
BEGIN
    r := r || pg_temp.got(pg_temp.post(p_channel, pg_temp.plain()));
    r := r || pg_temp.got(pg_temp.post(p_channel, pg_temp.at_bob()));
    r := r || pg_temp.got(pg_temp.post(p_channel, pg_temp.at_role()));
    r := r || pg_temp.got(pg_temp.post(p_channel, pg_temp.at_everyone()));
    RETURN r;
END;
$fn$;

-- Levels notification_policy() resolves for bob in a115, b115 and #general.
CREATE FUNCTION pg_temp.levels() RETURNS text[] LANGUAGE sql AS $fn$
    SELECT ARRAY(
        SELECT (SELECT p.level FROM public.notification_policy('22222222-0000-0000-0000-000000000002',
                                                               '55555555-0000-0000-0000-000000000005', c) p)
          FROM unnest(ARRAY['f1150000-0000-0000-0000-0000000000a1',
                            'f1150000-0000-0000-0000-0000000000a2',
                            '66666666-0000-0000-0000-000000000006']::uuid[]) WITH ORDINALITY AS t(c, i)
         ORDER BY i);
$fn$;

-- As bob.
CREATE FUNCTION pg_temp.server(p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v jsonb;
BEGIN
    PERFORM tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
    v := public.update_server_notification_settings('55555555-0000-0000-0000-000000000005', p_changes);
    PERFORM tests.clear_authentication();
    RETURN v;
END;
$fn$;

CREATE FUNCTION pg_temp.channel(p_channel uuid, p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v jsonb;
BEGIN
    PERFORM tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
    v := public.update_channel_notification_override(p_channel, p_changes);
    PERFORM tests.clear_authentication();
    RETURN v;
END;
$fn$;

CREATE FUNCTION pg_temp.category(p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v jsonb;
BEGIN
    PERFORM tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
    v := public.update_category_notification_override('f1150000-0000-0000-0000-0000000000c1', p_changes);
    PERFORM tests.clear_authentication();
    RETURN v;
END;
$fn$;

-- Grants ----------------------------------------------------------------------------------
SELECT ok(
    (SELECT bool_and(has_function_privilege('authenticated', f, 'EXECUTE')
                     AND has_function_privilege('service_role', f, 'EXECUTE')
                     AND NOT has_function_privilege('anon', f, 'EXECUTE'))
       FROM unnest(ARRAY['public.get_server_notification_settings(uuid)',
                         'public.update_server_notification_settings(uuid, jsonb)',
                         'public.update_channel_notification_override(uuid, jsonb)',
                         'public.update_category_notification_override(uuid, jsonb)']) f),
    'the settings RPCs are for signed-in users');
SELECT ok(
    (SELECT bool_and(NOT has_function_privilege('authenticated', f, 'EXECUTE')
                     AND NOT has_function_privilege('anon', f, 'EXECUTE'))
       FROM unnest(ARRAY['public.notification_policy(uuid, uuid, uuid)',
                         'public.channel_mute_active(uuid, uuid)',
                         'public.notification_settings_state(uuid, uuid)',
                         'public.apply_notification_override(uuid, uuid, uuid, uuid, jsonb)',
                         'public.handle_channel_message_notifications()',
                         'public.sync_unread_category_mute(uuid, uuid)']) f),
    'resolution and write helpers are internal');
SELECT ok(has_table_privilege('authenticated', 'public.notification_servers', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.notification_servers', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.notification_servers', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.notification_servers', 'SELECT'),
          'notification_servers is read by its owner and written through the RPCs');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.get_server_notification_settings('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'anon is refused');
SELECT tests.clear_authentication();

-- Membership ------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.get_server_notification_settings('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', 'Not a member of this server', 'a non-member reads nothing');
SELECT throws_ok($q$SELECT public.update_channel_notification_override('66666666-0000-0000-0000-000000000006', '{"level":"all"}')$q$,
                 '42501', 'Not a member of this server', 'a non-member writes no channel override');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.update_server_notification_settings('55555555-0000-0000-0000-000000000005', '{"level":"all"}')$q$,
                 '42501', 'Not a member of this server', 'a banned member writes nothing');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.get_server_notification_settings('55555555-0000-0000-0000-000000000005')
              - 'channels' - 'categories' - 'server_id',
          '{"level": null, "muted": false, "muted_until": null, "overrides": [], "push_notifications": true,
            "server_default": "mentions", "suppress_roles": false, "suppress_everyone": false}'::jsonb,
          'a member with no settings reads the defaults');
SELECT ok((SELECT array_agg(c->>'id')
              FROM jsonb_array_elements(public.get_server_notification_settings('55555555-0000-0000-0000-000000000005')->'channels') c)
          @> ARRAY['f1150000-0000-0000-0000-0000000000a1', 'f1150000-0000-0000-0000-0000000000a2',
                   '66666666-0000-0000-0000-000000000006'],
          'the picker lists the channels the member can view');
SELECT tests.clear_authentication();

-- Resolution order --------------------------------------------------------------------------
SELECT is(pg_temp.levels(), ARRAY['mentions', 'mentions', 'mentions'], 'nothing set: mentions');
INSERT INTO public.server_settings (server_id, default_message_notifications)
VALUES ('55555555-0000-0000-0000-000000000005', 'all');
SELECT is(pg_temp.levels(), ARRAY['all', 'all', 'all'], 'the server default applies next');
SELECT pg_temp.server('{"level":"none"}');
SELECT is(pg_temp.levels(), ARRAY['none', 'none', 'none'], 'the member''s server level overrides the server default');
SELECT pg_temp.category('{"level":"mentions"}');
SELECT is(pg_temp.levels(), ARRAY['mentions', 'mentions', 'none'], 'a category override overrides the server level');
SELECT pg_temp.channel('f1150000-0000-0000-0000-0000000000a1', '{"level":"all"}');
SELECT is(pg_temp.levels(), ARRAY['all', 'mentions', 'none'], 'a channel override overrides its category');

SELECT is((SELECT array_agg(COALESCE(o->>'channel_id', o->>'category_id') || '/' || (o->>'level')
                            ORDER BY o->>'level')
             FROM jsonb_array_elements(pg_temp.channel('f1150000-0000-0000-0000-0000000000a1', '{}')->'overrides') o),
          ARRAY['f1150000-0000-0000-0000-0000000000a1/all', 'f1150000-0000-0000-0000-0000000000c1/mentions'],
          'the state lists the channel and the category override');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.notification_servers), 0, 'another member cannot read bob''s settings');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.notification_servers), 1, 'bob reads his own');
SELECT throws_ok($q$SELECT public.update_channel_notification_override('f1150000-0000-0000-0000-0000000000a2', '{"level":"loud"}')$q$,
                 '22023', NULL, 'an unknown level is refused');
SELECT throws_ok($q$SELECT public.update_server_notification_settings('55555555-0000-0000-0000-000000000005',
                       jsonb_build_object('muted', true, 'muted_until', now() - interval '1 minute'))$q$,
                 '22023', NULL, 'a mute ending in the past is refused');
SELECT throws_ok($q$SELECT public.update_server_notification_settings('55555555-0000-0000-0000-000000000005', '{"volume":1}')$q$,
                 '22023', NULL, 'an unknown setting is refused');
SELECT tests.clear_authentication();

-- Clear everything but the server default ('all').
SELECT pg_temp.channel('f1150000-0000-0000-0000-0000000000a1', '{"level":null}');
SELECT pg_temp.category('{"level":null}');
SELECT is((SELECT count(*)::int FROM public.notification_channels
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND (channel_id = 'f1150000-0000-0000-0000-0000000000a1'
                   OR category_id = 'f1150000-0000-0000-0000-0000000000c1')),
          0, 'an override left with no level and no mute is removed');
UPDATE public.server_settings SET default_message_notifications = 'mentions'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';

-- Levels by message kind (#general, the member's server level) ----------------------------
SELECT pg_temp.server('{"level":"all"}');
SELECT is(pg_temp.kinds('66666666-0000-0000-0000-000000000006'),
          ARRAY['channel_message', 'mention', 'mention:role', 'mention:everyone'],
          'all: every message notifies once; a mention replaces the message notification');
SELECT pg_temp.server('{"level":"mentions"}');
SELECT is(pg_temp.kinds('66666666-0000-0000-0000-000000000006'),
          ARRAY['-', 'mention', 'mention:role', 'mention:everyone'],
          'mentions: user, role and @everyone mentions');
SELECT pg_temp.server('{"level":"none"}');
SELECT is(pg_temp.kinds('66666666-0000-0000-0000-000000000006'),
          ARRAY['-', '-', '-', '-'], 'none: nothing, mentions included');

SELECT pg_temp.server('{"level":null}');
UPDATE public.server_settings SET default_message_notifications = 'all'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.plain())),
          'channel_message', 'a server default of all notifies a member who set nothing');
UPDATE public.server_settings SET default_message_notifications = 'mentions'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';

-- Overrides drive notifications
SELECT pg_temp.server('{"level":"all"}');
SELECT pg_temp.channel('f1150000-0000-0000-0000-0000000000a1', '{"level":"none"}');
SELECT is(ARRAY[pg_temp.got(pg_temp.post('f1150000-0000-0000-0000-0000000000a1', pg_temp.plain())),
                pg_temp.got(pg_temp.post('f1150000-0000-0000-0000-0000000000a2', pg_temp.plain()))],
          ARRAY['-', 'channel_message'], 'a channel set to nothing is silent while its sibling notifies');
SELECT pg_temp.channel('f1150000-0000-0000-0000-0000000000a1', '{"level":null}');

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('f1150000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006',
        '88888888-0000-0000-0000-000000000008', 't115', '11111111-0000-0000-0000-000000000001');
CREATE FUNCTION pg_temp.post_in_thread() RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
    v uuid;
BEGIN
    INSERT INTO public.messages (channel_id, thread_id, user_id, content)
    VALUES ('66666666-0000-0000-0000-000000000006', 'f1150000-0000-0000-0000-0000000000d1',
            '11111111-0000-0000-0000-000000000001', pg_temp.plain())
    RETURNING id INTO v;
    RETURN v;
END;
$fn$;
SELECT is(pg_temp.got(pg_temp.post_in_thread()), '-', 'a thread reply is no channel message');

-- Suppress toggles -------------------------------------------------------------------------
SELECT pg_temp.server('{"level":"mentions","suppress_everyone":true}');
SELECT is(pg_temp.kinds('66666666-0000-0000-0000-000000000006'),
          ARRAY['-', 'mention', 'mention:role', '-'], 'suppress @everyone drops @everyone only');
SELECT pg_temp.server('{"suppress_everyone":false,"suppress_roles":true}');
SELECT is(pg_temp.kinds('66666666-0000-0000-0000-000000000006'),
          ARRAY['-', 'mention', '-', 'mention:everyone'], 'suppress roles drops role mentions, not @everyone');
SELECT pg_temp.server('{"level":"all","suppress_everyone":true,"suppress_roles":false}');
SELECT is(pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.at_everyone())),
          'channel_message', 'at all, a suppressed @everyone notifies as a message');
SELECT pg_temp.server('{"level":"mentions","suppress_everyone":false}');
SELECT is(pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006',
              pg_temp.at_role() || pg_temp.at_everyone())),
          'mention:everyone', '@everyone and a held role notify once');
SELECT pg_temp.server('{"suppress_everyone":true}');
SELECT is(pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006',
              pg_temp.at_role() || pg_temp.at_everyone())),
          'mention:role', 'with @everyone suppressed the role mention notifies');
SELECT is(cardinality(public.send_notification('mention', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              '{"is_role_mention":true,"is_everyone":true}'::jsonb, '55555555-0000-0000-0000-000000000005',
              '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001')),
          0, 'send_notification applies suppress @everyone to any caller');
SELECT pg_temp.server('{"suppress_everyone":false}');

-- Level 'mentions' admits activity on the member's own things -----------------------------
SELECT is(ARRAY[
    cardinality(public.send_notification('reaction', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
        '{"probe":"r115"}'::jsonb, '55555555-0000-0000-0000-000000000005',
        '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001')),
    cardinality(public.send_notification('thread_reply', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
        '{"probe":"t115"}'::jsonb, '55555555-0000-0000-0000-000000000005',
        '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001'))],
    ARRAY[1, 1], 'mentions: reactions and thread replies notify');

-- Mutes ------------------------------------------------------------------------------------
SELECT pg_temp.server('{"level":"all","muted":true}');
SELECT is(ARRAY[pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.plain())),
                pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.at_bob())),
                pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.at_everyone()))],
          ARRAY['-', 'mention', 'mention:everyone'], 'a muted server admits mentions only');
SELECT is(cardinality(public.send_notification('reaction', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              '{"probe":"r115m"}'::jsonb, '55555555-0000-0000-0000-000000000005',
              '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001')),
          0, 'a muted server drops reactions');
SELECT is((pg_temp.server(jsonb_build_object('muted', true, 'muted_until', now() + interval '1 hour')))->>'muted',
          'true', 'a mute for an hour reads as muted');
SELECT is(pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.plain())),
          '-', 'a mute with an end time in the future silences');
UPDATE public.user_servers SET muted_until = now() - interval '1 second'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.plain())),
          'channel_message', 'a mute past its end time no longer applies');
SELECT pg_temp.server('{"muted":false}');

-- Category mute, notifications and unread state
SELECT pg_temp.post('f1150000-0000-0000-0000-0000000000a1', pg_temp.plain());
SELECT pg_temp.category('{"muted":true}');
SELECT is(ARRAY[pg_temp.got(pg_temp.post('f1150000-0000-0000-0000-0000000000a1', pg_temp.plain())),
                pg_temp.got(pg_temp.post('f1150000-0000-0000-0000-0000000000a1', pg_temp.at_bob())),
                pg_temp.got(pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.plain()))],
          ARRAY['-', 'mention', 'channel_message'], 'a muted category admits mentions in its channels only');
SELECT ok((SELECT muted_at_seq IS NOT NULL FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND channel_id = 'f1150000-0000-0000-0000-0000000000a1'),
          'a category mute freezes the unread count of its channels');

CREATE FUNCTION pg_temp.muted_flag(p_channel uuid) RETURNS boolean LANGUAGE plpgsql AS $fn$
DECLARE
    v boolean;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', true);
    PERFORM set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}', true);
    SELECT g.muted INTO v FROM public.get_unread_counts() g WHERE g.channel_id = p_channel;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN v;
END;
$fn$;
SELECT is(pg_temp.muted_flag('f1150000-0000-0000-0000-0000000000a1'), true,
          'get_unread_counts reports a category-muted channel as muted');

UPDATE public.channels SET category = NULL WHERE id = 'f1150000-0000-0000-0000-0000000000a1';
SELECT ok((SELECT muted_at_seq IS NULL FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND channel_id = 'f1150000-0000-0000-0000-0000000000a1'),
          'a channel leaving a muted category unfreezes');
UPDATE public.channels SET category = 'f1150000-0000-0000-0000-0000000000c1'
 WHERE id = 'f1150000-0000-0000-0000-0000000000a1';
SELECT ok((SELECT muted_at_seq IS NOT NULL FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND channel_id = 'f1150000-0000-0000-0000-0000000000a1'),
          'a channel entering a muted category freezes');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT array_agg(n.type ORDER BY n.type)
             FROM public.get_user_notifications('22222222-0000-0000-0000-000000000002', 100) n
            WHERE COALESCE(n.data->>'channel_id', n.data->'location'->>'channel_id') = 'f1150000-0000-0000-0000-0000000000a1'),
          ARRAY['mention']::varchar[], 'a muted category hides its channel''s notifications but mentions');
SELECT tests.clear_authentication();

SELECT pg_temp.category('{"muted":false}');
SELECT ok((SELECT muted_at_seq IS NULL FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND channel_id = 'f1150000-0000-0000-0000-0000000000a1'),
          'unmuting the category unfreezes');

-- A lapsed category mute settles on the next message.
SELECT pg_temp.category(jsonb_build_object('muted', true, 'muted_until', now() + interval '1 hour'));
SELECT ok((SELECT muted_at_seq IS NOT NULL FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND channel_id = 'f1150000-0000-0000-0000-0000000000a2'),
          'a timed category mute freezes');
ALTER TABLE public.notification_channels DISABLE TRIGGER trg_track_unread_mute;
UPDATE public.notification_channels SET muted_until = now() - interval '1 second'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND category_id = 'f1150000-0000-0000-0000-0000000000c1';
ALTER TABLE public.notification_channels ENABLE TRIGGER trg_track_unread_mute;
SELECT pg_temp.post('f1150000-0000-0000-0000-0000000000a2', pg_temp.plain());
SELECT ok((SELECT muted_at_seq IS NULL FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND channel_id = 'f1150000-0000-0000-0000-0000000000a2'),
          'a lapsed category mute ends at the next message');

-- Channel mute
SELECT pg_temp.channel('f1150000-0000-0000-0000-0000000000a2', '{"muted":true}');
SELECT is(ARRAY[pg_temp.got(pg_temp.post('f1150000-0000-0000-0000-0000000000a2', pg_temp.plain())),
                pg_temp.got(pg_temp.post('f1150000-0000-0000-0000-0000000000a2', pg_temp.at_role()))],
          ARRAY['-', 'mention:role'], 'a muted channel admits mentions only');
SELECT pg_temp.channel('f1150000-0000-0000-0000-0000000000a2', '{"muted":false}');

-- Push ------------------------------------------------------------------------------------
DELETE FROM tests.jobs115;
SELECT pg_temp.server('{"push_notifications":false}');
SELECT pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.at_bob());
SELECT ok(NOT EXISTS (SELECT 1 FROM tests.jobs115
                       WHERE name = 'send-push-notification'
                         AND data->>'user_id' = '22222222-0000-0000-0000-000000000002'),
          'push off for the server queues no push');
SELECT pg_temp.server('{"push_notifications":true}');
SELECT pg_temp.post('66666666-0000-0000-0000-000000000006', pg_temp.at_bob());
SELECT ok(EXISTS (SELECT 1 FROM tests.jobs115
                   WHERE name = 'send-push-notification'
                     AND data->>'user_id' = '22222222-0000-0000-0000-000000000002'),
          'push on queues one');

-- Broadcast, leaving -----------------------------------------------------------------------
DELETE FROM realtime.messages;
SELECT pg_temp.server('{"suppress_roles":false}');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages m
                   WHERE m.topic = 'user:22222222-0000-0000-0000-000000000002'
                     AND m.payload->>'type' = 'notification_settings:changed'
                     AND m.payload->>'server_id' = '55555555-0000-0000-0000-000000000005'),
          'an update tells the member''s other devices');

DELETE FROM public.user_servers
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM public.notification_servers
            WHERE user_id = '22222222-0000-0000-0000-000000000002'),
          0, 'leaving the server clears its settings');

SELECT * FROM finish();
ROLLBACK;
