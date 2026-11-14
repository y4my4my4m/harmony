-- 20261114100001_public_page_link_previews.sql: public_page_post returns the post's stored link
-- previews (metadata.embeds) as `embeds`, an empty object when there are none.
--
-- link286   local, a post with two stored previews, one without, one with embeds that are no
--           object, and a quote of the first

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

SELECT ok(NOT has_function_privilege('anon', 'public.public_page_post(uuid, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.public_page_post(uuid, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.public_page_post(uuid, integer)', 'EXECUTE'),
  'only service callers read a page post');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2860000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'link286@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2860000-0000-0000-0000-0000000000c1', 'f2860000-0000-0000-0000-0000000000a1', 'link286', 'Link', true);

INSERT INTO public.posts (id, author_id, content, visibility, created_at, metadata, media_attachments) VALUES
  ('f2863000-0000-0000-0000-000000000001', 'f2860000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"look "},{"type":"url","url":"https://news286.test/a"},{"type":"text","text":" "},{"type":"url","url":"https://gifs286.test/g"}]',
   'public', now() - interval '3 minutes',
   '{"embeds": {"https://news286.test/a": {"url": "https://news286.test/a", "provider": "generic", "title": "A story", "image": "https://news286.test/a.jpg"},
                "https://gifs286.test/g": {"url": "https://gifs286.test/g", "provider": "generic", "mediaOnly": true, "image": "https://media286.test/g.gif"}}}',
   '[]'),
  ('f2863000-0000-0000-0000-000000000002', 'f2860000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"plain"}]', 'public', now() - interval '2 minutes', '{}', '[]'),
  ('f2863000-0000-0000-0000-000000000003', 'f2860000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"odd metadata"}]', 'public', now() - interval '1 minute', '{"embeds": ["https://news286.test/a"]}', '[]'),
  ('f2863000-0000-0000-0000-000000000004', 'f2860000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"quoting"}]', 'public', now(),
   '{"reblog_of": "f2863000-0000-0000-0000-000000000001", "is_quote": true}', '[]');

SELECT is(public.public_page_post('f2863000-0000-0000-0000-000000000001', 1) -> 'embeds',
  (SELECT metadata -> 'embeds' FROM public.posts WHERE id = 'f2863000-0000-0000-0000-000000000001'),
  'a post''s stored previews are its embeds');
SELECT is(public.public_page_post('f2863000-0000-0000-0000-000000000001', 1) #>> '{embeds,https://gifs286.test/g,image}',
  'https://media286.test/g.gif',
  'a preview keeps its media');
SELECT is(public.public_page_post('f2863000-0000-0000-0000-000000000002', 1) -> 'embeds', '{}'::jsonb,
  'a post without previews has an empty embeds object');
SELECT is(public.public_page_post('f2863000-0000-0000-0000-000000000003', 1) -> 'embeds', '{}'::jsonb,
  'embeds that are no object read as none');
SELECT is(public.public_page_post('f2863000-0000-0000-0000-000000000004', 1) #>> '{quote,embeds,https://news286.test/a,title}',
  'A story',
  'a quoted post carries its previews');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(public.public_profile_page('link286', NULL, NULL) -> 'posts') p
            WHERE jsonb_typeof(p -> 'embeds') = 'object'), 4,
  'every post of the profile page has embeds');

SELECT * FROM finish();
ROLLBACK;
