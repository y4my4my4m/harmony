-- 20261123300005_bridge_erase_alert_threads.sql: a thread on an AutoMod alert of an erased author
-- loses its title with the alert.
--
-- Fixture server_1 (alice owns it) with #general, bridged by bot329. AutoMod blocked two messages of
-- Discord user dana (...9001); a moderator started a thread on the first alert, titled from it, and
-- another on an alert of eve (...9002), who is not erased.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3290000-0000-0000-0000-0000000000b1', 'bot329', 'Bot 329', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'f3290000-0000-0000-0000-0000000000b1', 'self',
        '900000000000000329', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.automod_events (id, server_id, channel_id, bot_id, event_type, details)
SELECT e.id::uuid, '55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006',
       'f3290000-0000-0000-0000-0000000000b1', 'message',
       jsonb_build_object('author_key', 'discord:' || e.author, 'author_name', e.name)
  FROM (VALUES ('f3290000-0000-0000-0000-0000000000e1', '3290000000000009001', 'dana'),
               ('f3290000-0000-0000-0000-0000000000e2', '3290000000000009001', 'dana'),
               ('f3290000-0000-0000-0000-0000000000e3', '3290000000000009002', 'eve')) e(id, author, name);
SELECT public.automod_post_alert('66666666-0000-0000-0000-000000000006', e.id::uuid,
                                 'Blocked a message from @' || e.name || ' (Discord): ' || e.words,
                                 jsonb_build_object('author_key', 'discord:' || e.author, 'excerpt', e.words))
  FROM (VALUES ('f3290000-0000-0000-0000-0000000000e1', '3290000000000009001', 'dana', 'dana''s secret'),
               ('f3290000-0000-0000-0000-0000000000e2', '3290000000000009001', 'dana', 'more of dana'),
               ('f3290000-0000-0000-0000-0000000000e3', '3290000000000009002', 'eve', 'eve''s words')) e(id, author, name, words);

-- The moderators' threads, through the bot API as a client of it would, with their notices.
SELECT public.bot_create_thread('f3290000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
                                'Blocked a message from @dana (Discord): dana''s secret',
                                (SELECT m.id FROM public.messages m
                                  WHERE m.metadata #>> '{automod,event_id}' = 'f3290000-0000-0000-0000-0000000000e1'));
SELECT public.bot_create_thread('f3290000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
                                'Blocked a message from @eve (Discord): eve''s words',
                                (SELECT m.id FROM public.messages m
                                  WHERE m.metadata #>> '{automod,event_id}' = 'f3290000-0000-0000-0000-0000000000e3'));
CREATE FUNCTION pg_temp.title(p_event text) RETURNS text LANGUAGE sql AS
$fn$ SELECT t.name || ' / ' || (SELECT n.metadata ->> 'thread_name' FROM public.messages n
                                  WHERE n.metadata ->> 'type' = 'thread_created' AND n.metadata ->> 'thread_id' = t.id::text)
       FROM public.threads t JOIN public.messages m ON m.id = t.parent_message_id
      WHERE m.metadata #>> '{automod,event_id}' = p_event
         OR (m.metadata ? 'bridge_erased' AND p_event = 'erased') $fn$;

SELECT is(pg_temp.title('f3290000-0000-0000-0000-0000000000e1'),
          'Blocked a message from @dana (Discord): dana''s secret / Blocked a message from @dana (Discord): dana''s secret',
          'control: the thread and its notice carry the alert''s words');

SELECT public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '3290000000000009001', 50);

SELECT is((SELECT count(*)::int FROM public.messages
            WHERE metadata #>> '{automod,event_id}' IN ('f3290000-0000-0000-0000-0000000000e1', 'f3290000-0000-0000-0000-0000000000e2')),
          0, 'no alert names dana');
SELECT is((SELECT count(*)::int FROM public.messages WHERE metadata ? 'bridge_erased' AND is_deleted), 1,
          'the alert under a thread stays as an empty deleted row');
SELECT is(pg_temp.title('erased'), 'Thread / Thread', 'its thread and the thread''s notice lose the alert''s words');
SELECT is((SELECT count(*)::int FROM public.messages n
            WHERE n.metadata ->> 'type' = 'thread_created' AND n.metadata ->> 'thread_name' LIKE '%dana%'),
          0, 'no notice repeats them');
SELECT is(pg_temp.title('f3290000-0000-0000-0000-0000000000e3'),
          'Blocked a message from @eve (Discord): eve''s words / Blocked a message from @eve (Discord): eve''s words',
          'the thread on eve''s alert keeps its title');

SELECT * FROM finish();
ROLLBACK;
