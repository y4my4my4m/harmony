-- get_home_timeline_page reply_parent after 20261105500001_reply_parent_context.sql: the post a
-- reply answers, read under the caller's posts RLS.
--
--   reader221    local, follows author221
--   author221    local, writes the replies
--   quiet221     local, writes a followers-only post nobody here follows yet
--   far221       remote, writes a public parent and a deleted one
--
--   p1  far221    public              the parent
--   p2  author221 public  reply to p1
--   p3  quiet221  followers           hidden from reader221
--   p4  author221 public  reply to p3
--   p5  far221    public  deleted
--   p6  author221 public  reply to p5
--   p7  author221 public              no reply

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2210000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'reader221@test.local'),
  ('f2210000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'author221@test.local'),
  ('f2210000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'quiet221@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2210000-0000-0000-0000-0000000000c1', 'f2210000-0000-0000-0000-0000000000a1', 'reader221', 'Reader', true),
  ('f2210000-0000-0000-0000-0000000000c2', 'f2210000-0000-0000-0000-0000000000a2', 'author221', 'Author', true),
  ('f2210000-0000-0000-0000-0000000000c3', 'f2210000-0000-0000-0000-0000000000a3', 'quiet221', 'Quiet', true);
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id, inbox_url) VALUES
  ('f2210000-0000-0000-0000-0000000000c4', 'far221', 'Far Away', 'far221.example', false,
   'https://far221.example/users/far221', 'https://far221.example/users/far221/inbox');

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f2210000-0000-0000-0000-0000000000c1', 'f2210000-0000-0000-0000-0000000000c2', 'accepted');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, content_warning, media_attachments, created_at) VALUES
  ('f2213000-0000-0000-0000-000000000001', 'f2210000-0000-0000-0000-0000000000c4',
   '[{"type":"text","text":"the parent text"}]', 'public', false, 'https://far221.example/notes/1',
   'spoilers', '[{"id":"m1","type":"image","url":"https://far221.example/m1.png"}]', now() - interval '7 minutes');
INSERT INTO public.posts (id, author_id, content, visibility, created_at) VALUES
  ('f2213000-0000-0000-0000-000000000003', 'f2210000-0000-0000-0000-0000000000c3',
   '[{"type":"text","text":"for followers only"}]', 'followers', now() - interval '6 minutes');
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, is_deleted, deleted_at, created_at) VALUES
  ('f2213000-0000-0000-0000-000000000005', 'f2210000-0000-0000-0000-0000000000c4',
   '[{"type":"text","text":"words of a deleted post"}]', 'public', false, 'https://far221.example/notes/5',
   true, now(), now() - interval '5 minutes');
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to, created_at) VALUES
  ('f2213000-0000-0000-0000-000000000002', 'f2210000-0000-0000-0000-0000000000c2',
   '[{"type":"text","text":"answer to the parent"}]', 'public', 'f2213000-0000-0000-0000-000000000001', now() - interval '4 minutes'),
  ('f2213000-0000-0000-0000-000000000004', 'f2210000-0000-0000-0000-0000000000c2',
   '[{"type":"text","text":"answer to the quiet one"}]', 'public', 'f2213000-0000-0000-0000-000000000003', now() - interval '3 minutes'),
  ('f2213000-0000-0000-0000-000000000006', 'f2210000-0000-0000-0000-0000000000c2',
   '[{"type":"text","text":"answer to the deleted one"}]', 'public', 'f2213000-0000-0000-0000-000000000005', now() - interval '2 minutes'),
  ('f2213000-0000-0000-0000-000000000007', 'f2210000-0000-0000-0000-0000000000c2',
   '[{"type":"text","text":"not a reply"}]', 'public', NULL, now() - interval '1 minute');

-- The caller's home row of post p_id, read under the current role.
CREATE FUNCTION pg_temp.home(p_id text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT r FROM jsonb_array_elements(public.get_home_timeline_page(50, NULL)) r WHERE r->>'id' = p_id
$$;

SELECT tests.authenticate_as('f2210000-0000-0000-0000-0000000000a1');

-- Readable parent ------------------------------------------------------------------------
SELECT is((SELECT h->'reply_parent'->>'id' FROM pg_temp.home('f2213000-0000-0000-0000-000000000002') h),
          'f2213000-0000-0000-0000-000000000001', 'a reply carries its parent');
SELECT is((SELECT h->'reply_parent'->'content'->0->>'text' FROM pg_temp.home('f2213000-0000-0000-0000-000000000002') h),
          'the parent text', 'with the parent''s content');
SELECT is((SELECT h->'reply_parent'->>'content_warning' FROM pg_temp.home('f2213000-0000-0000-0000-000000000002') h),
          'spoilers', 'its content warning');
SELECT is((SELECT jsonb_array_length(h->'reply_parent'->'media_attachments') FROM pg_temp.home('f2213000-0000-0000-0000-000000000002') h),
          1, 'its attachments');
SELECT is((SELECT (h->'reply_parent'->'author') - 'avatar_url' FROM pg_temp.home('f2213000-0000-0000-0000-000000000002') h),
          '{"id": "f2210000-0000-0000-0000-0000000000c4", "username": "far221", "display_name": "Far Away", "domain": "far221.example", "is_local": false}'::jsonb,
          'and its author');

-- Hidden, deleted, none ------------------------------------------------------------------
SELECT is((SELECT h->>'in_reply_to' FROM pg_temp.home('f2213000-0000-0000-0000-000000000004') h),
          'f2213000-0000-0000-0000-000000000003', 'a reply to a post the reader may not read names its parent');
SELECT is((SELECT jsonb_typeof(h->'reply_parent') FROM pg_temp.home('f2213000-0000-0000-0000-000000000004') h),
          'null', 'and carries no parent');
SELECT is((SELECT h->'reply_parent'->>'is_deleted' FROM pg_temp.home('f2213000-0000-0000-0000-000000000006') h),
          'true', 'a reply to a deleted post carries the parent as deleted');
SELECT is((SELECT jsonb_typeof(h->'reply_parent'->'content') FROM pg_temp.home('f2213000-0000-0000-0000-000000000006') h),
          'null', 'without its content');
SELECT is((SELECT h->'reply_parent'->'media_attachments' FROM pg_temp.home('f2213000-0000-0000-0000-000000000006') h),
          '[]'::jsonb, 'or its attachments');
SELECT is((SELECT jsonb_typeof(h->'reply_parent') FROM pg_temp.home('f2213000-0000-0000-0000-000000000007') h),
          'null', 'a post that is no reply carries no parent');

-- RLS follows the reader ------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f2210000-0000-0000-0000-0000000000c1', 'f2210000-0000-0000-0000-0000000000c3', 'accepted');
SELECT tests.authenticate_as('f2210000-0000-0000-0000-0000000000a1');
SELECT is((SELECT h->'reply_parent'->'content'->0->>'text' FROM pg_temp.home('f2213000-0000-0000-0000-000000000004') h),
          'for followers only', 'once the reader follows its author, the followers-only parent is carried');

-- Grants --------------------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT ok(has_function_privilege('authenticated', 'public.get_home_timeline_page(integer, timestamptz)', 'EXECUTE'),
          'authenticated may call get_home_timeline_page');
SELECT ok(has_function_privilege('anon', 'public.get_home_timeline_page(integer, timestamptz)', 'EXECUTE'),
          'anon may call get_home_timeline_page, as on a fresh install');

SELECT * FROM finish();
ROLLBACK;
