-- The RLS authorization matrix.
--
-- Every assertion is a (role, table, verb) cell: anon, an owner, and a
-- non-owner against the tables a session touches. A negative cell is always
-- preceded by the matching positive one -- a policy that denies everyone, or a
-- helper that silently returns NULL, satisfies "cannot read" without proving
-- anything.
--
-- Two shapes of denial exist and they are not interchangeable. A failed INSERT
-- or a WITH CHECK violation raises 42501. A row filtered out by a USING clause
-- on UPDATE or DELETE reports success with zero rows affected, so those cells
-- assert the target row's value afterwards rather than trapping an error.
--
-- Fixture roles: alice owns server_1 and is instance admin (the first profile
-- inserted is promoted by trigger); bob is an accepted member and DM
-- participant; mallory belongs to nothing; banned has user_servers.status =
-- 'banned'.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(75);

-- Setup, as postgres, before any impersonation. ------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES
  ('e0000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wfreader@test.local'),
  ('e0000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'spare@test.local');

-- A reader used only by the block scenario, so blocking it perturbs no other
-- cell in the matrix.
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('e1000000-0000-0000-0000-0000000000c1', 'e0000000-0000-0000-0000-0000000000c1',
        'wfreader', 'WF Reader', true);

INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('e1000000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', 'accepted');

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('a0000000-0000-0000-0000-00000000c001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"public post"}]', 'public'),
  ('a0000000-0000-0000-0000-00000000c002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"followers only"}]', 'followers');

INSERT INTO public.invites (id, code, server_id, created_by)
VALUES ('b0000000-0000-0000-0000-00000000d001', 'wfrlsbob',
        '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002');

INSERT INTO public.notifications (id, user_id, type)
VALUES ('b0000000-0000-0000-0000-00000000e001', '11111111-0000-0000-0000-000000000001', 'system'),
       ('b0000000-0000-0000-0000-00000000e002', '22222222-0000-0000-0000-000000000002', 'system');

-- A pending call to alice from a remote actor, of the shape
-- VoiceActivityHandler.handleVoiceCallInvite writes.
INSERT INTO public.federated_voice_calls
  (id, ap_id, caller_federated_id, recipient_id, call_type, conversation_id,
   livekit_url, room_name, status)
VALUES ('b0000000-0000-0000-0000-00000000f001', 'https://remote.test/activities/call-1',
        'https://remote.test/users/carol', '11111111-0000-0000-0000-000000000001',
        'voice', '77777777-0000-0000-0000-000000000007', 'wss://livekit.test',
        'federated-dm-77777777-0000-0000-0000-000000000007', 'pending');

-- The seed row exists with a null secret; a null reads the same whether the
-- policy hides the row or not.
UPDATE public.instance_webrtc_settings SET livekit_api_secret = 'livekit-secret-value';

-- PROFILES --------------------------------------------------------------------
-- profiles_select_all is USING (true): the directory is public by design, and
-- that is the baseline the write cells are measured against.
SELECT tests.authenticate_as_anon();
SELECT isnt_empty(
    $q$SELECT id FROM public.profiles WHERE username = 'alice'$q$,
    'anon reads the public profile directory');

SELECT throws_ok(
    $q$INSERT INTO public.profiles (id, username, is_local)
       VALUES ('0a000000-0000-0000-0000-00000000000a', 'anonprofile', true)$q$,
    '42501'::char(5), NULL,
    'anon cannot create a profile');

UPDATE public.profiles SET display_name = 'Anon Was Here'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT display_name FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'),
          'Alice',
          'an anon UPDATE of another profile matches no row');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.profiles SET display_name = 'Alice Renamed'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT display_name FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'),
          'Alice Renamed',
          'a user renames their own profile');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
UPDATE public.profiles SET display_name = 'Mallory Was Here'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT display_name FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'),
          'Alice Renamed',
          'one user cannot rename another user''s profile');

DELETE FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT isnt_empty(
    $q$SELECT id FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
    'one user cannot delete another user''s profile');

-- Identity takeover. profiles_update_own carries USING but no WITH CHECK, so
-- Postgres reuses USING as the check on the new row: the row a caller may write
-- is also the only auth_user_id it may end up carrying. Rewriting the column
-- would otherwise re-point a profile at another auth identity while passing the
-- USING test on the old value.
SELECT throws_ok(
    $q$UPDATE public.profiles SET auth_user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        WHERE id = '33333333-0000-0000-0000-000000000003'$q$,
    '42501'::char(5), NULL,
    'a user cannot repoint their profile at another user''s auth identity');

