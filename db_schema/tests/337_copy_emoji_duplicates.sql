-- 20261123400003_copy_emoji_duplicates.sql: merge_copy_emoji_duplicates moves what rows cached from
-- the Group's instance hold onto the copy's row of the same image, and deletes the rows nothing
-- names any more.
--
--   copy337   a server reference (is_local_server false) of remote.test, emoji keep (01)
--   image     https://db.remote.test/e/wave.webp, the image of every row below but 08
--   02 dup        cached, domain remote.test: bob's reaction, a post reaction, a favourite  merged
--   03 old        cached before 1.9.4, domain the image's host (db.remote.test)             merged
--   04 collides   cached, domain remote.test: alice reacted with it and with 01 on one
--                 message                                                                kept
--   05 removed    cached, domain remote.test, removed by an admin: its reaction moves        kept
--   06 dropped    a dropped copy row since detached (mark matches)                          merged
--   07 evil       cached from evil.test                                                     untouched
--   08 other      cached, domain remote.test, another image                                 untouched
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs.
-- The unique constraint and index production holds beyond a fresh install's
-- (schema-prod-20261110a.sql) are added, so the merge runs under both sets.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

ALTER TABLE public.reactions ADD CONSTRAINT reactions_message_id_user_id_emoji_id_key UNIQUE (message_id, user_id, emoji_id);
CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_id ON public.post_interactions
    USING btree (user_id, post_id, interaction_type, emoji_id)
    WHERE ((interaction_type = 'emoji_reaction'::text) AND (emoji_id IS NOT NULL));

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

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('e3370000-0000-0000-0000-0000000000e1', 'remote337', 'Remote 337', 'remote.test', 'https://remote.test/users/remote337', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('e3370000-0000-0000-0000-0000000000f0', 'Copy 337', 'e3370000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/e3370000-0000-0000-0000-0000000000f0');
INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id, created_at, deleted_at, deleted_by, ap_removed_at)
VALUES
  ('e3370000-0000-0000-0000-000000000101', 'wave', 'https://db.remote.test/e/wave.webp', 'e3370000-0000-0000-0000-0000000000f0',
   'server', 'remote.test', 'https://remote.test/servers/e3370000-0000-0000-0000-0000000000f0/emojis/1', now() - interval '5 days', NULL, NULL, NULL),
  ('e3370000-0000-0000-0000-000000000102', 'wave', 'https://db.remote.test/e/wave.webp', NULL,
   'server', 'remote.test', NULL, now() - interval '4 days', NULL, NULL, NULL),
  ('e3370000-0000-0000-0000-000000000103', 'wave', 'https://db.remote.test/e/wave.webp', NULL,
   'server', 'db.remote.test', NULL, now() - interval '30 days', NULL, NULL, NULL),
  ('e3370000-0000-0000-0000-000000000104', 'wave', 'https://db.remote.test/e/wave.webp', NULL,
   'server', 'remote.test', NULL, now() - interval '4 days', NULL, NULL, NULL),
  ('e3370000-0000-0000-0000-000000000105', 'wave', 'https://db.remote.test/e/wave.webp', NULL,
   'server', 'remote.test', NULL, now() - interval '4 days', now() - interval '1 day', NULL, NULL),
  ('e3370000-0000-0000-0000-000000000106', 'wave', 'https://db.remote.test/e/wave.webp', NULL,
   'server', 'remote.test', NULL, now() - interval '4 days', now() - interval '2 days', NULL, now() - interval '2 days'),
  ('e3370000-0000-0000-0000-000000000107', 'slur', 'https://db.remote.test/e/wave.webp', NULL,
   'server', 'evil.test', NULL, now() - interval '4 days', NULL, NULL, NULL),
  ('e3370000-0000-0000-0000-000000000108', 'dance', 'https://db.remote.test/e/dance.webp', NULL,
   'server', 'remote.test', NULL, now() - interval '4 days', NULL, NULL, NULL);

INSERT INTO public.reactions (id, message_id, user_id, emoji_id) VALUES
  ('e3370000-0000-0000-0000-000000000c01', '88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 'e3370000-0000-0000-0000-000000000102'),
  ('e3370000-0000-0000-0000-000000000c02', '88888888-0000-0000-0000-000000000008', '11111111-0000-0000-0000-000000000001', 'e3370000-0000-0000-0000-000000000101'),
  ('e3370000-0000-0000-0000-000000000c03', '88888888-0000-0000-0000-000000000008', '11111111-0000-0000-0000-000000000001', 'e3370000-0000-0000-0000-000000000104'),
  ('e3370000-0000-0000-0000-000000000c04', '88888888-0000-0000-0000-000000000008', '33333333-0000-0000-0000-000000000003', 'e3370000-0000-0000-0000-000000000105'),
  ('e3370000-0000-0000-0000-000000000c05', '88888888-0000-0000-0000-000000000008', 'e3370000-0000-0000-0000-0000000000e1', 'e3370000-0000-0000-0000-000000000107');
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id)
VALUES ('e3370000-0000-0000-0000-000000000d01', 'e3370000-0000-0000-0000-0000000000e1', '[{"type":"text","text":"hi"}]',
        'public', false, 'https://remote.test/notes/337');
