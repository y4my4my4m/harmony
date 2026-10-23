-- 20261027800001_public_profile_pages.sql: the reads behind /@<username> and /@<username>/<post>.
-- Only public and unlisted posts of shown accounts appear; followers-only and direct posts, boosts,
-- replies to others, deleted posts and suspended, silenced, deleted or blocked-instance accounts
-- never do. public_profile_pages turns the pages off.
--
-- pub188     local, locked, posts of every visibility
-- other188   local, author of a public and a followers-only post that pub188 quotes
-- gone188    local, suspended; sil188 silenced; del188 deleted
-- far188     remote on a blocked instance

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(30);

SELECT ok(bool_and(NOT has_function_privilege('anon', fn, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', fn, 'EXECUTE')
                   AND has_function_privilege('service_role', fn, 'EXECUTE')),
  'only service callers execute the public page readers')
  FROM unnest(ARRAY['public.public_profile_page(text, uuid, integer)', 'public.public_post_page(uuid)',
                    'public.public_page_post(uuid, integer)', 'public.public_page_account(uuid)',
                    'public.public_page_instance()']) fn;

SELECT ok('public_profile_pages' = ANY (public.public_instance_config_keys()),
  'public_profile_pages is readable by every client');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'public_profile_pages'), 'true'::jsonb,
  'public_profile_pages is on by default');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1880000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pub188@test.local'),
  ('f1880000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other188@test.local'),
  ('f1880000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gone188@test.local'),
  ('f1880000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sil188@test.local'),
  ('f1880000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'del188@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, bio, is_local, manually_approves_followers,
                             federation_discoverable, profile_fields) VALUES
  ('f1880000-0000-0000-0000-0000000000c1', 'f1880000-0000-0000-0000-0000000000a1', 'pub188', 'Pub', 'hello :wave:', true, true,
   false, '[{"name": "site", "value": "https://pub.example"}]'),
  ('f1880000-0000-0000-0000-0000000000c2', 'f1880000-0000-0000-0000-0000000000a2', 'other188', 'Other', NULL, true, false, true, '[]'),
  ('f1880000-0000-0000-0000-0000000000c3', 'f1880000-0000-0000-0000-0000000000a3', 'gone188', 'Gone', NULL, true, false, true, '[]'),
  ('f1880000-0000-0000-0000-0000000000c4', 'f1880000-0000-0000-0000-0000000000a4', 'sil188', 'Silenced', NULL, true, false, true, '[]'),
  ('f1880000-0000-0000-0000-0000000000c5', 'f1880000-0000-0000-0000-0000000000a5', 'del188', 'Deleted', NULL, true, false, true, '[]');
UPDATE public.profiles SET is_suspended = true, suspended_at = now() WHERE id = 'f1880000-0000-0000-0000-0000000000c3';
UPDATE public.profiles SET is_silenced = true, silenced_at = now() WHERE id = 'f1880000-0000-0000-0000-0000000000c4';
UPDATE public.profiles SET deleted_at = now() WHERE id = 'f1880000-0000-0000-0000-0000000000c5';
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f1880000-0000-0000-0000-0000000000d1', 'far188', 'Far', false, 'blocked188.test', 'https://blocked188.test/users/far188');
INSERT INTO public.federated_instances (domain, is_blocked) VALUES ('blocked188.test', true);

