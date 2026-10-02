-- 20261006700001_security_app_fixes.sql: system content parts, follow acceptance, the
-- user_media type list, the Ko-fi token, definer caller checks, is_room_member, the
-- post_interactions and voice participant policies, interaction broadcasts and revoked
-- sessions.
--
--   alice    owns server_1; instance admin from setup
--   bob      member of server_1; approves followers manually from setup
--   mallory  in no server
--   banned   user_servers row with status banned
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(82);

-- Setup, as postgres. -------------------------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET manually_approves_followers = true WHERE id = '22222222-0000-0000-0000-000000000002';

-- @everyone loses VIEW_CHANNEL (bit 1) on f6800000-...-01.
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f6800000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'staff68', 0),
  ('f6800000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'voice68', 2);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f6800000-0000-0000-0000-000000000001', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

INSERT INTO public.servers (id, name, owner)
VALUES ('f6810000-0000-0000-0000-000000000001', 'Other68', '22222222-0000-0000-0000-000000000002');

INSERT INTO public.conversations (id, type, name)
VALUES ('f6820000-0000-0000-0000-000000000001', 'group', 'G68');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('f6820000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
  ('f6820000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f6830000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"public"}]', 'public'),
  ('f6830000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"followers"}]', 'followers');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'accepted');
INSERT INTO public.post_interactions (user_id, post_id, interaction_type) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f6830000-0000-0000-0000-000000000001', 'favorite'),
  ('22222222-0000-0000-0000-000000000002', 'f6830000-0000-0000-0000-000000000001', 'bookmark'),
  ('22222222-0000-0000-0000-000000000002', 'f6830000-0000-0000-0000-000000000002', 'favorite');

INSERT INTO public.remote_emojis_cache (id, shortcode, origin_domain, full_code, url) VALUES
  ('f6840000-0000-0000-0000-000000000001', 'blob68', 'remote.example', ':blob68@remote.example:',
   'https://remote.example/emoji/blob68.png'),
  ('f6840000-0000-0000-0000-000000000002', 'cat68', 'remote.example', ':cat68@remote.example:',
   'https://remote.example/emoji/cat68.png');

INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
VALUES ('b6800000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', now(), now(), 'aal1');

-- Content parts. ------------------------------------------------------------------------
SELECT ok(public.content_has_system_part('[{"type":"text","text":"a"},{"type":"system","event_type":"x"}]'),
  'an array with a system part is detected');
SELECT ok(public.content_has_system_part(to_jsonb(' [{"type":"\u0073ystem","event_type":"x"}]'::text)),
  'JSON text holding an escaped system part is detected');
SELECT ok(NOT public.content_has_system_part(to_jsonb('my system prompt'::text))
          AND NOT public.content_has_system_part('[{"type":"text","text":"system"}]'),
  'text mentioning system is not a system part');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$INSERT INTO public.posts (author_id, content)
                   VALUES ('11111111-0000-0000-0000-000000000001',
                           '[{"type":"system","event_type":"<img src=x onerror=alert(1)>"}]')$q$,
  '42501', 'SYSTEM_PART_FORBIDDEN: system content parts are server-generated',
  'a client post with a system part is refused');
SELECT throws_ok($q$UPDATE public.posts SET content = '[{"type":"System","event_type":"x"}]'
                    WHERE id = 'f6830000-0000-0000-0000-000000000001'$q$,
  '42501', 'SYSTEM_PART_FORBIDDEN: system content parts are server-generated',
  'a client post edit adding a system part is refused');
SELECT throws_ok($q$UPDATE public.profiles SET bio = '[{"type":"system","event_type":"<iframe>"}]'
                    WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
  '42501', 'SYSTEM_PART_FORBIDDEN: system content parts are server-generated',
  'a client bio holding a system part is refused');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                           '[{"type":"system","event_type":"join"}]')$q$,
  '42501', 'SYSTEM_PART_FORBIDDEN: system content parts are server-generated',
  'a client message with a system part is refused');
SELECT lives_ok($q$UPDATE public.profiles SET bio = 'the system is fine'
                   WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
  'an ordinary bio is accepted');
SELECT lives_ok($q$UPDATE public.posts SET content = '[{"type":"text","text":"edited"}]'
                   WHERE id = 'f6830000-0000-0000-0000-000000000001'$q$,
  'an ordinary post edit is accepted');
SELECT tests.clear_authentication();
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                  VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                          '[{"type":"system","event_type":"join"}]')$q$,
  'service writers are not restricted');
