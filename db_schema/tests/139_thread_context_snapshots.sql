-- Thread context carries quote snapshots after 20261013600001_thread_context_snapshots.sql.
--
-- Profiles: viewer139 local with an auth user; strypey139 remote, md139.test.
-- Posts, public: 01 viewer's post; 02 strypey's reply to 01 quoting a holos post, with its
-- snapshot; 03 viewer's reply to 02.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('f1390000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'viewer139@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('f1390000-0000-0000-0000-0000000000a1', 'f1390000-0000-0000-0000-0000000000f1', 'viewer139', 'Viewer', true);
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
VALUES ('f1390000-0000-0000-0000-0000000000a2', NULL, 'strypey139', 'Strypey', false, 'md139.test');
INSERT INTO public.posts (id, author_id, content, visibility, is_local, in_reply_to, metadata, reblog, reblog_author)
VALUES
  ('f1390000-0000-0000-0000-000000000001', 'f1390000-0000-0000-0000-0000000000a1',
   '[{"type":"text","text":"root"}]', 'public', true, NULL, '{}', NULL, NULL),
  ('f1390000-0000-0000-0000-000000000002', 'f1390000-0000-0000-0000-0000000000a2',
   '[{"type":"text","text":"reply with a quote"}]', 'public', false, 'f1390000-0000-0000-0000-000000000001',
   '{"is_quote": true, "quote_ap_url": "https://holos.test/statuses/9"}',
   '{"id": "f1390000-0000-0000-0000-0000000000c1", "content": [{"type": "text", "text": "quoted"}]}',
   '{"id": "f1390000-0000-0000-0000-0000000000c2", "username": "doesnm"}'),
  ('f1390000-0000-0000-0000-000000000003', 'f1390000-0000-0000-0000-0000000000a1',
   '[{"type":"text","text":"answer"}]', 'public', true, 'f1390000-0000-0000-0000-000000000002', '{}', NULL, NULL);

CREATE TEMP TABLE ctx139 AS
SELECT public.get_post_with_context('f1390000-0000-0000-0000-000000000001', 'f1390000-0000-0000-0000-0000000000a1', 'thread') AS down,
       public.get_post_with_context('f1390000-0000-0000-0000-000000000003', 'f1390000-0000-0000-0000-0000000000a1', 'thread') AS up;

SELECT is((SELECT d->'reblog'->'content'->0->>'text' FROM ctx139, jsonb_array_elements(down->'descendants') d
            WHERE d->>'id' = 'f1390000-0000-0000-0000-000000000002'), 'quoted',
    'a descendant carries its quote snapshot');
SELECT is((SELECT d->'reblog_author'->>'username' FROM ctx139, jsonb_array_elements(down->'descendants') d
            WHERE d->>'id' = 'f1390000-0000-0000-0000-000000000002'), 'doesnm',
    'and the quoted author');
SELECT is((SELECT d->>'in_reply_to' FROM ctx139, jsonb_array_elements(down->'descendants') d
            WHERE d->>'id' = 'f1390000-0000-0000-0000-000000000003'), 'f1390000-0000-0000-0000-000000000002',
    'a descendant names its parent');
SELECT is((SELECT a->'reblog'->'content'->0->>'text' FROM ctx139, jsonb_array_elements(up->'ancestors') a
            WHERE a->>'id' = 'f1390000-0000-0000-0000-000000000002'), 'quoted',
    'an ancestor carries its quote snapshot');
SELECT is((SELECT a->'reblog' FROM ctx139, jsonb_array_elements(up->'ancestors') a
            WHERE a->>'id' = 'f1390000-0000-0000-0000-000000000001'), 'null'::jsonb,
    'a post without one carries null');

SELECT * FROM finish();
ROLLBACK;
