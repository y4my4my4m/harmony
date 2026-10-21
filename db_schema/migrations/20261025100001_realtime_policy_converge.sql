-- Realtime's private-channel policies on realtime.messages, created where missing as the latest
-- migrations define them:
--   authenticated_users_can_receive  SELECT  (20260101000000_baseline)
--   authenticated_users_can_send     INSERT  (20261006800001_private_call_channels)
--   realtime_messages_session_aal    RESTRICTIVE ALL  (20261005400001_account_security)
--
-- Each of those blocks skips when realtime.messages does not exist yet. On a self-host install
-- whose Realtime container created its schema while bootstrap.sh applied the chain, the receive
-- and AAL policies were skipped and the migrations recorded as applied: RLS on with no SELECT
-- policy refuses every private channel (user:, server-presence:, dm-calls:).
--
-- Present policies are left alone: CREATE POLICY takes an ACCESS EXCLUSIVE lock on the hot,
-- partitioned table, and lock_timeout keeps a long transaction from stalling realtime.send.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    v_table regclass := to_regclass('realtime.messages');
BEGIN
    IF v_table IS NULL THEN
        RAISE NOTICE 'realtime.messages absent, realtime policies skipped';
        RETURN;
    END IF;

    GRANT SELECT, INSERT ON realtime.messages TO authenticated;

    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_table AND polname = 'authenticated_users_can_receive') THEN
        CREATE POLICY "authenticated_users_can_receive" ON realtime.messages
            FOR SELECT TO authenticated
            USING (public.can_subscribe_to_topic(topic));
        RAISE NOTICE 'realtime.messages receive policy installed';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_table AND polname = 'authenticated_users_can_send') THEN
        CREATE POLICY "authenticated_users_can_send" ON realtime.messages
            FOR INSERT TO authenticated
            WITH CHECK (public.can_send_to_topic(topic));
        RAISE NOTICE 'realtime.messages send policy installed';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_table AND polname = 'realtime_messages_session_aal') THEN
        CREATE POLICY realtime_messages_session_aal ON realtime.messages
            AS RESTRICTIVE FOR ALL TO authenticated
            USING ((SELECT public.session_meets_aal()))
            WITH CHECK ((SELECT public.session_meets_aal()));
        RAISE NOTICE 'realtime.messages aal policy installed';
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'realtime.messages policies skipped: %', SQLERRM;
END;
$$;

COMMIT;
