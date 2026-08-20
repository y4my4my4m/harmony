-- can_subscribe_to_topic is the single gate on realtime delivery. Broadcast
-- carries no row context, so unlike postgres_changes there is no second check
-- once a client is on a topic.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

-- Unauthenticated ------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT is(public.can_subscribe_to_topic('feed:public'), false,
          'anon cannot subscribe to any topic');
SELECT is(public.can_subscribe_to_topic('user:11111111-0000-0000-0000-000000000001'), false,
          'anon cannot subscribe to a user topic');

-- Member ---------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.can_subscribe_to_topic('channel-messages-66666666-0000-0000-0000-000000000006'), true,
          'accepted member can subscribe to a channel in their server');
SELECT is(public.can_subscribe_to_topic('server-presence:55555555-0000-0000-0000-000000000005'), true,
          'accepted member can subscribe to server presence');
SELECT is(public.can_subscribe_to_topic('dm-conversation-77777777-0000-0000-0000-000000000007'), true,
          'participant can subscribe to their DM');
SELECT is(public.can_subscribe_to_topic('user:11111111-0000-0000-0000-000000000001'), true,
          'a user can subscribe to their own topic');
SELECT is(public.can_subscribe_to_topic('user:22222222-0000-0000-0000-000000000002'), false,
          'a user cannot subscribe to another user topic');

-- Feeds carry only public posts; broadcast_post_event gates every send on
-- visibility = 'public'.
SELECT is(public.can_subscribe_to_topic('feed:public'), true, 'member can subscribe to feed:public');
SELECT is(public.can_subscribe_to_topic('feed:hashtag:cats'), true, 'member can subscribe to a hashtag feed');

-- Non-member -----------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.can_subscribe_to_topic('channel-messages-66666666-0000-0000-0000-000000000006'), false,
          'non-member cannot subscribe to a channel');
SELECT is(public.can_subscribe_to_topic('dm-conversation-77777777-0000-0000-0000-000000000007'), false,
          'non-participant cannot subscribe to a DM');

-- Banned ---------------------------------------------------------------------
-- current_user_is_member_of_server() tests row existence only and would admit
-- this; the gate checks status = 'accepted' inline.
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is(public.can_subscribe_to_topic('channel-messages-66666666-0000-0000-0000-000000000006'), false,
          'banned member cannot subscribe to a channel');
SELECT is(public.can_subscribe_to_topic('server-presence:55555555-0000-0000-0000-000000000005'), false,
          'banned member cannot subscribe to server presence');

-- Malformed ------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.can_subscribe_to_topic('not-a-real-topic'), false, 'unknown topic prefix is denied');
SELECT is(public.can_subscribe_to_topic('channel-messages-not-a-uuid'), false,
          'malformed uuid is denied rather than raising');

SELECT * FROM finish();
ROLLBACK;
