-- =============================================================================
-- Migration: Add activitypub_sound_* and related notification preference columns
-- =============================================================================
-- The frontend sends these columns but they were never added to init schema.
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
-- =============================================================================

BEGIN;

-- ActivityPub sound notification columns
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS activitypub_sound_notifications boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS activitypub_sound_follows boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS activitypub_sound_favorites boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS activitypub_sound_reblogs boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS activitypub_sound_mentions boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS activitypub_sound_replies boolean DEFAULT true;

-- Sound columns (may be missing on older deploys)
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS sound_replies boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS sound_notifications boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS sound_reactions boolean DEFAULT false;

-- Push/email master toggles (may be missing on older deploys)
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS push_notifications boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_offline_only boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_notifications boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_digest boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_digest_frequency character varying(20) DEFAULT 'weekly';

COMMENT ON COLUMN public.notification_preferences.activitypub_sound_notifications IS 'Master toggle for ActivityPub sound notifications';
COMMENT ON COLUMN public.notification_preferences.activitypub_sound_follows IS 'Sound for new follower notifications';
COMMENT ON COLUMN public.notification_preferences.activitypub_sound_favorites IS 'Sound for favorite/like notifications';
COMMENT ON COLUMN public.notification_preferences.activitypub_sound_reblogs IS 'Sound for reblog/boost notifications';
COMMENT ON COLUMN public.notification_preferences.activitypub_sound_mentions IS 'Sound for mention notifications';
COMMENT ON COLUMN public.notification_preferences.activitypub_sound_replies IS 'Sound for reply notifications';

COMMIT;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