-- c1 posts, oldest first: created_at minutes ago.
INSERT INTO public.posts (id, author_id, content, visibility, created_at, in_reply_to, metadata, is_deleted, is_pinned,
                          media_attachments) VALUES
  ('f1883000-0000-0000-0000-000000000020', 'f1880000-0000-0000-0000-0000000000c2', '[{"type":"text","text":"other public"}]', 'public',
   now() - interval '60 minutes', NULL, '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000021', 'f1880000-0000-0000-0000-0000000000c2', '[{"type":"text","text":"other followers"}]', 'followers',
   now() - interval '59 minutes', NULL, '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000001', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"public one"}]', 'public',
   now() - interval '50 minutes', NULL, '{}', false, false,
   '[{"type":"Image","url":"https://db.test/storage/v1/object/public/user_media/p.jpg","description":"a cat","meta":{"focus":{"x":0.5,"y":-0.25}}}]'),
  ('f1883000-0000-0000-0000-000000000002', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"unlisted"}]', 'unlisted',
   now() - interval '49 minutes', NULL, '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000003', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"followers only"}]', 'followers',
   now() - interval '48 minutes', NULL, '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000004', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"direct"}]', 'direct',
   now() - interval '47 minutes', NULL, '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000005', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"deleted"}]', 'public',
   now() - interval '46 minutes', NULL, '{}', true, false, '[]'),
  ('f1883000-0000-0000-0000-000000000006', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"boost"}]', 'public',
   now() - interval '45 minutes', NULL, '{"reblog_of": "f1883000-0000-0000-0000-000000000020"}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000007', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"quote public"}]', 'public',
   now() - interval '44 minutes', NULL, '{"reblog_of": "f1883000-0000-0000-0000-000000000020", "is_quote": true}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000008', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"quote followers"}]', 'public',
   now() - interval '43 minutes', NULL, '{"reblog_of": "f1883000-0000-0000-0000-000000000021", "is_quote": true}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000009', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"reply to other"}]', 'public',
   now() - interval '42 minutes', 'f1883000-0000-0000-0000-000000000020', '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000010', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"self reply"}]', 'public',
   now() - interval '41 minutes', 'f1883000-0000-0000-0000-000000000001', '{}', false, false, '[]'),
  ('f1883000-0000-0000-0000-000000000011', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"pinned"}]', 'public',
   now() - interval '40 minutes', NULL, '{}', false, true, '[]'),
  ('f1883000-0000-0000-0000-000000000012', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"pinned followers"}]', 'followers',
   now() - interval '39 minutes', NULL, '{}', false, true, '[]'),
  ('f1883000-0000-0000-0000-000000000030', 'f1880000-0000-0000-0000-0000000000c3', '[{"type":"text","text":"suspended"}]', 'public',
   now() - interval '30 minutes', NULL, '{}', false, false, '[]');
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id) VALUES
  ('f1883000-0000-0000-0000-000000000031', 'f1880000-0000-0000-0000-0000000000d1', '[{"type":"text","text":"blocked instance"}]', 'public',
   false, 'https://blocked188.test/notes/31');

CREATE TEMP TABLE page188 AS SELECT public.public_profile_page('PUB188', NULL, NULL) AS j;

