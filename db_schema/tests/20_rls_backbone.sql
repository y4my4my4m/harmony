-- RLS on the tables a session cannot function without.
--
-- These assertions exist to guard the surface reduction. Eleven helper
-- functions are referenced by policy predicates, which execute as the querying
-- role: revoking EXECUTE on any of them locks every user out of every table
-- while leaving the policies looking correct. A permission failure inside a
-- policy surfaces here as a user who can suddenly see nothing.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

-- Channel messages -----------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = '66666666-0000-0000-0000-000000000006'), 1,
          'member reads messages in their server channel');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = '66666666-0000-0000-0000-000000000006'), 0,
          'non-member reads no messages from that channel');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = '66666666-0000-0000-0000-000000000006'), 0,
          'banned member reads no messages from that channel');

-- Direct messages ------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE conversation_id = '77777777-0000-0000-0000-000000000007'), 1,
          'participant reads their DM');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE conversation_id = '77777777-0000-0000-0000-000000000007'), 1,
          'the other participant reads the same DM');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE conversation_id = '77777777-0000-0000-0000-000000000007'), 0,
          'non-participant reads no DM');

-- The helpers policies depend on. A revoke that breaks one of these takes the
-- whole session down, so each is asserted callable as `authenticated`.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_current_profile_id(), '11111111-0000-0000-0000-000000000001'::uuid,
          'get_current_profile_id resolves for an authenticated caller');
SELECT is(public.current_user_is_member_of_server('55555555-0000-0000-0000-000000000005'), true,
          'current_user_is_member_of_server is callable and true for a member');
SELECT is(public.is_conversation_participant('77777777-0000-0000-0000-000000000007',
                                             '11111111-0000-0000-0000-000000000001'), true,
          'is_conversation_participant is callable and true for a participant');
SELECT lives_ok($$ SELECT public.is_current_user_admin() $$,
                'is_current_user_admin is callable by authenticated');

-- Anon sees nothing ----------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM public.messages), 0,
          'anon reads no messages at all');
SELECT is((SELECT count(*)::int FROM public.conversations), 0,
          'anon reads no conversations at all');

SELECT * FROM finish();
ROLLBACK;
