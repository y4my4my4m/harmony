-- 20261009000001_message_change_feed.sql: updated_at moves on content changes and soft deletes
-- alone, and channel_message_changes pages edited and soft-deleted channel messages.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(26);

-- 93000000-...-0000000001xx: channel messages created an hour ago; 0201: a DM.
INSERT INTO public.messages (id, channel_id, user_id, content, metadata, created_at)
SELECT ('93000000-0000-0000-0000-0000000001' || n)::uuid,
       '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
       jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'message ' || n)), '{}'::jsonb,
       now() - interval '1 hour'
  FROM (VALUES ('01'), ('02'), ('03'), ('04'), ('05'), ('06'), ('07')) v(n);
INSERT INTO public.messages (id, conversation_id, user_id, content, created_at)
VALUES ('93000000-0000-0000-0000-000000000201', '77777777-0000-0000-0000-000000000007',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"dm"}]'::jsonb,
        now() - interval '1 hour');

CREATE FUNCTION pg_temp.moved(p_id uuid) RETURNS boolean LANGUAGE sql AS
  $$ SELECT updated_at > created_at FROM public.messages WHERE id = p_id $$;

CREATE FUNCTION pg_temp.feed_ids(p_feed jsonb) RETURNS text[] LANGUAGE sql AS
  $$ SELECT COALESCE(array_agg(e->>'id' ORDER BY o), '{}') FROM jsonb_array_elements(p_feed->'messages') WITH ORDINALITY t(e, o) $$;

CREATE FUNCTION pg_temp.plan_of(p_query text) RETURNS SETOF text LANGUAGE plpgsql AS
  $$ DECLARE l text; BEGIN FOR l IN EXECUTE 'EXPLAIN ' || p_query LOOP RETURN NEXT l; END LOOP; END $$;

SELECT has_function('public', 'channel_message_changes', ARRAY['timestamp with time zone', 'uuid', 'integer'],
                    'channel_message_changes exists');
SELECT ok(has_function_privilege('service_role', 'public.channel_message_changes(timestamptz, uuid, integer)', 'EXECUTE'),
          'service_role executes channel_message_changes');
SELECT ok(NOT has_function_privilege('authenticated', 'public.channel_message_changes(timestamptz, uuid, integer)', 'EXECUTE'),
          'authenticated does not execute channel_message_changes');
SELECT ok(NOT has_function_privilege('anon', 'public.channel_message_changes(timestamptz, uuid, integer)', 'EXECUTE'),
          'anon does not execute channel_message_changes');
SELECT has_index('public', 'messages', 'idx_messages_channel_changes', ARRAY['updated_at', 'id'],
                 'idx_messages_channel_changes is on (updated_at, id)');
SELECT is((SELECT count(*)::int FROM pg_trigger
            WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal
              AND tgfoid = 'public.handle_messages_updated_at()'::regprocedure),
          1, 'one trigger on messages runs handle_messages_updated_at');

SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000101'), 'an insert keeps updated_at = created_at');

UPDATE public.messages SET metadata = '{"discord_message_id":"1300000000000000001"}'
 WHERE id = '93000000-0000-0000-0000-000000000101';
SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000101'), 'a metadata merge leaves updated_at');

UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id = '93000000-0000-0000-0000-000000000102';
SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000102'), 'a pin leaves updated_at');

UPDATE public.messages SET federation_status = 'completed' WHERE id = '93000000-0000-0000-0000-000000000103';
SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000103'), 'a federation_status change leaves updated_at');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages SET updated_at = now() + interval '1 year' WHERE id = '93000000-0000-0000-0000-000000000103';
RESET ROLE;
SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000103'),
          'a client UPDATE writing updated_at without a content change keeps the old value');

UPDATE public.messages SET content = '[{"type":"text","text":"message 03"}]' WHERE id = '93000000-0000-0000-0000-000000000103';
SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000103'), 'rewriting identical content leaves updated_at');

UPDATE public.messages SET content = '[{"type":"text","text":"message 04, edited"}]' WHERE id = '93000000-0000-0000-0000-000000000104';
SELECT is((SELECT updated_at FROM public.messages WHERE id = '93000000-0000-0000-0000-000000000104'), now(),
          'a content edit sets updated_at to now()');