SELECT throws_ok(
    $q$UPDATE public.profiles SET auth_user_id = 'e0000000-0000-0000-0000-0000000000f0'
        WHERE id = '33333333-0000-0000-0000-000000000003'$q$,
    '42501'::char(5), NULL,
    'a user cannot move their profile onto an unclaimed auth identity');

-- Control for the two above: the row itself is writable, so those failed on the
-- new auth_user_id and not on the row being out of reach.
UPDATE public.profiles SET display_name = 'Mallory Renamed'
 WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT is((SELECT display_name FROM public.profiles WHERE id = '33333333-0000-0000-0000-000000000003'),
          'Mallory Renamed',
          'the same caller can still write other columns on their own profile');

-- POSTS -----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c002'$q$,
    'an author reads their own followers-only post');

SELECT tests.authenticate_as('e0000000-0000-0000-0000-0000000000c1');
SELECT isnt_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c002'$q$,
    'an accepted follower reads a followers-only post');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT isnt_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c001'$q$,
    'a non-follower reads the author''s public post');
SELECT is_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c002'$q$,
    'a non-follower does not read the author''s followers-only post');

SELECT tests.authenticate_as_anon();
SELECT isnt_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c001'$q$,
    'anon reads a public post');
SELECT is_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c002'$q$,
    'anon does not read a followers-only post');

SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content)
       VALUES ('11111111-0000-0000-0000-000000000001', '[]'::jsonb)$q$,
    '42501'::char(5), NULL,
    'anon cannot author a post');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content)
       VALUES ('11111111-0000-0000-0000-000000000001', '[]'::jsonb)$q$,
    '42501'::char(5), NULL,
    'a user cannot author a post under another profile');

-- Blocking. posts_select_public gates on is_blocked_by(author_id) ahead of the
-- visibility test, so a block outranks an accepted follow.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
       VALUES ('11111111-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-0000000000c1')$q$,
    'a user records a block against another user');

SELECT tests.authenticate_as('e0000000-0000-0000-0000-0000000000c1');
SELECT is_empty(
    $q$SELECT id FROM public.posts WHERE id = 'a0000000-0000-0000-0000-00000000c002'$q$,
    'a blocked reader loses sight of the blocker''s followers-only post');

-- Control: the follow row is untouched, so the assertion above is the block
-- predicate and not a cascade that dropped the follow.
SELECT isnt_empty(
    $q$SELECT follower_id FROM public.follows
       WHERE follower_id = 'e1000000-0000-0000-0000-0000000000c1'
         AND following_id = '11111111-0000-0000-0000-000000000001'
         AND status = 'accepted'$q$,
    'the accepted follow survives the block');

-- MESSAGES ---------------------------------------------------------------------
-- messages_insert_member's WITH CHECK once tested only user_id = self, so any
-- authenticated caller could post into any channel on the instance. The
-- membership arm is what these four cells pin.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.messages (id, channel_id, user_id, content)
       VALUES ('c0000000-0000-0000-0000-00000000b001',
               '66666666-0000-0000-0000-000000000006',
               '22222222-0000-0000-0000-000000000002',
               '[{"type":"text","text":"from bob"}]'::jsonb)$q$,
    'an accepted member posts to their server channel');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006',
               '33333333-0000-0000-0000-000000000003',
               '[{"type":"text","text":"intruder"}]'::jsonb)$q$,
    '42501'::char(5), NULL,
    'a non-member cannot post to a server channel');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006',
               '44444444-0000-0000-0000-000000000004',
               '[{"type":"text","text":"still banned"}]'::jsonb)$q$,
    '42501'::char(5), NULL,
    'a banned member cannot post to a server channel');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006',
               '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"anon"}]'::jsonb)$q$,
    '42501'::char(5), NULL,
    'anon cannot post to a server channel');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('77777777-0000-0000-0000-000000000007',
               '22222222-0000-0000-0000-000000000002',
               '[{"type":"text","text":"dm from bob"}]'::jsonb)$q$,
    'a conversation participant sends into their DM');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('77777777-0000-0000-0000-000000000007',
               '33333333-0000-0000-0000-000000000003',
               '[{"type":"text","text":"uninvited"}]'::jsonb)$q$,
    '42501'::char(5), NULL,
    'a non-participant cannot send into a DM');

