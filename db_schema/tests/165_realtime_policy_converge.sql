-- 20261025100001_realtime_policy_converge.sql: realtime.messages carries the receive, send and
-- session AAL policies after the chain, as the private channels require.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

SELECT policies_are('realtime', 'messages',
    ARRAY['authenticated_users_can_receive', 'authenticated_users_can_send', 'realtime_messages_session_aal'],
    'realtime.messages has exactly the receive, send and AAL policies');
SELECT policy_cmd_is('realtime', 'messages', 'authenticated_users_can_receive', 'SELECT',
    'receive is the SELECT policy');
SELECT policy_cmd_is('realtime', 'messages', 'authenticated_users_can_send', 'INSERT',
    'send is the INSERT policy');
SELECT policy_cmd_is('realtime', 'messages', 'realtime_messages_session_aal', 'ALL',
    'the AAL policy covers every command');
SELECT is(
    (SELECT polpermissive FROM pg_policy
      WHERE polrelid = 'realtime.messages'::regclass AND polname = 'realtime_messages_session_aal'),
    false,
    'the AAL policy is restrictive');

SELECT * FROM finish();
ROLLBACK;
