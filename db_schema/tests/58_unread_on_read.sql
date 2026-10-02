-- Unread computed on read (20261005700001_compute_unread_on_read.sql) against the per-message
-- counter it replaced.
--
-- The counter model runs beside the new one: tests.old_unread is unread_counts as it was, fed
-- by copies of the former handle_new_message_unread (20261001200002), handle_new_dm_unread
-- and increment_unread_mentions, and cleared the way the client PATCH and the former
-- mark_server_as_read cleared it. After each phase every member's get_unread_counts() is
-- compared with the counter rows a client would have shown: contexts the member can still
-- see, with unread messages or mentions.
--
-- Server s58, owner o58. Members a58 and c58 hold role crew58; f58 holds crew58 with a member
-- override denying VIEW_CHANNEL on #crew58; b58, d58, e58 hold @everyone only; p58 is
-- pending; g58 joins in phase 6. #open58 is open; #crew58 denies @everyone VIEW_CHANNEL and
-- allows crew58. d58 mutes #open58 and the group from the start.
-- D58: a58 and b58. G58: a58, b58, c58, d58.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(38);

-- Setup, as postgres. -------------------------------------------------------------------
CREATE TEMP TABLE u58 (name text PRIMARY KEY, auth_id uuid, id uuid);
INSERT INTO u58 VALUES
  ('o58', 'f5800000-0000-0000-0000-000000000001', 'f5810000-0000-0000-0000-000000000001'),
  ('a58', 'f5800000-0000-0000-0000-00000000000a', 'f5810000-0000-0000-0000-00000000000a'),
  ('b58', 'f5800000-0000-0000-0000-00000000000b', 'f5810000-0000-0000-0000-00000000000b'),
  ('c58', 'f5800000-0000-0000-0000-00000000000c', 'f5810000-0000-0000-0000-00000000000c'),
  ('d58', 'f5800000-0000-0000-0000-00000000000d', 'f5810000-0000-0000-0000-00000000000d'),
  ('e58', 'f5800000-0000-0000-0000-00000000000e', 'f5810000-0000-0000-0000-00000000000e'),
  ('f58', 'f5800000-0000-0000-0000-00000000000f', 'f5810000-0000-0000-0000-00000000000f'),
  ('g58', 'f5800000-0000-0000-0000-000000000011', 'f5810000-0000-0000-0000-000000000011'),
  ('p58', 'f5800000-0000-0000-0000-000000000012', 'f5810000-0000-0000-0000-000000000012');

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT auth_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', name || '@test.local'
  FROM u58;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT id, auth_id, name, name, true FROM u58;

-- Message ids by label.
CREATE TEMP TABLE m58 (label text PRIMARY KEY, id uuid);

INSERT INTO public.servers (id, name, owner)
VALUES ('f5820000-0000-0000-0000-000000000001', 's58', 'f5810000-0000-0000-0000-000000000001');
-- Default role and the owner's membership come from the server triggers; asserted here.
INSERT INTO public.server_roles (server_id, name, position, permissions, is_default)
SELECT 'f5820000-0000-0000-0000-000000000001', '@everyone', 0, 4098, true
 WHERE NOT EXISTS (SELECT 1 FROM public.server_roles
                    WHERE server_id = 'f5820000-0000-0000-0000-000000000001' AND is_default);
UPDATE public.server_roles SET permissions = 4098
 WHERE server_id = 'f5820000-0000-0000-0000-000000000001' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('f5830000-0000-0000-0000-000000000001', 'f5820000-0000-0000-0000-000000000001', 'crew58', 5, 0);

INSERT INTO public.user_servers (user_id, server_id, status)
SELECT u.id, 'f5820000-0000-0000-0000-000000000001', CASE u.name WHEN 'p58' THEN 'pending' ELSE 'accepted' END
  FROM u58 u WHERE u.name <> 'g58'
ON CONFLICT (user_id, server_id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, server_id)
SELECT u.id, 'f5830000-0000-0000-0000-000000000001', 'f5820000-0000-0000-0000-000000000001'
  FROM u58 u WHERE u.name IN ('a58', 'c58', 'f58');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f5840000-0000-0000-0000-000000000001', 'f5820000-0000-0000-0000-000000000001', 'open58', 0),
  ('f5840000-0000-0000-0000-000000000002', 'f5820000-0000-0000-0000-000000000001', 'crew58', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f5840000-0000-0000-0000-000000000002', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = 'f5820000-0000-0000-0000-000000000001' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f5840000-0000-0000-0000-000000000002', 'role', 'f5830000-0000-0000-0000-000000000001', NULL, 4098, 0),
  ('f5840000-0000-0000-0000-000000000002', 'user', NULL, 'f5810000-0000-0000-0000-00000000000f', 0, 2);

