-- =============================================================================
-- Migration: Generic `broadcast_user_event` RPC for the federation backend.
-- =============================================================================
-- The BullMQ post handler (federation-backend/src/queue/handlers/postHandler.ts)
-- needs to push `home_feed:new_post` events to the author + every accepted local
-- follower on each post create. There is no existing generic helper that wraps
-- `realtime.send(..., 'user_event', 'user:<uuid>', true)`; every current caller
-- (broadcast_post_event, broadcast_follow_event, send_notification_to_user,
-- etc.) hardcodes the topic inline. Adding a tiny SECURITY DEFINER wrapper
-- lets Node workers reuse the existing `user:{profile_id}` broadcast topic
-- through the service-role Supabase client without having to grant direct
-- INSERT on `realtime.messages` or invent a new channel per recipient.
--
-- Realtime architecture compliance (.cursor/rules/realtime-architecture.mdc):
--   * reuses the existing `user:{profile_id}` topic + `user_event` event name
--   * payload `type` field discriminates handlers on the frontend
--   * no new Supabase channel is opened on the frontend
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.broadcast_user_event(
  p_user_id uuid,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_payload IS NULL THEN
    RETURN;
  END IF;

  PERFORM realtime.send(
    p_payload,
    'user_event',
    'user:' || p_user_id::text,
    true
  );
EXCEPTION WHEN OTHERS THEN
  -- A broadcast failure must not poison the caller (federation worker, RPC
  -- consumer, etc.); the source-of-truth row is always already persisted
  -- and the realtime push is a UX nicety on top.
  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.broadcast_user_event(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.broadcast_user_event(uuid, jsonb) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
