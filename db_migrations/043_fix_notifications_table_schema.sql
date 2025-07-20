-- Migration 043: Fix Notifications Table Schema
-- Issue: send_notification() function expects columns that don't exist in notifications table
-- This causes ActivityPub processing to fail when creating notifications

BEGIN;

-- Add missing columns to notifications table
ALTER TABLE public.notifications 
ADD COLUMN IF NOT EXISTS server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS from_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS priority character varying(20) DEFAULT 'normal';

-- Add indexes for performance on the new foreign key columns
CREATE INDEX IF NOT EXISTS idx_notifications_server_id ON notifications(server_id);
CREATE INDEX IF NOT EXISTS idx_notifications_channel_id ON notifications(channel_id);
CREATE INDEX IF NOT EXISTS idx_notifications_conversation_id ON notifications(conversation_id);
CREATE INDEX IF NOT EXISTS idx_notifications_from_user_id ON notifications(from_user_id);

-- Update comments
COMMENT ON COLUMN notifications.server_id IS 'Server where the notification originated (for channel/server notifications)';
COMMENT ON COLUMN notifications.channel_id IS 'Channel where the notification originated';
COMMENT ON COLUMN notifications.conversation_id IS 'Conversation where the notification originated (for DMs)';
COMMENT ON COLUMN notifications.from_user_id IS 'User who triggered the notification';
COMMENT ON COLUMN notifications.priority IS 'Notification priority: low, normal, high, urgent';

-- Verify the schema now matches what send_notification expects
DO $$
DECLARE
    missing_columns text[];
    col_name text;
BEGIN
    -- Check for expected columns
    missing_columns := ARRAY[]::text[];
    
    FOREACH col_name IN ARRAY ARRAY['server_id', 'channel_id', 'conversation_id', 'from_user_id', 'priority']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'notifications' 
            AND column_name = col_name
            AND table_schema = 'public'
        ) THEN
            missing_columns := array_append(missing_columns, col_name);
        END IF;
    END LOOP;
    
    IF array_length(missing_columns, 1) > 0 THEN
        RAISE EXCEPTION 'Still missing columns in notifications table: %', array_to_string(missing_columns, ', ');
    ELSE
        RAISE NOTICE '✅ Notifications table schema now matches send_notification() function expectations';
    END IF;
END $$;

COMMIT;