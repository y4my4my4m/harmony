-- Add ActivityPub notification preferences to notification_preferences table
-- Migration to add ActivityPub notification settings

-- Add ActivityPub notification columns
ALTER TABLE notification_preferences
ADD COLUMN IF NOT EXISTS activitypub_notifications BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_follows BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_favorites BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_reblogs BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_mentions BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_replies BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_follow_requests BOOLEAN DEFAULT TRUE,

-- Add ActivityPub desktop notification columns
ADD COLUMN IF NOT EXISTS activitypub_desktop_notifications BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_desktop_follows BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_desktop_favorites BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS activitypub_desktop_reblogs BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS activitypub_desktop_mentions BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_desktop_replies BOOLEAN DEFAULT TRUE,

-- Add ActivityPub sound notification columns
ADD COLUMN IF NOT EXISTS activitypub_sound_notifications BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_sound_follows BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_sound_favorites BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS activitypub_sound_reblogs BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS activitypub_sound_mentions BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS activitypub_sound_replies BOOLEAN DEFAULT TRUE;

-- Update the updated_at column timestamp
UPDATE notification_preferences 
SET updated_at = NOW()
WHERE updated_at IS NOT NULL;

-- Create default preferences for existing users who might not have ActivityPub preferences
INSERT INTO notification_preferences (
    user_id, 
    activitypub_notifications,
    activitypub_follows,
    activitypub_favorites,
    activitypub_reblogs,
    activitypub_mentions,
    activitypub_replies,
    activitypub_follow_requests,
    activitypub_desktop_notifications,
    activitypub_desktop_follows,
    activitypub_desktop_favorites,
    activitypub_desktop_reblogs,
    activitypub_desktop_mentions,
    activitypub_desktop_replies,
    activitypub_sound_notifications,
    activitypub_sound_follows,
    activitypub_sound_favorites,
    activitypub_sound_reblogs,
    activitypub_sound_mentions,
    activitypub_sound_replies
)
SELECT 
    p.id,
    TRUE,  -- activitypub_notifications
    TRUE,  -- activitypub_follows
    TRUE,  -- activitypub_favorites
    TRUE,  -- activitypub_reblogs
    TRUE,  -- activitypub_mentions
    TRUE,  -- activitypub_replies
    TRUE,  -- activitypub_follow_requests
    TRUE,  -- activitypub_desktop_notifications
    TRUE,  -- activitypub_desktop_follows
    FALSE, -- activitypub_desktop_favorites
    FALSE, -- activitypub_desktop_reblogs
    TRUE,  -- activitypub_desktop_mentions
    TRUE,  -- activitypub_desktop_replies
    TRUE,  -- activitypub_sound_notifications
    TRUE,  -- activitypub_sound_follows
    FALSE, -- activitypub_sound_favorites
    FALSE, -- activitypub_sound_reblogs
    TRUE,  -- activitypub_sound_mentions
    TRUE   -- activitypub_sound_replies
FROM profiles p
WHERE NOT EXISTS (
    SELECT 1 FROM notification_preferences np 
    WHERE np.user_id = p.id
);

-- Add comment for documentation
COMMENT ON COLUMN notification_preferences.activitypub_notifications IS 'Master toggle for all ActivityPub notifications';
COMMENT ON COLUMN notification_preferences.activitypub_follows IS 'Enable notifications for new followers';
COMMENT ON COLUMN notification_preferences.activitypub_favorites IS 'Enable notifications for favorites/likes';
COMMENT ON COLUMN notification_preferences.activitypub_reblogs IS 'Enable notifications for reblogs/boosts';
COMMENT ON COLUMN notification_preferences.activitypub_mentions IS 'Enable notifications for mentions';
COMMENT ON COLUMN notification_preferences.activitypub_replies IS 'Enable notifications for replies';
COMMENT ON COLUMN notification_preferences.activitypub_follow_requests IS 'Enable notifications for follow requests';
COMMENT ON COLUMN notification_preferences.activitypub_desktop_notifications IS 'Master toggle for ActivityPub desktop notifications';
COMMENT ON COLUMN notification_preferences.activitypub_sound_notifications IS 'Master toggle for ActivityPub sound notifications';