UPDATE public.messages SET is_deleted = true WHERE id = '93000000-0000-0000-0000-000000000105';
SELECT ok(pg_temp.moved('93000000-0000-0000-0000-000000000105'), 'a soft delete without a content change moves updated_at');

UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]'
 WHERE id = '93000000-0000-0000-0000-000000000106';
SELECT ok(pg_temp.moved('93000000-0000-0000-0000-000000000106'), 'a soft delete with a content change moves updated_at');

SELECT set_config('harmony.silent_content_update', 'true', true);
UPDATE public.messages SET content = '[{"type":"text","text":"message 07, refreshed url"}]'
 WHERE id = '93000000-0000-0000-0000-000000000107';
SELECT set_config('harmony.silent_content_update', '', true);
SELECT ok(NOT pg_temp.moved('93000000-0000-0000-0000-000000000107'), 'a silent content update leaves updated_at');

UPDATE public.messages SET content = '[{"type":"text","text":"dm, edited"}]' WHERE id = '93000000-0000-0000-0000-000000000201';

SET LOCAL ROLE service_role;
SELECT set_config('tests.feed', public.channel_message_changes(now() - interval '1 minute',
                  '00000000-0000-0000-0000-000000000000', 500)::text, true);
RESET ROLE;

SELECT is(pg_temp.feed_ids(current_setting('tests.feed')::jsonb),
          ARRAY['93000000-0000-0000-0000-000000000104', '93000000-0000-0000-0000-000000000105',
                '93000000-0000-0000-0000-000000000106'],
          'service_role reads the edited and soft-deleted channel messages, by (updated_at, id)');
SELECT is(pg_temp.feed_ids(public.channel_message_changes(now() - interval '1 minute', '00000000-0000-0000-0000-000000000000', 500)),
          ARRAY['93000000-0000-0000-0000-000000000104', '93000000-0000-0000-0000-000000000105',
                '93000000-0000-0000-0000-000000000106'],
          'the feed holds the edited and soft-deleted channel messages, by (updated_at, id)');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(
              public.channel_message_changes(now() - interval '1 minute', '00000000-0000-0000-0000-000000000000', 500)->'messages') e
            WHERE e->>'id' = '93000000-0000-0000-0000-000000000201'),
          0, 'the feed omits direct messages');
SELECT is(pg_temp.feed_ids(public.channel_message_changes(now(), '93000000-0000-0000-0000-000000000104', 500)),
          ARRAY['93000000-0000-0000-0000-000000000105', '93000000-0000-0000-0000-000000000106'],
          'the feed resumes after its (updated_at, id) position');
SELECT is(pg_temp.feed_ids(public.channel_message_changes(now() - interval '1 minute', '00000000-0000-0000-0000-000000000000', 2)),
          ARRAY['93000000-0000-0000-0000-000000000104', '93000000-0000-0000-0000-000000000105'],
          'the feed returns at most p_limit rows');
SELECT is((public.channel_message_changes(now(), '93000000-0000-0000-0000-000000000106', 500)->'messages'), '[]'::jsonb,
          'the feed is empty past its last row');
SELECT is((public.channel_message_changes(NULL, NULL, 500)->'messages'), '[]'::jsonb,
          'a NULL position returns no rows');
SELECT is((public.channel_message_changes(NULL, NULL, 500)->>'now')::timestamptz, now(),
          'now is the database clock');
SELECT is((SELECT e->'metadata' FROM jsonb_array_elements(
              public.channel_message_changes(now() - interval '1 minute', '00000000-0000-0000-0000-000000000000', 500)->'messages') e
            WHERE e->>'id' = '93000000-0000-0000-0000-000000000105'),
          '{}'::jsonb, 'a feed row carries the message columns');

SET LOCAL enable_seqscan = off;
SELECT ok(EXISTS (
    SELECT 1 FROM (SELECT pg_temp.plan_of(
        $q$SELECT id FROM public.messages
            WHERE channel_id IS NOT NULL AND updated_at > created_at
              AND (updated_at, id) > (now() - interval '1 minute', '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY updated_at, id LIMIT 500$q$) AS line) p
     WHERE p.line LIKE '%idx_messages_channel_changes%'),
    'the feed query reads idx_messages_channel_changes');

SELECT * FROM finish();
ROLLBACK;