SELECT is((SELECT j #>> '{account,username}' FROM page188), 'pub188',
  'the username matches without case');
SELECT results_eq(
    $q$SELECT (j -> 'enabled')::boolean, (j #>> '{account,locked}')::boolean, (j #>> '{account,discoverable}')::boolean,
              j #>> '{account,bio}', j #>> '{account,profile_fields,0,name}'
         FROM page188$q$,
    $q$VALUES (true, true, false, 'hello :wave:'::text, 'site'::text)$q$,
    'the page carries the account''s bio, fields, lock and discoverability');
SELECT results_eq(
    $q$SELECT e ->> 'id' FROM page188, jsonb_array_elements(j -> 'posts') WITH ORDINALITY AS t(e, n) ORDER BY n$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000010'::text), ('f1883000-0000-0000-0000-000000000008'),
              ('f1883000-0000-0000-0000-000000000007'), ('f1883000-0000-0000-0000-000000000002'),
              ('f1883000-0000-0000-0000-000000000001')$q$,
    'posts: public and unlisted, quotes and self-replies, newest first; no followers-only, direct, deleted, boost, reply to another or pinned post');
SELECT results_eq(
    $q$SELECT e ->> 'id' FROM page188, jsonb_array_elements(j -> 'pinned') e$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000011'::text)$q$,
    'pinned: the public pinned post alone');
SELECT is((SELECT j -> 'next' FROM page188), 'null'::jsonb, 'one page holds every post');
SELECT results_eq(
    $q$SELECT e #>> '{quote,id}', e ? 'quote', e #>> '{quote,author,username}'
         FROM page188, jsonb_array_elements(j -> 'posts') e
        WHERE e ->> 'id' IN ('f1883000-0000-0000-0000-000000000007', 'f1883000-0000-0000-0000-000000000008')
        ORDER BY e ->> 'id'$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000020'::text, true, 'other188'::text), (NULL::text, true, NULL::text)$q$,
    'a quote of a public post carries it; a quote of a followers-only post carries none');
SELECT is((SELECT e #>> '{reply_to,id}' FROM page188, jsonb_array_elements(j -> 'posts') e
            WHERE e ->> 'id' = 'f1883000-0000-0000-0000-000000000010'),
  'f1883000-0000-0000-0000-000000000001', 'a self-reply names the post it answers');
SELECT is((SELECT e #>> '{media_attachments,0,description}' FROM page188, jsonb_array_elements(j -> 'posts') e
            WHERE e ->> 'id' = 'f1883000-0000-0000-0000-000000000001'),
  'a cat', 'media attachments carry their alt text');
SELECT ok(NOT EXISTS (SELECT 1 FROM page188, jsonb_array_elements(j -> 'posts') e WHERE e::text LIKE '%followers only%'
                                                                                       OR e::text LIKE '%other followers%'),
  'no followers-only text anywhere in the page');

SELECT results_eq(
    $q$SELECT e ->> 'id' FROM jsonb_array_elements(public.public_profile_page('pub188', NULL, 2) -> 'posts') e$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000010'::text), ('f1883000-0000-0000-0000-000000000008')$q$,
    'p_limit bounds a page');
SELECT is(public.public_profile_page('pub188', NULL, 2) ->> 'next', 'f1883000-0000-0000-0000-000000000008',
  'next names the last post of a full page');
SELECT results_eq(
    $q$SELECT e ->> 'id' FROM jsonb_array_elements(
           public.public_profile_page('pub188', 'f1883000-0000-0000-0000-000000000008', 2) -> 'posts') e$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000007'::text), ('f1883000-0000-0000-0000-000000000002')$q$,
    'p_before continues after that post');
SELECT is(jsonb_array_length(public.public_profile_page('pub188', 'f1883000-0000-0000-0000-000000000008', 2) -> 'pinned'), 0,
  'later pages carry no pinned posts');
SELECT is(jsonb_array_length(public.public_profile_page('pub188', 'f1883000-0000-0000-0000-000000000020', 2) -> 'posts'), 0,
  'a cursor of another account''s post reads no posts');

SELECT results_eq(
    $q$SELECT public.public_profile_page(u, NULL, NULL) -> 'account'
         FROM unnest(ARRAY['gone188', 'sil188', 'del188', 'far188', 'nobody188']) u$q$,
    $q$VALUES ('null'::jsonb), ('null'::jsonb), ('null'::jsonb), ('null'::jsonb), ('null'::jsonb)$q$,
    'suspended, silenced, deleted, remote and unknown accounts have no page');

SELECT results_eq(
    $q$SELECT public.public_post_page(id::uuid) -> 'post' = 'null'::jsonb
         FROM unnest(ARRAY['f1883000-0000-0000-0000-000000000003', 'f1883000-0000-0000-0000-000000000004',
                           'f1883000-0000-0000-0000-000000000005', 'f1883000-0000-0000-0000-000000000006',
                           'f1883000-0000-0000-0000-000000000012', 'f1883000-0000-0000-0000-000000000030',
                           'f1883000-0000-0000-0000-000000000031', '88888888-0000-0000-0000-000000000008',
                           '99999999-0000-0000-0000-000000000009']) WITH ORDINALITY AS t(id, n) ORDER BY n$q$,
    $q$VALUES (true), (true), (true), (true), (true), (true), (true), (true), (true)$q$,
    'no post page for followers-only, direct, deleted, boost, suspended or blocked-instance posts, chat or DMs');
SELECT results_eq(
    $q$SELECT p #>> '{post,id}', p #>> '{post,author,username}', p #>> '{post,reply_to,id}'
         FROM public.public_post_page('f1883000-0000-0000-0000-000000000009') p$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000009'::text, 'pub188'::text, 'f1883000-0000-0000-0000-000000000020'::text)$q$,
    'a reply to another account has its own page, naming the post it answers');
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to, metadata, edit_history) VALUES
  ('f1883000-0000-0000-0000-000000000013', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"reply to followers-only"}]',
   'public', 'f1883000-0000-0000-0000-000000000021', '{}', '[]'),
  ('f1883000-0000-0000-0000-000000000014', 'f1880000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"quote of a quote"}]',
   'public', NULL, '{"reblog_of": "f1883000-0000-0000-0000-000000000007", "is_quote": true}',
   '[{"content": "before"}]');