SELECT ok(NOT has_function_privilege('authenticated', 'public.content_has_system_part(jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.refuse_client_system_parts()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.skip_share_outside_room()', 'EXECUTE'),
  'the content guard is not a client RPC');

-- follows. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
INSERT INTO public.follows (follower_id, following_id, status, ap_id, is_local, accepted_at)
VALUES ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'accepted',
        'https://evil.example/follow', false, '2000-01-01');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'accepted');
SELECT tests.clear_authentication();

SELECT is((SELECT row(status, ap_id, is_local, accepted_at IS NULL)::text FROM public.follows
            WHERE follower_id = '33333333-0000-0000-0000-000000000003'
              AND following_id = '22222222-0000-0000-0000-000000000002'),
  '(pending,,t,t)', 'a follow of a manually approving account starts pending, with server-set fields');
SELECT is((SELECT row(status, accepted_at IS NOT NULL)::text FROM public.follows
            WHERE follower_id = '33333333-0000-0000-0000-000000000003'
              AND following_id = '11111111-0000-0000-0000-000000000001'),
  '(accepted,t)', 'a follow of an auto-accepting account is accepted');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$UPDATE public.follows SET status = 'accepted'
                    WHERE follower_id = '33333333-0000-0000-0000-000000000003'
                      AND following_id = '22222222-0000-0000-0000-000000000002'$q$,
  '42501', 'only the followed account answers a follow request',
  'the follower cannot accept their own request');
SELECT throws_ok($q$UPDATE public.follows SET following_id = '44444444-0000-0000-0000-000000000004'
                    WHERE follower_id = '33333333-0000-0000-0000-000000000003'
                      AND following_id = '22222222-0000-0000-0000-000000000002'$q$,
  '42501', 'follow participants and federation fields are fixed',
  'the follower cannot retarget a follow');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$UPDATE public.follows SET follower_id = '44444444-0000-0000-0000-000000000004'
                    WHERE follower_id = '33333333-0000-0000-0000-000000000003'
                      AND following_id = '22222222-0000-0000-0000-000000000002'$q$,
  '42501', 'follow participants and federation fields are fixed',
  'the followed account cannot rewrite the follower');
SELECT lives_ok($q$UPDATE public.follows SET status = 'accepted', accepted_at = '2000-01-01'
                   WHERE follower_id = '33333333-0000-0000-0000-000000000003'
                     AND following_id = '22222222-0000-0000-0000-000000000002'
                     AND status = 'pending'$q$,
  'the followed account accepts a pending request');
SELECT throws_ok($q$UPDATE public.follows SET status = 'rejected'
                    WHERE follower_id = '33333333-0000-0000-0000-000000000003'
                      AND following_id = '22222222-0000-0000-0000-000000000002'$q$,
  '42501', 'a pending follow request is answered with accepted or rejected',
  'an answered request is not answered again');
SELECT tests.clear_authentication();

SELECT ok((SELECT status = 'accepted' AND accepted_at > '2000-01-02' FROM public.follows
            WHERE follower_id = '33333333-0000-0000-0000-000000000003'
              AND following_id = '22222222-0000-0000-0000-000000000002'),
  'acceptance stamps accepted_at server-side');