-- Edit and delete are owner-or-moderator. bob holds no server role and is not
-- instance admin, so he stands for the plain co-member.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET content = '[{"type":"text","text":"tampered"}]'::jsonb
 WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is((SELECT content->0->>'text' FROM public.messages
            WHERE id = '88888888-0000-0000-0000-000000000008'),
          'channel message',
          'a co-member cannot edit another user''s channel message');

DELETE FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT isnt_empty(
    $q$SELECT id FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008'$q$,
    'a co-member cannot delete another user''s channel message');

UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'::jsonb
 WHERE id = 'c0000000-0000-0000-0000-00000000b001';
SELECT is((SELECT content->0->>'text' FROM public.messages
            WHERE id = 'c0000000-0000-0000-0000-00000000b001'),
          'edited',
          'a user edits their own message');

-- CONVERSATIONS ----------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$SELECT id FROM public.conversations WHERE id = '77777777-0000-0000-0000-000000000007'$q$,
    'a participant reads their conversation row');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT id FROM public.conversations$q$,
    'a user in no conversation enumerates none');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.conversations (type, created_by)
       VALUES ('direct', '22222222-0000-0000-0000-000000000002')$q$,
    'a user creates a conversation attributed to themselves');

SELECT throws_ok(
    $q$INSERT INTO public.conversations (type, created_by)
       VALUES ('direct', '11111111-0000-0000-0000-000000000001')$q$,
    '42501'::char(5), NULL,
    'a user cannot create a conversation attributed to someone else');

-- FOLLOWS ----------------------------------------------------------------------
-- follows_select_all is USING (true): the social graph is public, which is what
-- makes the write cells below the only protection on it.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT isnt_empty(
    $q$SELECT follower_id FROM public.follows
       WHERE follower_id = 'e1000000-0000-0000-0000-0000000000c1'$q$,
    'the follow graph is readable by any authenticated user');

DELETE FROM public.follows WHERE follower_id = 'e1000000-0000-0000-0000-0000000000c1';
SELECT isnt_empty(
    $q$SELECT follower_id FROM public.follows
       WHERE follower_id = 'e1000000-0000-0000-0000-0000000000c1'$q$,
    'a user cannot delete a follow they do not own');

SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('11111111-0000-0000-0000-000000000001',
               '33333333-0000-0000-0000-000000000003', 'accepted')$q$,
    '42501'::char(5), NULL,
    'a user cannot forge a follow on another user''s behalf');

SELECT lives_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('33333333-0000-0000-0000-000000000003',
               '22222222-0000-0000-0000-000000000002', 'pending')$q$,
    'a user creates a follow for themselves');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('33333333-0000-0000-0000-000000000003',
               '11111111-0000-0000-0000-000000000001', 'pending')$q$,
    '42501'::char(5), NULL,
    'anon cannot create a follow');

-- SERVERS -----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.servers SET description = 'owner edit'
 WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT description FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
          'owner edit',
          'a server owner edits their server');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.servers SET description = 'member edit'
 WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT description FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
          'owner edit',
          'an accepted member who is not the owner cannot edit the server');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
DELETE FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT isnt_empty(
    $q$SELECT id FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
    'a non-member cannot delete a server');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.servers (id, name, owner)
       VALUES ('5b000000-0000-0000-0000-00000000000b', 'Bob Server',
               '22222222-0000-0000-0000-000000000002')$q$,
    'a user creates a server they own');

SELECT throws_ok(
    $q$INSERT INTO public.servers (id, name, owner)
       VALUES ('5c000000-0000-0000-0000-00000000000c', 'Forged',
               '11111111-0000-0000-0000-000000000001')$q$,
    '42501'::char(5), NULL,
    'a user cannot create a server owned by someone else');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO public.servers (id, name, owner)
       VALUES ('5d000000-0000-0000-0000-00000000000d', 'Anon Server',
               '11111111-0000-0000-0000-000000000001')$q$,
    '42501'::char(5), NULL,
    'anon cannot create a server');

