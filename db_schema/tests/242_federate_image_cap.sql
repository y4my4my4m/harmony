-- 20261107700001_federate_image_cap.sql: a local post with media keeps the image cap in force
-- when its media was first attached (metadata.federate_image_max_px); the setting changing
-- later, and its author's writes, leave it as it was.
--
--   alice   (aaaaaaaa / 11111111) posts through the API
--   remote242  a profile of another instance
-- queue_federation_job is replaced for the transaction; federation jobs are not under test.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql AS $fn$ SELECT gen_random_uuid() $fn$;

DELETE FROM public.instance_config WHERE config_key = 'federate_image_max_px';

INSERT INTO public.profiles (id, username, display_name, domain, is_local)
VALUES ('f2420000-0000-0000-0000-0000000000a1', 'remote242', 'Remote', 'images242.test', false);

CREATE FUNCTION pg_temp.cap(p_id text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT metadata -> 'federate_image_max_px' FROM public.posts WHERE id = p_id::uuid
$$;

CREATE FUNCTION pg_temp.post(p_id text, p_media jsonb, p_metadata jsonb DEFAULT '{}') RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.posts (id, author_id, visibility, is_local, content, media_attachments, metadata)
  VALUES (p_id::uuid, '11111111-0000-0000-0000-000000000001', 'public', true,
          '[{"type":"text","text":"photo"}]', p_media, p_metadata)
$$;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT pg_temp.post('f2420000-0000-0000-0000-000000000001',
  '[{"type":"Image","url":"https://x.test/a.jpg","mediaType":"image/jpeg","width":3000,"height":2000}]');
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000001'), '1920'::jsonb,
  'without a setting, a post with media carries 1920');
SELECT ok(NOT has_function_privilege('authenticated', 'public.stamp_post_federate_image_cap()', 'EXECUTE'),
  'clients cannot call the trigger function');

SELECT pg_temp.post('f2420000-0000-0000-0000-000000000003',
  '[{"type":"Image","url":"https://x.test/b.jpg"}]', '{"federate_image_max_px": 0, "created_via": "harmony_client"}');
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000003'), '1920'::jsonb,
  'a cap the client names on insert is replaced by the setting');
SELECT is((SELECT metadata ->> 'created_via' FROM public.posts WHERE id = 'f2420000-0000-0000-0000-000000000003'),
  'harmony_client', 'the rest of the metadata stays');

SELECT pg_temp.post('f2420000-0000-0000-0000-000000000004', '[]', '{"federate_image_max_px": 0}');
SELECT ok(NOT ((SELECT metadata FROM public.posts WHERE id = 'f2420000-0000-0000-0000-000000000004') ? 'federate_image_max_px'),
  'a post without media carries no cap');

SELECT tests.clear_authentication();
INSERT INTO public.instance_config (config_key, config_value) VALUES ('federate_image_max_px', '1280');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT pg_temp.post('f2420000-0000-0000-0000-000000000005',
  '[{"type":"Image","url":"https://x.test/c.jpg"}]');
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000005'), '1280'::jsonb,
  'a post made after the setting changed carries the new cap');

UPDATE public.posts
   SET media_attachments = '[{"type":"Image","url":"https://x.test/a.jpg"},{"type":"Image","url":"https://x.test/d.jpg"}]'
 WHERE id = 'f2420000-0000-0000-0000-000000000001';
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000001'), '1920'::jsonb,
  'an edit adding media keeps the cap the post was made with');

UPDATE public.posts SET metadata = '{"federate_image_max_px": 0}'
 WHERE id = 'f2420000-0000-0000-0000-000000000001';
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000001'), '1920'::jsonb,
  'the author cannot rewrite the cap');

UPDATE public.posts SET media_attachments = '[{"type":"Image","url":"https://x.test/e.jpg"}]'
 WHERE id = 'f2420000-0000-0000-0000-000000000004';
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000004'), '1280'::jsonb,
  'media added to a post without any carries the cap in force then');

SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '"0"' WHERE config_key = 'federate_image_max_px';
SELECT pg_temp.post('f2420000-0000-0000-0000-000000000006', '[{"type":"Image","url":"https://x.test/f.jpg"}]');
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000006'), '0'::jsonb, 'a setting of "0" stamps 0');

UPDATE public.instance_config SET config_value = '"big"' WHERE config_key = 'federate_image_max_px';
SELECT pg_temp.post('f2420000-0000-0000-0000-000000000007', '[{"type":"Image","url":"https://x.test/g.jpg"}]');
SELECT is(pg_temp.cap('f2420000-0000-0000-0000-000000000007'), '1920'::jsonb, 'an invalid setting stamps 1920');

INSERT INTO public.posts (id, author_id, visibility, is_local, content, media_attachments)
VALUES ('f2420000-0000-0000-0000-000000000008', 'f2420000-0000-0000-0000-0000000000a1', 'public', false,
        '[{"type":"text","text":"remote"}]', '[{"type":"Image","url":"https://images242.test/h.jpg"}]');
SELECT ok(NOT ((SELECT COALESCE(metadata, '{}') FROM public.posts WHERE id = 'f2420000-0000-0000-0000-000000000008') ? 'federate_image_max_px'),
  'a remote post carries no cap');

SELECT * FROM finish();
ROLLBACK;