INSERT INTO public.conversations (id, type, name) VALUES
  ('f5850000-0000-0000-0000-000000000001', 'direct', NULL),
  ('f5850000-0000-0000-0000-000000000002', 'group', 'g58');
INSERT INTO public.conversation_participants (conversation_id, user_id)
SELECT 'f5850000-0000-0000-0000-000000000001'::uuid, u.id FROM u58 u WHERE u.name IN ('a58', 'b58')
UNION ALL
SELECT 'f5850000-0000-0000-0000-000000000002'::uuid, u.id FROM u58 u WHERE u.name IN ('a58', 'b58', 'c58', 'd58');

INSERT INTO public.notification_channels (user_id, server_id, channel_id, muted)
VALUES ('f5810000-0000-0000-0000-00000000000d', 'f5820000-0000-0000-0000-000000000001',
        'f5840000-0000-0000-0000-000000000001', true);
INSERT INTO public.notification_channels (user_id, conversation_id, muted)
VALUES ('f5810000-0000-0000-0000-00000000000d', 'f5850000-0000-0000-0000-000000000002', true);

-- The counter model. ----------------------------------------------------------------------
CREATE TABLE tests.old_unread (
    user_id uuid NOT NULL,
    channel_id uuid,
    conversation_id uuid,
    unread_messages integer NOT NULL DEFAULT 0,
    unread_mentions integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ON tests.old_unread (user_id, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX ON tests.old_unread (user_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- 20261001200002 handle_new_message_unread, writing tests.old_unread.
CREATE FUNCTION tests.old_message_unread() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    v_server_id  uuid;
    v_restricted boolean;
BEGIN
    SELECT server_id INTO v_server_id FROM public.channels WHERE id = NEW.channel_id;
    IF v_server_id IS NULL THEN
        RETURN NEW;
    END IF;
    v_restricted := public.channel_is_restricted(NEW.channel_id);
    INSERT INTO tests.old_unread (user_id, channel_id, unread_messages)
    SELECT us.user_id, NEW.channel_id, 1
      FROM public.user_servers us
     WHERE us.server_id = v_server_id
       AND us.status = 'accepted'
       AND (NEW.user_id IS NULL OR us.user_id <> NEW.user_id)
       AND (NOT v_restricted OR us.user_id IN (SELECT public.channel_viewer_ids(NEW.channel_id)))
       AND NOT EXISTS (
           SELECT 1 FROM public.notification_channels nc
            WHERE nc.user_id = us.user_id AND nc.channel_id = NEW.channel_id
              AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()))
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
    DO UPDATE SET unread_messages = old_unread.unread_messages + 1;
    RETURN NEW;
END;
$fn$;

-- Baseline handle_new_dm_unread.
CREATE FUNCTION tests.old_dm_unread() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    INSERT INTO tests.old_unread (user_id, conversation_id, unread_messages)
    SELECT cp.user_id, NEW.conversation_id, 1
      FROM public.conversation_participants cp
     WHERE cp.conversation_id = NEW.conversation_id
       AND cp.user_id != NEW.user_id
       AND cp.left_at IS NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.notification_channels nc
            WHERE nc.user_id = cp.user_id AND nc.conversation_id = NEW.conversation_id
              AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()))
    ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
    DO UPDATE SET unread_messages = old_unread.unread_messages + 1;
    RETURN NEW;
END;
$fn$;

-- Baseline increment_unread_mentions, by context.
CREATE FUNCTION tests.old_mentions() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    v_channel uuid := COALESCE(NULLIF(NEW.data->>'channel_id', ''), NULLIF(NEW.data->'location'->>'channel_id', ''))::uuid;
    v_conversation uuid := NULLIF(NEW.data->>'conversation_id', '')::uuid;
