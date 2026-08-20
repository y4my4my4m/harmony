BEGIN;

-- ============================================================================
-- Add RLS policies on realtime.messages for private broadcast channels.
--
-- Private channels (config: { private: true }) require authenticated users
-- to have SELECT and INSERT permissions on realtime.messages. Without these
-- policies, RLS silently blocks all private channel subscriptions and
-- server-side realtime.send(..., true) calls fail.
--
-- See: https://supabase.com/docs/guides/realtime/authorization
-- ============================================================================

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_users_can_receive" ON realtime.messages;
CREATE POLICY "authenticated_users_can_receive" ON realtime.messages
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages;
CREATE POLICY "authenticated_users_can_send" ON realtime.messages
  FOR INSERT TO authenticated WITH CHECK (true);

COMMIT;
