-- 20261012200001_post_federation_edits_and_deletes.sql: trigger_queue_post_federation queues
-- Update(Note) for a content warning, sensitive flag or media change alone, and the delete
-- job carries the remote mentions of the content the post held before the UPDATE.
--
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs:
-- pg_notify delivers only at commit and every file rolls back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

CREATE TABLE tests.fed_jobs (name text, data jsonb);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.fed_jobs VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.jobs(p_post uuid, p_type text) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT count(*) FROM tests.fed_jobs
   WHERE name = 'federate-post' AND data ->> 'post_id' = p_post::text AND data ->> 'type' = p_type;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.status(p_post uuid) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT federation_status FROM public.posts WHERE id = p_post;
$fn$;

-- alice's post, federated once.
INSERT INTO public.posts (id, author_id, content, visibility, is_local)
VALUES ('12500000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"hello"}]', 'public', true);

SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'create'), 1::bigint,
          'a local post queues its Create');

UPDATE public.posts SET federation_status = 'completed' WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.status('12500000-0000-0000-0000-000000000001'), 'completed',
          'a federation_status write queues nothing');

UPDATE public.posts SET content_warning = 'spoilers' WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'update'), 1::bigint,
          'a content warning edit alone queues the Update');
SELECT is(pg_temp.status('12500000-0000-0000-0000-000000000001'), 'queued',
          'the content warning edit marks the post queued');

UPDATE public.posts SET federation_status = 'completed' WHERE id = '12500000-0000-0000-0000-000000000001';
UPDATE public.posts SET is_sensitive = true WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'update'), 2::bigint,
          'a sensitive flag edit alone queues the Update');

UPDATE public.posts SET federation_status = 'completed' WHERE id = '12500000-0000-0000-0000-000000000001';
UPDATE public.posts
   SET media_attachments = '[{"type":"image","url":"https://harmony.test/m/1.png"}]'
 WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'update'), 3::bigint,
          'a media edit alone queues the Update');

UPDATE public.posts SET federation_status = 'completed' WHERE id = '12500000-0000-0000-0000-000000000001';
UPDATE public.posts SET content_warning = 'other', federation_status = 'processing'
 WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'update'), 4::bigint,
          'an edit written together with a status change still queues the Update');

UPDATE public.posts SET federation_status = 'completed' WHERE id = '12500000-0000-0000-0000-000000000001';
UPDATE public.posts SET favorites_count = 3 WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'update'), 4::bigint,
          'a counter write queues nothing');
SELECT is(pg_temp.status('12500000-0000-0000-0000-000000000001'), 'completed',
          'a counter write leaves the status');

UPDATE public.posts SET content = '[{"type":"text","text":"hello, edited"}]'
 WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000001', 'update'), 5::bigint,
          'a content edit queues the Update');

-- A post mentioning two remote users (one twice), a local user and a bridged user,
-- deleted the way the client deletes: is_deleted and blanked content in one UPDATE.
INSERT INTO public.posts (id, author_id, content, visibility, is_local)
VALUES ('12500000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
        '[{"type":"mention","userId":"unresolved-hby@misskey.test","username":"hby","domain":"Misskey.Test","isLocal":false},
          {"type":"text","text":" and "},
          {"type":"mention","userId":"x","username":"carol","domain":"mastodon.test","isLocal":false},
          {"type":"mention","userId":"y","username":"hby","domain":"misskey.test","isLocal":false},
          {"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob","domain":"harmony.test","isLocal":true},
          {"type":"mention","userId":"123","username":"dis","domain":"discord.com","isLocal":false,"isBridged":true}]',
        'direct', true);

UPDATE public.posts
   SET is_deleted = true, deleted_at = now(), content = '[{"type":"text","text":"[Deleted]"}]'
 WHERE id = '12500000-0000-0000-0000-000000000002';

SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000002', 'delete'), 1::bigint,
          'deleting queues one Delete');
SELECT is(pg_temp.jobs('12500000-0000-0000-0000-000000000002', 'update'), 0::bigint,
          'the blanking in the same UPDATE queues no Update');
SELECT is(
  (SELECT jsonb_array_length(data -> 'mentions') FROM tests.fed_jobs
    WHERE data ->> 'post_id' = '12500000-0000-0000-0000-000000000002' AND data ->> 'type' = 'delete'),
  2, 'the Delete names each remote mentionee once');
SELECT ok(
  (SELECT data -> 'mentions' @> '[{"username":"hby","domain":"misskey.test"},{"username":"carol","domain":"mastodon.test"}]'::jsonb
     FROM tests.fed_jobs
    WHERE data ->> 'post_id' = '12500000-0000-0000-0000-000000000002' AND data ->> 'type' = 'delete'),
  'the Delete carries the mentions of the content before the blanking, hosts lowercased');

-- A post without mentions still carries an empty list.
UPDATE public.posts SET is_deleted = true WHERE id = '12500000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT data -> 'mentions' FROM tests.fed_jobs
    WHERE data ->> 'post_id' = '12500000-0000-0000-0000-000000000001' AND data ->> 'type' = 'delete'),
  '[]'::jsonb, 'a post without remote mentions carries an empty list');

-- Remote posts never queue.
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id)
VALUES ('12500000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":"remote"}]', 'public', false, 'https://remote.test/notes/1');
UPDATE public.posts SET content_warning = 'cw' WHERE id = '12500000-0000-0000-0000-000000000003';
SELECT is((SELECT count(*) FROM tests.fed_jobs
            WHERE data ->> 'post_id' = '12500000-0000-0000-0000-000000000003'), 0::bigint,
          'a remote post queues nothing');

SELECT * FROM finish();
ROLLBACK;
