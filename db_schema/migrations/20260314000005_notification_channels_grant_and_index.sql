BEGIN;

-- Grant table-level privileges so PostgREST can access notification_channels
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_channels TO authenticated;

-- Partial unique index for channel-specific mute (conversation_id is NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_channel
  ON public.notification_channels (user_id, channel_id)
  WHERE channel_id IS NOT NULL AND conversation_id IS NULL;

-- Partial unique index for conversation-specific mute (channel_id is NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_conversation
  ON public.notification_channels (user_id, conversation_id)
  WHERE conversation_id IS NOT NULL AND channel_id IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
