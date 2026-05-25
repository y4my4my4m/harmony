-- Migration: Cross-device notification read state sync
-- Sets read_at when marking notifications as read, and updates the RPC function.
-- The read_at column already exists on the notifications table.

BEGIN;

-- Update mark_all_notifications_read to also set read_at
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE notifications 
    SET is_read = true, read_at = NOW(), updated_at = NOW()
    WHERE user_id = p_user_id AND is_read = false;
END;
$$;

-- Backfill read_at for already-read notifications that are missing it
UPDATE notifications
SET read_at = updated_at
WHERE is_read = true AND read_at IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
