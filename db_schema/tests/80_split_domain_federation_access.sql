-- 20261007600001_split_domain_federation_access.sql: federation_post_access and
-- federation_conversation_access match a remote account by its domain or by the host of
-- its actor id.
--
--   alice    local author (fixtures)
--   doesnm   follower and DM participant on a split-domain instance: account domain
--            understars80.example, actors on chat.understars80.example
--   portly   follower whose actor is on a non-default port
--   dora     remote on other80.example, related to nothing
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(13);

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f8010000-0000-0000-0000-000000000001', 'doesnm', 'doesnm', false, 'understars80.example',
   'https://chat.understars80.example/users/doesnm'),
  ('f8010000-0000-0000-0000-000000000002', 'portly', 'Portly', false, 'port80.example',
   'https://social.port80.example:8443/users/portly'),
  ('f8010000-0000-0000-0000-000000000003', 'dora', 'Dora', false, 'other80.example',
   'https://other80.example/users/dora');

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f8010000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'accepted'),
  ('f8010000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'accepted');

INSERT INTO public.posts (id, author_id, content, visibility, is_deleted) VALUES
  ('f8020000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"followers"}]', 'followers', false),
  ('f8020000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"mention","userId":"f8010000-0000-0000-0000-000000000001","username":"doesnm","domain":"understars80.example","isLocal":false},{"type":"text","text":" hi"}]',
   'direct', false);

INSERT INTO public.conversations (id, type, name)
VALUES ('f8030000-0000-0000-0000-000000000001', 'group', 'G80');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('f8030000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
  ('f8030000-0000-0000-0000-000000000001', 'f8010000-0000-0000-0000-000000000001');

-- Followers-only. -----------------------------------------------------------------------
SELECT ok(public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'chat.understars80.example'),
  'a followers-only post is served to the host serving a follower''s actor');
SELECT ok(public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'Chat.Understars80.Example'),
  'the actor host compares case-insensitively');
SELECT ok(public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'understars80.example'),
  'a followers-only post is still served to the follower''s account domain');
SELECT ok(public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'social.port80.example:8443')
          AND NOT public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'social.port80.example'),
  'an actor host on a non-default port matches with its port only');
SELECT ok(NOT public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'other80.example')
          AND NOT public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'understars80.example.evil'),
  'an unrelated instance reads no followers-only post');

UPDATE public.follows SET status = 'pending'
 WHERE follower_id = 'f8010000-0000-0000-0000-000000000001';
SELECT ok(NOT public.federation_post_access('f8020000-0000-0000-0000-000000000001', 'chat.understars80.example'),
  'a pending follower gives its actor host no access');

-- Direct. -------------------------------------------------------------------------------
SELECT ok(public.federation_post_access('f8020000-0000-0000-0000-000000000002', 'chat.understars80.example'),
  'a direct post is served to the host serving its recipient''s actor');
SELECT ok(NOT public.federation_post_access('f8020000-0000-0000-0000-000000000002', 'social.port80.example:8443'),
  'a direct post is not served to a follower''s instance');

-- Conversations. ------------------------------------------------------------------------
SELECT ok(public.federation_conversation_access('f8030000-0000-0000-0000-000000000001', 'chat.understars80.example')
          AND public.federation_conversation_access('f8030000-0000-0000-0000-000000000001', 'understars80.example'),
  'a conversation is served to its participant''s actor host and account domain');
SELECT ok(NOT public.federation_conversation_access('f8030000-0000-0000-0000-000000000001', 'other80.example'),
  'a conversation is not served to an instance without a participant');

UPDATE public.profiles SET is_suspended = true WHERE id = 'f8010000-0000-0000-0000-000000000001';
SELECT ok(NOT public.federation_conversation_access('f8030000-0000-0000-0000-000000000001', 'chat.understars80.example'),
  'a suspended participant gives its actor host no access');

-- Callers. ------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.federation_post_access(uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.federation_conversation_access(uuid, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.federation_post_access(uuid, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.federation_conversation_access(uuid, text)', 'EXECUTE'),
  'only the service role executes the access functions');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.federation_conversation_access('f8030000-0000-0000-0000-000000000001', 'chat.understars80.example')$q$,
    '42501'::char(5), NULL, 'a client cannot call federation_conversation_access');

SELECT * FROM finish();
ROLLBACK;