INSERT INTO public.post_interactions (id, user_id, post_id, interaction_type, emoji_id, custom_emoji_content)
VALUES ('e3370000-0000-0000-0000-000000000d02', '22222222-0000-0000-0000-000000000002', 'e3370000-0000-0000-0000-000000000d01',
        'emoji_reaction', 'e3370000-0000-0000-0000-000000000103', ':wave@remote.test:');
INSERT INTO public.emoji_favorites (user_id, emoji_id, emoji_name, emoji_url)
VALUES ('22222222-0000-0000-0000-000000000002', 'e3370000-0000-0000-0000-000000000102', 'wave', 'https://db.remote.test/e/wave.webp');
DELETE FROM tests.fed_jobs;

SELECT ok(NOT has_function_privilege('authenticated', 'public.merge_copy_emoji_duplicates(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.merge_copy_emoji_duplicates(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.merge_copy_emoji_duplicates(uuid)', 'EXECUTE'),
          'merging is for the service role alone');
SELECT is(public.merge_copy_emoji_duplicates('55555555-0000-0000-0000-000000000005'), 0, 'a local server merges nothing');

SELECT is(public.merge_copy_emoji_duplicates('e3370000-0000-0000-0000-0000000000f0'), 3, 'three duplicates are merged away');
SELECT is((SELECT array_agg(right(id::text, 2) ORDER BY id) FROM public.emojis WHERE id::text LIKE 'e3370000-%'),
          ARRAY['01', '04', '05', '07', '08'], 'the copy row, the colliding one, the removed one and the other origin''s and image''s stay');
SELECT results_eq(
    $q$SELECT right(id::text, 2), right(emoji_id::text, 2) FROM public.reactions WHERE id::text LIKE 'e3370000-%' ORDER BY id$q$,
    $q$VALUES ('01', '01'), ('02', '01'), ('03', '04'), ('04', '01'), ('05', '07')$q$,
    'reactions move to the copy row, but the one its reactor already holds there and another origin''s');
SELECT is((SELECT count(*)::int FROM public.reactions
            WHERE message_id = '88888888-0000-0000-0000-000000000008' AND emoji_id = 'e3370000-0000-0000-0000-000000000101'),
          3, 'one pill for the copy''s emoji');
SELECT is((SELECT right(emoji_id::text, 2) FROM public.post_interactions WHERE id = 'e3370000-0000-0000-0000-000000000d02'),
          '01', 'a post reaction moves');
SELECT is((SELECT emoji_id FROM public.emoji_favorites WHERE user_id = '22222222-0000-0000-0000-000000000002'
             AND emoji_name = 'wave'),
          'e3370000-0000-0000-0000-000000000101', 'a favourite moves');
SELECT ok((SELECT deleted_at IS NOT NULL FROM public.emojis WHERE id = 'e3370000-0000-0000-0000-000000000105'),
          'the admin''s removal stays recorded');
SELECT is((SELECT count(*)::int FROM tests.fed_jobs), 0, 'nothing federates');

-- Once alice drops her second reaction, the colliding row goes with the next merge.
DELETE FROM public.reactions WHERE id = 'e3370000-0000-0000-0000-000000000c03';
SELECT is(public.merge_copy_emoji_duplicates('e3370000-0000-0000-0000-0000000000f0'), 1, 'the next merge takes the freed row');
SELECT is(public.merge_copy_emoji_duplicates('e3370000-0000-0000-0000-0000000000f0'), 0, 'then nothing is left to merge');
SELECT is((SELECT array_agg(right(id::text, 2) ORDER BY id) FROM public.emojis WHERE id::text LIKE 'e3370000-%'),
          ARRAY['01', '05', '07', '08'], 'the rows that stay');
SELECT is((SELECT count(*)::int FROM public.emojis WHERE server_id = 'e3370000-0000-0000-0000-0000000000f0'), 1,
          'the copy keeps its one row');

SELECT * FROM finish();
ROLLBACK;