BEGIN
    IF NEW.type NOT IN ('mention', 'activitypub_mention') THEN
        RETURN NEW;
    END IF;
    IF v_channel IS NOT NULL THEN
        INSERT INTO tests.old_unread (user_id, channel_id, unread_mentions) VALUES (NEW.user_id, v_channel, 1)
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
        DO UPDATE SET unread_mentions = old_unread.unread_mentions + 1;
    END IF;
    IF v_conversation IS NOT NULL THEN
        INSERT INTO tests.old_unread (user_id, conversation_id, unread_mentions) VALUES (NEW.user_id, v_conversation, 1)
        ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
        DO UPDATE SET unread_mentions = old_unread.unread_mentions + 1;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER t58_old_message_unread AFTER INSERT ON public.messages FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION tests.old_message_unread();
CREATE TRIGGER t58_old_dm_unread AFTER INSERT ON public.messages FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION tests.old_dm_unread();
CREATE TRIGGER t58_old_mentions AFTER INSERT ON public.notifications FOR EACH ROW
    EXECUTE FUNCTION tests.old_mentions();

-- Reads, both models. The client PATCH and the former mark_server_as_read set the counters to 0.
CREATE FUNCTION tests.as_user(p_name text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    v_sub text := (SELECT auth_id::text FROM u58 WHERE name = p_name);
BEGIN
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_sub, ''), true);
    PERFORM set_config('request.jwt.claims',
                       CASE WHEN v_sub IS NULL THEN '' ELSE json_build_object('sub', v_sub)::text END, true);
END;
$fn$;

CREATE FUNCTION tests.read_channel(p_name text, p_channel uuid, p_message uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE tests.old_unread SET unread_messages = 0, unread_mentions = 0
     WHERE user_id = (SELECT id FROM u58 WHERE name = p_name) AND channel_id = p_channel;
    PERFORM tests.as_user(p_name);
    PERFORM public.mark_channel_as_read(p_channel, p_message);
    PERFORM tests.as_user(NULL);
END;
$fn$;

CREATE FUNCTION tests.read_conversation(p_name text, p_conversation uuid) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE tests.old_unread SET unread_messages = 0, unread_mentions = 0
     WHERE user_id = (SELECT id FROM u58 WHERE name = p_name) AND conversation_id = p_conversation;
    PERFORM tests.as_user(p_name);
    PERFORM public.mark_conversation_as_read(p_conversation);
    PERFORM tests.as_user(NULL);
END;
$fn$;

CREATE FUNCTION tests.read_server(p_name text, p_server uuid) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE tests.old_unread SET unread_messages = 0, unread_mentions = 0
     WHERE user_id = (SELECT id FROM u58 WHERE name = p_name)
       AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server);
    PERFORM tests.as_user(p_name);
    PERFORM public.mark_server_as_read(p_server);
    PERFORM tests.as_user(NULL);
END;
$fn$;

-- What each model shows, as (user, context, messages, mentions).
CREATE FUNCTION tests.old_state() RETURNS TABLE(name text, ctx uuid, messages bigint, mentions bigint)
LANGUAGE sql AS $fn$
    SELECT u.name, COALESCE(o.channel_id, o.conversation_id), o.unread_messages::bigint, o.unread_mentions::bigint
      FROM tests.old_unread o
      JOIN u58 u ON u.id = o.user_id
     WHERE (o.unread_messages > 0 OR o.unread_mentions > 0)
       AND (o.channel_id IS NULL OR (
               EXISTS (SELECT 1 FROM public.user_servers us JOIN public.channels c ON c.server_id = us.server_id
                        WHERE c.id = o.channel_id AND us.user_id = o.user_id AND us.status = 'accepted')
               AND public.can_view_channel(o.user_id, o.channel_id)))
       AND (o.conversation_id IS NULL OR public.is_conversation_participant(o.conversation_id, o.user_id))
$fn$;