INSERT INTO public.profiles (id, username, display_name, is_local, domain)
VALUES ('f6850000-0000-0000-0000-000000000001', 'remote68', 'Remote', false, 'remote.example');
INSERT INTO public.follows (follower_id, following_id, status, is_local)
VALUES ('f6850000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'pending', false);
SELECT lives_ok($q$UPDATE public.follows SET status = 'accepted', accepted_at = now()
                   WHERE follower_id = 'f6850000-0000-0000-0000-000000000001'$q$,
  'service writers keep the federation transitions');
SELECT is((SELECT status FROM public.follows WHERE follower_id = 'f6850000-0000-0000-0000-000000000001'),
  'accepted', 'the service transition is stored');

-- user_media. ---------------------------------------------------------------------------
SELECT ok((SELECT allowed_mime_types IS NOT NULL
                  AND NOT (allowed_mime_types && ARRAY[
                      'image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml',
                      'application/xml', 'text/javascript', 'application/javascript',
                      'application/x-msdownload', 'application/x-sh', 'image/*', 'text/*',
                      'application/*', '*/*'])
                  AND NOT EXISTS (SELECT 1 FROM unnest(allowed_mime_types) t
                                   WHERE t ~* '(svg|html|javascript|ecmascript)')
             FROM storage.buckets WHERE id = 'user_media'),
  'user_media refuses SVG, HTML, XML, script and executable types');
SELECT ok((SELECT ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/*', 'audio/*',
                        'application/pdf', 'text/plain', 'application/zip'] <@ allowed_mime_types
             FROM storage.buckets WHERE id = 'user_media'),
  'user_media keeps the image, video, audio and document types the app uploads');

-- instance_funding. ---------------------------------------------------------------------
SELECT ok(NOT has_column_privilege('authenticated', 'public.instance_funding', 'kofi_webhook_token', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.instance_funding', 'kofi_webhook_token', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.instance_funding', 'kofi_webhook_token', 'INSERT')
          AND NOT has_table_privilege('anon', 'public.instance_funding', 'SELECT'),
  'clients hold no privilege on the Ko-fi token');
SELECT ok(has_column_privilege('authenticated', 'public.instance_funding', 'enabled', 'SELECT')
          AND has_column_privilege('authenticated', 'public.instance_funding', 'funding_links', 'UPDATE')
          AND has_column_privilege('service_role', 'public.instance_funding', 'kofi_webhook_token', 'SELECT'),
  'other funding columns stay readable and the webhook reads the token');

-- The row is written through the admin RPC: production grants postgres nothing on the table.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_kofi_webhook_token('  kofi-secret-68  ')$q$, 'an admin sets the token');
SELECT is(public.get_kofi_webhook_token(), 'kofi-secret-68', 'an admin reads the trimmed token');
SELECT lives_ok($q$UPDATE public.instance_funding SET enabled = true, goal_description = 'g68'$q$,
  'an admin updates the other funding columns directly');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT kofi_webhook_token FROM public.instance_funding$q$,
  '42501', NULL, 'a user cannot select the token');
SELECT ok((SELECT count(*) FROM public.instance_funding WHERE enabled AND goal_description = 'g68') >= 1,
  'a user reads the public funding columns');
SELECT throws_ok($q$SELECT public.get_kofi_webhook_token()$q$, '42501', NULL,
  'a non-admin cannot read the token through the RPC');
SELECT throws_ok($q$SELECT public.set_kofi_webhook_token('x')$q$, '42501', NULL,
  'a non-admin cannot set the token');
SELECT throws_ok($q$UPDATE public.instance_funding SET kofi_webhook_token = 'x'$q$, '42501', NULL,
  'a user cannot write the token column');
SELECT tests.clear_authentication();

-- Definer caller checks. ----------------------------------------------------------------
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('import_remote_emoji', 'register_recovery_key', 'get_federated_timeline',
                       'get_unread_announcements', 'get_admin_user_counts', 'recompute_supporter_tier',
                       'update_group_name', 'update_group_icon', 'remove_group_icon',
                       'add_bot_to_server', 'is_room_member', 'get_room_member_ids',
                       'get_kofi_webhook_token', 'set_kofi_webhook_token', 'is_profile_in_voice')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'anon cannot execute the client definers');
SELECT ok(NOT has_function_privilege('authenticated', 'public.can_manage_group_icon(uuid, uuid)', 'EXECUTE'),
  'can_manage_group_icon is not a client RPC');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.import_remote_emoji('f6840000-0000-0000-0000-000000000001')$q$,
  '42501', NULL, 'a non-admin cannot import an instance emoji');
SELECT throws_ok($q$SELECT public.import_remote_emoji('f6840000-0000-0000-0000-000000000001', NULL,
                     '55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a member cannot import into a server they do not own');
SELECT isnt(public.import_remote_emoji('f6840000-0000-0000-0000-000000000002', NULL,
              'f6810000-0000-0000-0000-000000000001'), NULL,
  'a server owner imports into their server');
SELECT throws_ok($q$SELECT public.register_recovery_key('11111111-0000-0000-0000-000000000001', 'code')$q$,
  '42501', NULL, 'a recovery key cannot be registered for another user');
SELECT lives_ok($q$SELECT public.register_recovery_key('22222222-0000-0000-0000-000000000002', 'code')$q$,
  'a user registers their own recovery key');
SELECT throws_ok($q$SELECT * FROM public.get_federated_timeline('11111111-0000-0000-0000-000000000001')$q$,
  '42501', NULL, 'another user''s interaction state is not returned');
SELECT lives_ok($q$SELECT * FROM public.get_federated_timeline('22222222-0000-0000-0000-000000000002')$q$,
  'the caller reads the federated timeline with their own state');
SELECT throws_ok($q$SELECT * FROM public.get_unread_announcements('aaaaaaaa-0000-0000-0000-000000000001')$q$,
  '42501', NULL, 'another user''s unread announcements are not listed');
SELECT lives_ok($q$SELECT * FROM public.get_unread_announcements('bbbbbbbb-0000-0000-0000-000000000002')$q$,
  'the caller lists their announcements by auth uid');
SELECT lives_ok($q$SELECT * FROM public.get_unread_announcements('22222222-0000-0000-0000-000000000002', true)$q$,
  'the caller lists their announcements by profile id');
SELECT throws_ok($q$SELECT * FROM public.get_admin_user_counts(ARRAY['11111111-0000-0000-0000-000000000001'::uuid])$q$,
  '42501', NULL, 'a non-admin cannot read admin user counts');
SELECT throws_ok($q$SELECT public.recompute_supporter_tier('11111111-0000-0000-0000-000000000001')$q$,
  '42501', NULL, 'a non-admin cannot recompute a supporter tier');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((public.update_group_name('f6820000-0000-0000-0000-000000000001',
                                    '11111111-0000-0000-0000-000000000001', 'pwned') ->> 'success'),
  'false', 'naming a participant does not let an outsider rename a group');
SELECT is((public.update_group_icon('f6820000-0000-0000-0000-000000000001',
                                    '11111111-0000-0000-0000-000000000001', 'x.png') ->> 'success'),
  'false', 'naming a participant does not let an outsider set a group icon');
SELECT is((public.remove_group_icon('f6820000-0000-0000-0000-000000000001',
                                    '11111111-0000-0000-0000-000000000001') ->> 'success'),
  'false', 'naming a participant does not let an outsider remove a group icon');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.get_admin_user_counts(ARRAY['22222222-0000-0000-0000-000000000002'::uuid])),
  1, 'an admin reads admin user counts');
SELECT is((public.update_group_name('f6820000-0000-0000-0000-000000000001',
                                    '33333333-0000-0000-0000-000000000003', 'Renamed') ->> 'success'),
  'true', 'a participant renames the group whatever id is passed');
SELECT tests.clear_authentication();
SELECT is((SELECT name FROM public.conversations WHERE id = 'f6820000-0000-0000-0000-000000000001'),
  'Renamed', 'only the participant''s rename landed');

-- is_room_member. -----------------------------------------------------------------------
SELECT ok(public.is_room_member('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002'),
  'an accepted member is in an open channel room');
SELECT ok(NOT public.is_room_member('66666666-0000-0000-0000-000000000006', '44444444-0000-0000-0000-000000000004'),
  'a banned member is not in the room');
SELECT ok(NOT public.is_room_member('f6800000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
  'a member without VIEW_CHANNEL is not in a restricted channel room');
SELECT ok(public.is_room_member('f6800000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
  'the owner is in a restricted channel room');
SELECT ok(public.is_room_member('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002')
          AND NOT public.is_room_member('77777777-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000003'),
  'conversation rooms are unchanged');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(x ORDER BY x)::text FROM public.get_room_member_ids('f6800000-0000-0000-0000-000000000001') x),
  '{11111111-0000-0000-0000-000000000001}', 'a restricted channel room lists the profiles that can view it');
SELECT is((SELECT array_agg(x ORDER BY x)::text FROM public.get_room_member_ids('66666666-0000-0000-0000-000000000006') x),
  '{11111111-0000-0000-0000-000000000001,22222222-0000-0000-0000-000000000002}',
  'an open channel room lists accepted members and the owner, not banned ones');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.get_room_member_ids('66666666-0000-0000-0000-000000000006')),
  0, 'a caller outside the room gets no member list');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                  VALUES ('s68', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                          '22222222-0000-0000-0000-000000000002', 'k'),
                         ('s68', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                          '44444444-0000-0000-0000-000000000004', 'k'),
                         ('s68', 'f6800000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                          '22222222-0000-0000-0000-000000000002', 'k')$q$,
  'a share batch naming recipients outside the room is accepted');
SELECT is((SELECT string_agg(room_id || '>' || recipient_user_id, ',') FROM public.megolm_session_shares WHERE session_id = 's68'),
  '66666666-0000-0000-0000-000000000006>22222222-0000-0000-0000-000000000002',
  'only the member who can view the channel receives the key; banned and restricted rows are skipped');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                   VALUES ('s68b', '66666666-0000-0000-0000-000000000006', '44444444-0000-0000-0000-000000000004',
                           '11111111-0000-0000-0000-000000000001', 'k')$q$,
  '42501', NULL, 'a banned member cannot share into the room');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$UPDATE public.megolm_session_shares SET recipient_user_id = '44444444-0000-0000-0000-000000000004'
                    WHERE session_id = 's68'$q$,
  '42501', NULL, 'the sender cannot move a share to a banned member');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$UPDATE public.megolm_session_shares SET is_claimed = true, claimed_at = now()
                   WHERE session_id = 's68'$q$,
  'the recipient claims their share');
SELECT tests.clear_authentication();

-- post_interactions. --------------------------------------------------------------------
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT string_agg(interaction_type, ',' ORDER BY interaction_type) FROM public.post_interactions
            WHERE post_id IN ('f6830000-0000-0000-0000-000000000001', 'f6830000-0000-0000-0000-000000000002')),
  'favorite', 'a stranger sees a favourite on a public post, not bookmarks or followers-only posts');
SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM public.post_interactions
            WHERE post_id IN ('f6830000-0000-0000-0000-000000000001', 'f6830000-0000-0000-0000-000000000002')),
  1, 'anon sees the public favourite only');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.post_interactions
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND post_id IN ('f6830000-0000-0000-0000-000000000001', 'f6830000-0000-0000-0000-000000000002')),
  3, 'a user sees all of their own interactions');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.post_interactions
            WHERE post_id = 'f6830000-0000-0000-0000-000000000002'),
  1, 'the author sees interactions on their followers-only post');
SELECT tests.clear_authentication();

SELECT is((SELECT string_agg(topic, ',' ORDER BY topic) FROM realtime.messages
            WHERE payload ->> 'type' = 'post:interaction'
              AND payload ->> 'interaction_type' = 'bookmark'),
  'user:22222222-0000-0000-0000-000000000002', 'a bookmark is sent to the bookmarker only');
SELECT is((SELECT string_agg(topic, ',' ORDER BY topic) FROM realtime.messages
            WHERE payload ->> 'type' = 'post:interaction'
              AND payload ->> 'post_id' = 'f6830000-0000-0000-0000-000000000002'),
  'user:11111111-0000-0000-0000-000000000001', 'a followers-only interaction reaches the author only');
SELECT ok((SELECT count(*) FROM realtime.messages
            WHERE payload ->> 'post_id' = 'f6830000-0000-0000-0000-000000000001'
              AND payload ->> 'interaction_type' = 'favorite'
              AND topic IN ('feed:user:11111111-0000-0000-0000-000000000001', 'feed:public', 'feed:local')) = 3,
  'a public interaction still reaches the feed topics');

-- voice_channel_participants. -----------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                   VALUES ('f6800000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005',
                           '22222222-0000-0000-0000-000000000002')$q$,
  '42501', NULL, 'a member cannot join voice in a channel they cannot view');
SELECT throws_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                   VALUES ('f6800000-0000-0000-0000-000000000002', 'f6810000-0000-0000-0000-000000000001',
                           '22222222-0000-0000-0000-000000000002')$q$,
  '42501', NULL, 'a voice row names its channel''s server');
SELECT lives_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                  VALUES ('f6800000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                          '22222222-0000-0000-0000-000000000002')$q$,
  'a member joins voice in a channel they can view');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants
            WHERE channel_id = 'f6800000-0000-0000-0000-000000000002'),
  0, 'a non-member does not see voice occupancy');
SELECT ok(public.is_profile_in_voice('22222222-0000-0000-0000-000000000002')
          AND NOT public.is_profile_in_voice('33333333-0000-0000-0000-000000000003'),
  'is_profile_in_voice answers busy without the channel');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants
            WHERE channel_id = 'f6800000-0000-0000-0000-000000000002'),
  1, 'a member who can view the channel sees occupancy');
SELECT tests.clear_authentication();

-- session_meets_aal. --------------------------------------------------------------------
SELECT set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated', 'aal', 'aal1',
    'session_id', 'b6800000-0000-0000-0000-000000000002')::text, true);
SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', true);
SELECT set_config('role', 'authenticated', true);
SELECT ok(public.session_meets_aal(), 'a live session meets the assurance level');
SELECT set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated', 'aal', 'aal2',
    'session_id', 'b6800000-0000-0000-0000-00000000dead')::text, true);
SELECT ok(NOT public.session_meets_aal(), 'a revoked session does not, even at aal2');
SELECT is((SELECT count(*)::int FROM public.messages), 0, 'a revoked session reads no messages');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
