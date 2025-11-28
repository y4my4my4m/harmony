-- ============================================================================
-- CLEANUP: Remove Legacy Edge Function Triggers & Database Federation
-- 
-- These triggers are deprecated. The federation-backend (Node.js) now
-- handles ALL federation via realtime listeners:
--   - Posts: DatabaseListener listens to 'posts' table
--   - DMs: DatabaseListener listens to 'messages' table
--   - Likes/Reblogs/Follows: DatabaseListener handles these
-- 
-- This migration removes:
-- 1. Legacy edge function trigger for federation_delivery_queue
-- 2. DM federation trigger (now handled by backend)
-- ============================================================================

-- 1. Drop the legacy edge function trigger for federation delivery
DROP TRIGGER IF EXISTS "Federated Outbox" ON public.federation_delivery_queue;

-- 2. Drop the DM federation trigger - backend now handles this directly
-- The handle_outgoing_messages function was federating DMs via the queue,
-- but now the federation-backend listens to the messages table directly
DROP TRIGGER IF EXISTS trg_handle_outgoing_messages ON public.messages;

-- Note: We keep handle_message_federation trigger - it handles LOCAL notifications only
-- The federation part is now in the backend via handleNewDM()

-- Add comments explaining the new architecture
COMMENT ON TABLE public.federation_delivery_queue IS 
'Queue for ActivityPub federation deliveries. 
DEPRECATED: This table is no longer actively used for new federation.
The federation-backend now handles delivery directly via DatabaseListener.
Kept for historical records and potential retry mechanisms.';

COMMENT ON TRIGGER trg_handle_message_federation ON public.messages IS 
'Handles LOCAL notifications for all messages (DMs, mentions).
Federation is handled separately by the Node.js backend listening to this table.';