-- CHANNELS -----------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT isnt_empty(
    $q$SELECT id FROM public.channels WHERE id = '66666666-0000-0000-0000-000000000006'$q$,
    'an accepted member reads their server''s channels');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT id FROM public.channels
       WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'a non-member reads none of that server''s channels');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is_empty(
    $q$SELECT id FROM public.channels
       WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'a banned member reads none of that server''s channels');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.channels (server_id, name, type)
       VALUES ('55555555-0000-0000-0000-000000000005', 'owner-made', 0)$q$,
    'a server owner creates a channel');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO public.channels (server_id, name, type)
       VALUES ('55555555-0000-0000-0000-000000000005', 'member-made', 0)$q$,
    '42501'::char(5), NULL,
    'an accepted member who is not the owner cannot create a channel');

SELECT tests.authenticate_as_anon();
SELECT is_empty(
    $q$SELECT id FROM public.channels$q$,
    'anon reads no channels at all');

-- NOTIFICATIONS -------------------------------------------------------------------
-- notifications_insert_system was WITH CHECK (true) for every role, which let a
-- PostgREST client mint fake mentions, DM alerts and admin prompts for any
-- user. INSERT is now service_role only; every notification arrives from a
-- SECURITY DEFINER trigger that bypasses RLS.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$SELECT id FROM public.notifications
       WHERE id = 'b0000000-0000-0000-0000-00000000e001'$q$,
    'a user reads their own notification');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT id FROM public.notifications
       WHERE id = 'b0000000-0000-0000-0000-00000000e001'$q$,
    'a user cannot read another user''s notification');

SELECT throws_ok(
    $q$INSERT INTO public.notifications (user_id, type, data)
       VALUES ('22222222-0000-0000-0000-000000000002', 'mention', '{"forged":true}'::jsonb)$q$,
    '42501'::char(5), NULL,
    'a user cannot forge a notification for another user');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.notifications (user_id, type)
       VALUES ('11111111-0000-0000-0000-000000000001', 'mention')$q$,
    '42501'::char(5), NULL,
    'no authenticated caller inserts a notification, not even for themselves');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO public.notifications (user_id, type)
       VALUES ('11111111-0000-0000-0000-000000000001', 'mention')$q$,
    '42501'::char(5), NULL,
    'anon cannot insert a notification');

-- Both UPDATEs are unqualified. A WHERE clause reads columns, which brings the
-- SELECT policy to bear as well, and notifications_select_own alone reduces the
-- statement to zero rows for a non-owner -- the cell then holds whatever
-- notifications_update_own says, including nothing. SET to a constant with no
-- WHERE and no RETURNING leaves the UPDATE policy as the only filter.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.notifications SET is_read = true;
SELECT is((SELECT is_read FROM public.notifications
            WHERE id = 'b0000000-0000-0000-0000-00000000e002'), true,
          'a user marks their own notification read');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
UPDATE public.notifications SET is_read = true;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT is_read FROM public.notifications
            WHERE id = 'b0000000-0000-0000-0000-00000000e001'), false,
          'a user cannot mark another user''s notification read');

-- INVITES ---------------------------------------------------------------------------
-- SELECT was USING (true), which turned the table into a full listing of every
-- live invite code on the instance. Reads are now creator or instance admin;
-- redeeming a code goes through the single-row RPC lookup_invite_by_code.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT isnt_empty(
    $q$SELECT code FROM public.invites WHERE id = 'b0000000-0000-0000-0000-00000000d001'$q$,
    'an invite creator reads their own invite');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT code FROM public.invites$q$,
    'another user cannot enumerate invite codes');

SELECT tests.authenticate_as_anon();
SELECT is_empty(
    $q$SELECT code FROM public.invites$q$,
    'anon cannot enumerate invite codes');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$SELECT code FROM public.invites WHERE id = 'b0000000-0000-0000-0000-00000000d001'$q$,
    'an instance admin reads invites they did not create');

-- invites_insert_members reads auth.role(), which resolves
-- request.jwt.claim.role -- a claim GoTrue emits and tests.authenticate_as does
-- not set. Left unset every INSERT here fails on the role test alone and the
-- membership arm goes untested, so the claim is supplied explicitly and cleared
-- again afterwards.
SELECT tests.authenticate_as_anon();
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT throws_ok(
    $q$INSERT INTO public.invites (code, server_id, created_by)
       VALUES ('wfrlsanon', '55555555-0000-0000-0000-000000000005',
               '22222222-0000-0000-0000-000000000002')$q$,
    '42501'::char(5), NULL,
    'anon cannot mint an invite');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT lives_ok(
    $q$INSERT INTO public.invites (code, server_id, created_by)
       VALUES ('wfrlsbob2', '55555555-0000-0000-0000-000000000005',
               '22222222-0000-0000-0000-000000000002')$q$,
    'a server member mints an invite to that server');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT throws_ok(
    $q$INSERT INTO public.invites (code, server_id, created_by)
       VALUES ('wfrlsmal', '55555555-0000-0000-0000-000000000005',
               '33333333-0000-0000-0000-000000000003')$q$,
    '42501'::char(5), NULL,
    'a non-member cannot mint an invite to that server');