CREATE FUNCTION tests.new_state() RETURNS TABLE(name text, ctx uuid, messages bigint, mentions bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT u.name FROM u58 u ORDER BY u.name LOOP
        PERFORM tests.as_user(r.name);
        RETURN QUERY
        SELECT r.name, COALESCE(g.channel_id, g.conversation_id), g.unread_messages::bigint, g.unread_mentions::bigint
          FROM public.get_unread_counts() g
         WHERE g.channel_id IN ('f5840000-0000-0000-0000-000000000001', 'f5840000-0000-0000-0000-000000000002')
            OR g.conversation_id IN ('f5850000-0000-0000-0000-000000000001', 'f5850000-0000-0000-0000-000000000002');
    END LOOP;
    PERFORM tests.as_user(NULL);
END;
$fn$;

CREATE FUNCTION tests.msg(p_name text, p_channel uuid, p_conversation uuid, p_system boolean DEFAULT false,
                          p_thread uuid DEFAULT NULL, p_deleted boolean DEFAULT false, p_label text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO public.messages (channel_id, conversation_id, user_id, content, is_system, thread_id, is_deleted)
    VALUES (p_channel, p_conversation, (SELECT id FROM u58 WHERE name = p_name),
            '[{"type":"text","text":"m58"}]', p_system, p_thread, p_deleted)
    RETURNING id INTO v_id;
    IF p_label IS NOT NULL THEN
        INSERT INTO m58 VALUES (p_label, v_id);
    END IF;
END;
$fn$;

-- unread:change recipients since the last clear, as (name, unread_messages).
CREATE FUNCTION tests.sent() RETURNS TABLE(name text, ctx uuid, messages int)
LANGUAGE sql AS $fn$
    SELECT u.name,
           COALESCE((m.payload->'count'->>'channel_id')::uuid, (m.payload->'count'->>'conversation_id')::uuid),
           (m.payload->'count'->>'unread_messages')::int
      FROM realtime.messages m
      JOIN u58 u ON m.topic = 'user:' || u.id::text
     WHERE m.payload->>'type' = 'unread:change'
$fn$;

-- channel_viewer_ids against has_permission. ---------------------------------------------
SELECT set_eq(
    $q$SELECT c.id, v FROM public.channels c, LATERAL public.channel_viewer_ids(c.id) v
        WHERE c.server_id = 'f5820000-0000-0000-0000-000000000001'$q$,
    $q$SELECT c.id, us.user_id FROM public.channels c
         JOIN public.user_servers us ON us.server_id = c.server_id AND us.status = 'accepted'
        WHERE c.server_id = 'f5820000-0000-0000-0000-000000000001'
          AND public.has_permission(us.user_id, c.server_id, 'VIEW_CHANNEL', c.id)$q$,
    'channel_viewer_ids agrees with has_permission over roles, @everyone and member overrides');

-- Phase 1: messages. ----------------------------------------------------------------------
DELETE FROM realtime.messages;
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL, p_label => 'first');
SELECT set_eq('SELECT name, ctx, messages FROM tests.sent()',
    $q$SELECT n, 'f5840000-0000-0000-0000-000000000001'::uuid, 1
         FROM unnest(ARRAY['o58', 'b58', 'c58', 'e58', 'f58']) n$q$,
    'the first message notifies every accepted, unmuted member but its author');

DELETE FROM realtime.messages;
SELECT tests.msg('c58', 'f5840000-0000-0000-0000-000000000002', NULL);
SELECT set_eq('SELECT name, ctx, messages FROM tests.sent()',
    $q$SELECT n, 'f5840000-0000-0000-0000-000000000002'::uuid, 1 FROM unnest(ARRAY['o58', 'a58']) n$q$,
    'a hidden channel''s first message notifies its viewers only');

SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT tests.msg('b58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT tests.msg('o58', 'f5840000-0000-0000-0000-000000000001', NULL, true);
INSERT INTO public.messages (channel_id, user_id, content)
VALUES ('f5840000-0000-0000-0000-000000000001', NULL, '[{"type":"text","text":"from nobody"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
SELECT 'f5860000-0000-0000-0000-000000000001', 'f5840000-0000-0000-0000-000000000001', m.id, 't58',
       'f5810000-0000-0000-0000-00000000000a'
  FROM m58 m WHERE m.label = 'first';
SELECT tests.msg('b58', 'f5840000-0000-0000-0000-000000000001', NULL, false, 'f5860000-0000-0000-0000-000000000001',
                 p_label => 'reply');
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL, false, NULL, true);
SELECT tests.msg('o58', 'f5840000-0000-0000-0000-000000000002', NULL);

DELETE FROM realtime.messages;
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000001');
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000001');
SELECT set_eq('SELECT name, ctx, messages FROM tests.sent()',
    $q$VALUES ('b58', 'f5850000-0000-0000-0000-000000000001'::uuid, 1),
              ('b58', 'f5850000-0000-0000-0000-000000000001'::uuid, 2)$q$,
    'every DM sends the recipient their exact count');
SELECT tests.msg('b58', NULL, 'f5850000-0000-0000-0000-000000000001');

DELETE FROM realtime.messages;
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000002');
SELECT set_eq('SELECT name, ctx, messages FROM tests.sent()',
    $q$SELECT n, 'f5850000-0000-0000-0000-000000000002'::uuid, 1 FROM unnest(ARRAY['b58', 'c58']) n$q$,
    'a group message reaches every unmuted participant but its author');
SELECT tests.msg('c58', NULL, 'f5850000-0000-0000-0000-000000000002');
INSERT INTO public.messages (conversation_id, user_id, content)
VALUES ('f5850000-0000-0000-0000-000000000002', NULL, '[{"type":"text","text":"from nobody"}]');

SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 1: own, system, deleted, authorless and thread messages; hidden channel; muted members');
SELECT is((SELECT messages FROM tests.new_state() WHERE name = 'b58' AND ctx = 'f5840000-0000-0000-0000-000000000001'),
          3::bigint, 'phase 1: b58 has a58''s two and the authorless message unread in #open58');
SELECT is_empty($q$SELECT 1 FROM tests.new_state() WHERE name IN ('d58', 'p58')$q$,
                'phase 1: nothing is unread for the muted member or the pending one');

-- Phase 2: reads. -------------------------------------------------------------------------
SELECT tests.read_channel('b58', 'f5840000-0000-0000-0000-000000000001', (SELECT id FROM m58 WHERE label = 'reply'));
SELECT tests.read_conversation('a58', 'f5850000-0000-0000-0000-000000000001');

DELETE FROM realtime.messages;
SELECT tests.msg('o58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT set_eq('SELECT name, ctx, messages FROM tests.sent()',
    $q$VALUES ('b58', 'f5840000-0000-0000-0000-000000000001'::uuid, 1)$q$,
    'a channel message notifies only members who had nothing unread there');
SELECT tests.msg('b58', NULL, 'f5850000-0000-0000-0000-000000000001');

SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 2: a read clears, later messages count again');

SELECT tests.as_user('b58');
SELECT results_eq(
    $q$SELECT last_read_message_id FROM public.get_unread_counts()
        WHERE channel_id = 'f5840000-0000-0000-0000-000000000001'$q$,
    $q$SELECT id FROM m58 WHERE label = 'reply'$q$,
    'phase 2: the read keeps the message it was marked at for the divider');
SELECT tests.as_user('c58');
SELECT is((SELECT last_read_at FROM public.get_unread_counts()
            WHERE channel_id = 'f5840000-0000-0000-0000-000000000001'),
          (SELECT greatest(us.created_at, h.origin_at)
             FROM public.user_servers us, public.message_heads h
            WHERE us.user_id = 'f5810000-0000-0000-0000-00000000000c'
              AND us.server_id = 'f5820000-0000-0000-0000-000000000001'
              AND h.channel_id = 'f5840000-0000-0000-0000-000000000001'),
          'phase 2: a context never read places the divider after joining or the origin');
SELECT tests.as_user(NULL);

-- Phase 3: mutes. -------------------------------------------------------------------------
SELECT tests.read_channel('e58', 'f5840000-0000-0000-0000-000000000001');
INSERT INTO public.notification_channels (user_id, server_id, channel_id, muted)
VALUES ('f5810000-0000-0000-0000-00000000000e', 'f5820000-0000-0000-0000-000000000001',
        'f5840000-0000-0000-0000-000000000001', true);
DELETE FROM realtime.messages;
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT is_empty($q$SELECT 1 FROM tests.sent() WHERE name = 'e58'$q$,
                'phase 3: a muted member is not notified');
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 3: a mute freezes the count it started with');
UPDATE public.notification_channels SET muted = false
 WHERE user_id = 'f5810000-0000-0000-0000-00000000000e' AND channel_id = 'f5840000-0000-0000-0000-000000000001';
SELECT tests.msg('o58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 3: unmuting counts only messages after it');

-- c58 mutes with messages unread, o58 likewise with an end time.
INSERT INTO public.notification_channels (user_id, server_id, channel_id, muted)
VALUES ('f5810000-0000-0000-0000-00000000000c', 'f5820000-0000-0000-0000-000000000001',
        'f5840000-0000-0000-0000-000000000001', true);
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT tests.msg('c58', 'f5840000-0000-0000-0000-000000000001', NULL);
UPDATE public.notification_channels SET muted = false
 WHERE user_id = 'f5810000-0000-0000-0000-00000000000c' AND channel_id = 'f5840000-0000-0000-0000-000000000001';

-- A mute that lapses by muted_until, with nothing to observe the lapse: f58 had read
-- everything, o58 had not.
SELECT tests.read_channel('f58', 'f5840000-0000-0000-0000-000000000001');
INSERT INTO public.notification_channels (user_id, server_id, channel_id, muted, muted_until)
SELECT u.id, 'f5820000-0000-0000-0000-000000000001', 'f5840000-0000-0000-0000-000000000001', true,
       now() + interval '1 hour'
  FROM u58 u WHERE u.name IN ('f58', 'o58');
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
ALTER TABLE public.notification_channels DISABLE TRIGGER trg_track_unread_mute;
UPDATE public.notification_channels SET muted_until = now() - interval '1 second'
 WHERE user_id IN ('f5810000-0000-0000-0000-00000000000f', 'f5810000-0000-0000-0000-000000000001')
   AND channel_id = 'f5840000-0000-0000-0000-000000000001';
ALTER TABLE public.notification_channels ENABLE TRIGGER trg_track_unread_mute;
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 3: a lapsed mute holds its count until the next message');
DELETE FROM realtime.messages;
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT ok(EXISTS (SELECT 1 FROM tests.sent() WHERE name = 'f58'),
          'phase 3: the first message after a lapsed mute notifies a member who had read up to it');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 3: the next message after a lapse counts');

-- Phase 4: mentions. ----------------------------------------------------------------------
INSERT INTO public.notifications (user_id, type, data) VALUES
  ('f5810000-0000-0000-0000-00000000000b', 'mention',
   '{"channel_id":"f5840000-0000-0000-0000-000000000001","server_id":"f5820000-0000-0000-0000-000000000001"}'),
  ('f5810000-0000-0000-0000-00000000000d', 'mention',
   '{"location":{"channel_id":"f5840000-0000-0000-0000-000000000001","server_id":"f5820000-0000-0000-0000-000000000001"}}'),
  ('f5810000-0000-0000-0000-00000000000a', 'mention',
   '{"conversation_id":"f5850000-0000-0000-0000-000000000002"}'),
  ('f5810000-0000-0000-0000-00000000000c', 'mention',
   '{"channel_id":"f5840000-0000-0000-0000-000000000002","server_id":"f5820000-0000-0000-0000-000000000001"}');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 4: mentions count per context, muted ones included');
SELECT tests.read_channel('b58', 'f5840000-0000-0000-0000-000000000001');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 4: a read clears mentions');

-- Phase 5: reading a server. --------------------------------------------------------------
SELECT tests.read_server('a58', 'f5820000-0000-0000-0000-000000000001');
SELECT tests.read_server('d58', 'f5820000-0000-0000-0000-000000000001');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 5: reading the server clears its channels, muted ones too, and leaves DMs');
SELECT tests.msg('b58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT tests.msg('o58', 'f5840000-0000-0000-0000-000000000002', NULL);
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 5: messages after the read count');

-- Phase 6: joining. -----------------------------------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f5810000-0000-0000-0000-000000000011', 'f5820000-0000-0000-0000-000000000001', 'accepted');
UPDATE public.user_servers SET status = 'accepted'
 WHERE user_id = 'f5810000-0000-0000-0000-000000000012' AND server_id = 'f5820000-0000-0000-0000-000000000001';
SELECT is_empty($q$SELECT 1 FROM tests.new_state() WHERE name IN ('g58', 'p58')$q$,
                'phase 6: messages before joining are not unread');
DELETE FROM realtime.messages;
SELECT tests.msg('a58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT ok((SELECT count(*) FROM tests.sent() WHERE name IN ('g58', 'p58')) = 2,
          'phase 6: new members are notified of the first message after joining');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 6: messages after joining count');

-- Phase 7: own messages while behind, leaving a group, a later deletion. -------------------
SELECT tests.msg('b58', NULL, 'f5850000-0000-0000-0000-000000000002');
SELECT tests.msg('d58', NULL, 'f5850000-0000-0000-0000-000000000002');
UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = 'f5850000-0000-0000-0000-000000000002' AND user_id = 'f5810000-0000-0000-0000-00000000000c';
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000002');
UPDATE public.messages SET is_deleted = true WHERE id = (SELECT id FROM m58 WHERE label = 'first');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'phase 7: own messages, a departure and a later deletion change nothing they did not before');

-- Unmuting the group, then reading it while muted. ----------------------------------------
DELETE FROM public.notification_channels
 WHERE user_id = 'f5810000-0000-0000-0000-00000000000d' AND conversation_id = 'f5850000-0000-0000-0000-000000000002';
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000002');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'deleting a mute row unmutes');
INSERT INTO public.notification_channels (user_id, conversation_id, muted)
VALUES ('f5810000-0000-0000-0000-00000000000d', 'f5850000-0000-0000-0000-000000000002', true);
SELECT tests.read_conversation('d58', 'f5850000-0000-0000-0000-000000000002');
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000002');
UPDATE public.notification_channels SET muted = false
 WHERE user_id = 'f5810000-0000-0000-0000-00000000000d' AND conversation_id = 'f5850000-0000-0000-0000-000000000002';
SELECT tests.msg('a58', NULL, 'f5850000-0000-0000-0000-000000000002');
SELECT set_eq('SELECT * FROM tests.new_state()', 'SELECT * FROM tests.old_state()',
    'a read while muted, then an unmute: only the message after it counts');

-- Clients. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('f5800000-0000-0000-0000-00000000000b');
SELECT throws_ok(
    $q$UPDATE public.unread_counts SET read_seq = 0 WHERE user_id = 'f5810000-0000-0000-0000-00000000000b'$q$,
    '42501', NULL, 'a client cannot write its read state directly');
SELECT throws_ok(
    $q$INSERT INTO public.unread_counts (user_id, channel_id) VALUES ('f5810000-0000-0000-0000-00000000000b', 'f5840000-0000-0000-0000-000000000002')$q$,
    '42501', NULL, 'a client cannot insert read state');
SELECT is_empty(
    $q$SELECT 1 FROM public.unread_counts WHERE user_id <> 'f5810000-0000-0000-0000-00000000000b'$q$,
    'a client reads only its own read state');
SELECT set_eq(
    $q$SELECT COALESCE(channel_id, conversation_id) FROM public.message_heads
        WHERE channel_id IN ('f5840000-0000-0000-0000-000000000001', 'f5840000-0000-0000-0000-000000000002')
           OR conversation_id IN ('f5850000-0000-0000-0000-000000000001', 'f5850000-0000-0000-0000-000000000002')$q$,
    $q$VALUES ('f5840000-0000-0000-0000-000000000001'::uuid), ('f5850000-0000-0000-0000-000000000001'::uuid),
              ('f5850000-0000-0000-0000-000000000002'::uuid)$q$,
    'message_heads shows a client only contexts it can view');
SELECT lives_ok(
    $q$SELECT public.mark_channel_as_read('f5840000-0000-0000-0000-000000000002')$q$,
    'marking a channel the caller cannot view is a no-op');
SELECT is_empty(
    $q$SELECT 1 FROM public.unread_counts WHERE channel_id = 'f5840000-0000-0000-0000-000000000002'$q$,
    'and writes nothing');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT * FROM public.get_unread_counts()$q$, '42501', NULL, 'anon cannot read unread counts');
SELECT tests.clear_authentication();

SELECT is_empty(
    $q$SELECT p.oid::regprocedure FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('unread_change_payload', 'handle_new_message_unread', 'handle_new_dm_unread',
                            'increment_unread_mentions', 'broadcast_unread_count_event',
                            'reset_unread_on_join', 'sync_unread_mute', 'track_unread_mute',
                            'channel_viewer_ids')
          AND (has_function_privilege('anon', p.oid, 'EXECUTE')
               OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))$q$,
    'clients hold no EXECUTE on the internal unread functions');
SELECT ok(has_function_privilege('authenticated', 'public.get_unread_counts()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.mark_channel_as_read(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.mark_conversation_as_read(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.mark_server_as_read(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.mark_channel_as_read(uuid, uuid)', 'EXECUTE'),
          'the read RPCs are executable by authenticated clients only');

-- A message touches one head and the author's row. ----------------------------------------
CREATE TEMP TABLE w58 AS
SELECT n_tup_ins + n_tup_upd AS writes FROM pg_stat_xact_user_tables WHERE relid = 'public.unread_counts'::regclass;
SELECT tests.msg('c58', 'f5840000-0000-0000-0000-000000000001', NULL);
SELECT is((SELECT n_tup_ins + n_tup_upd FROM pg_stat_xact_user_tables WHERE relid = 'public.unread_counts'::regclass)
          - (SELECT writes FROM w58), 1::bigint,
          'a channel message writes one unread_counts row, its author''s');

SELECT * FROM finish();
ROLLBACK;
