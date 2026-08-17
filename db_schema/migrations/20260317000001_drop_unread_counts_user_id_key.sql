-- Drop the legacy unique constraint on user_id in unread_counts.
-- The table design allows multiple rows per user (one per channel/conversation).
-- This constraint can exist on DBs that were created before the per-channel design.
--
-- Triggers like handle_new_message_unread use ON CONFLICT (user_id, channel_id),
-- which requires multiple rows per user. The old unique(user_id) constraint
-- caused 23505 duplicate key errors when replying to own messages in threads.
BEGIN;

DO $$
BEGIN
    ALTER TABLE public.unread_counts DROP CONSTRAINT IF EXISTS unread_counts_user_id_key;
EXCEPTION
    WHEN undefined_object THEN NULL; -- Constraint didn't exist
END $$;

COMMIT;
