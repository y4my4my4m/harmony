-- 20261021100001_realtime_publication_drop_messages.sql: supabase_realtime exists and
-- publishes no table; message events travel by Broadcast only.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(3);

SELECT ok(EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'),
          'the supabase_realtime publication exists');
SELECT is((SELECT count(*)::int FROM pg_publication_tables WHERE pubname = 'supabase_realtime'), 0,
          'it publishes no table');
SELECT is((SELECT count(*)::int FROM pg_trigger
            WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal
              AND tgname IN ('trigger_broadcast_message_insert', 'trigger_broadcast_message_update',
                             'trigger_broadcast_message_delete')), 3,
          'messages still broadcasts inserts, updates and deletes');

SELECT * FROM finish();
ROLLBACK;