SELECT is(public.public_post_page('f1883000-0000-0000-0000-000000000013') #> '{post,reply_to}', 'null'::jsonb,
  'a reply to a followers-only post names no post it answers');
SELECT results_eq(
    $q$SELECT p #>> '{post,quote,id}', p #> '{post,quote,quote}' FROM public.public_post_page('f1883000-0000-0000-0000-000000000014') p$q$,
    $q$VALUES ('f1883000-0000-0000-0000-000000000007'::text, 'null'::jsonb)$q$,
    'a quote carries the quoted post one level deep');
SELECT ok(public.public_post_page('f1883000-0000-0000-0000-000000000014') #>> '{post,edited_at}' IS NOT NULL
          AND public.public_post_page('f1883000-0000-0000-0000-000000000002') #> '{post,edited_at}' = 'null'::jsonb,
  'an edited post says when; an unedited one does not');

SELECT is(public.public_post_page('f1883000-0000-0000-0000-000000000002') #>> '{post,visibility}', 'unlisted',
  'an unlisted post has a page');
SELECT is(public.public_post_page('f1883000-0000-0000-0000-000000000011') #>> '{post,is_pinned}', 'true',
  'a pinned post says so');

UPDATE public.posts SET metadata = '{"is_poll": true, "poll_options": [{"name": "yes", "votes": 3}, {"name": "no", "votes": 1}],
                                     "poll_multiple_choice": false, "poll_voters_count": 4, "poll_closed": true}'
 WHERE id = 'f1883000-0000-0000-0000-000000000020';
SELECT results_eq(
    $q$SELECT p #>> '{post,poll,options,0,name}', (p #>> '{post,poll,closed}')::boolean, p #> '{post,poll,voters_count}'
         FROM public.public_post_page('f1883000-0000-0000-0000-000000000020') p$q$,
    $q$VALUES ('yes'::text, true, '4'::jsonb)$q$,
    'a poll carries its options, voters and state');

SELECT is((public.public_post_page('f1883000-0000-0000-0000-000000000001') #>> '{instance,registrations_open}')::boolean, true,
  'the instance block says whether registration is open');

UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'public_profile_pages';
SELECT is((public.public_profile_page('pub188', NULL, NULL) -> 'enabled')::boolean, false,
  'public_profile_pages false turns the pages off');
UPDATE public.instance_config SET config_value = '"false"'::jsonb WHERE config_key = 'public_profile_pages';
SELECT is((public.public_post_page('f1883000-0000-0000-0000-000000000001') -> 'enabled')::boolean, false,
  'a string "false" reads as off');
DELETE FROM public.instance_config WHERE config_key = 'public_profile_pages';
SELECT is((public.public_post_page('f1883000-0000-0000-0000-000000000001') -> 'enabled')::boolean, true,
  'an unset public_profile_pages reads as on');

SELECT * FROM finish();
ROLLBACK;