SELECT set_config('request.jwt.claim.role', '', true);

-- INSTANCE WEBRTC SETTINGS ------------------------------------------------------------
-- The row carries livekit_api_secret. Non-admin clients read the sanitised
-- projection through get_livekit_config(); the table itself is admin only.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT livekit_api_secret FROM public.instance_webrtc_settings),
          'livekit-secret-value',
          'an instance admin reads the webrtc settings row');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty(
    $q$SELECT id FROM public.instance_webrtc_settings$q$,
    'a non-admin user reads no webrtc settings row');

UPDATE public.instance_webrtc_settings SET livekit_api_secret = 'stolen';

SELECT tests.authenticate_as_anon();
SELECT is_empty(
    $q$SELECT id FROM public.instance_webrtc_settings$q$,
    'anon reads no webrtc settings row');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT livekit_api_secret FROM public.instance_webrtc_settings),
          'livekit-secret-value',
          'a non-admin UPDATE of the livekit secret matches no row');

-- FEDERATED VOICE CALLS ---------------------------------------------------------------
-- A row here authorises a remote actor for a LiveKit room
-- (LiveKitService.validateFederatedRoomAccess, dm_call branch). Only the service
-- role writes it, and the service role bypasses RLS, so every client cell is a
-- denial. The denials are privilege errors, not policy misses: anon and
-- authenticated hold no write bit on the table.
SELECT tests.clear_authentication();
SELECT isnt_empty(
    $q$SELECT id FROM public.federated_voice_calls
        WHERE ap_id = 'https://remote.test/activities/call-1'$q$,
    'the seeded federated call row exists');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO public.federated_voice_calls
         (ap_id, caller_federated_id, recipient_id, call_type, livekit_url, room_name)
       VALUES ('ap-forged-anon', 'https://evil.test/users/mallory',
               '11111111-0000-0000-0000-000000000001', 'voice', 'wss://evil.test',
               'federated-dm-77777777-0000-0000-0000-000000000007')$q$,
    '42501'::char(5), NULL,
    'anon cannot forge a federated call row');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO public.federated_voice_calls
         (ap_id, caller_federated_id, recipient_id, call_type, livekit_url, room_name)
       VALUES ('ap-forged-mallory', 'https://evil.test/users/mallory',
               '11111111-0000-0000-0000-000000000001', 'voice', 'wss://evil.test',
               'federated-dm-77777777-0000-0000-0000-000000000007')$q$,
    '42501'::char(5), NULL,
    'a user party to nothing cannot forge a federated call row');

-- alice is the recipient of the seeded row, so she is the most privileged client
-- the table knows.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.federated_voice_calls
         (ap_id, caller_federated_id, recipient_id, call_type, livekit_url, room_name)
       VALUES ('ap-forged-alice', 'https://evil.test/users/alice',
               '11111111-0000-0000-0000-000000000001', 'voice', 'wss://evil.test',
               'federated-dm-77777777-0000-0000-0000-000000000007')$q$,
    '42501'::char(5), NULL,
    'the recipient of a call cannot insert a federated call row either');

SELECT throws_ok(
    $q$UPDATE public.federated_voice_calls SET status = 'accepted'
        WHERE id = 'b0000000-0000-0000-0000-00000000f001'$q$,
    '42501'::char(5), NULL,
    'the recipient cannot update the call row despite the UPDATE policies');

SELECT throws_ok(
    $q$DELETE FROM public.federated_voice_calls
        WHERE id = 'b0000000-0000-0000-0000-00000000f001'$q$,
    '42501'::char(5), NULL,
    'the recipient cannot delete the call row');

-- SELECT is still granted; no SELECT policy exists, so it yields nothing.
SELECT is_empty(
    $q$SELECT id FROM public.federated_voice_calls$q$,
    'the recipient reads no federated call row');

SELECT * FROM finish();
ROLLBACK;
