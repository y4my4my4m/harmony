BEGIN;

-- Change notification_preferences defaults so all notification types are ON for new users.
-- Also update existing users who still have the old false defaults.

-- 1. Alter column defaults
ALTER TABLE notification_preferences
  ALTER COLUMN desktop_reactions SET DEFAULT true,
  ALTER COLUMN sound_reactions SET DEFAULT true,
  ALTER COLUMN activitypub_desktop_favorites SET DEFAULT true,
  ALTER COLUMN activitypub_desktop_reblogs SET DEFAULT true;

-- Also fix sound variants added by earlier migration (20260312)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'notification_preferences'
             AND column_name = 'activitypub_sound_favorites') THEN
    EXECUTE 'ALTER TABLE notification_preferences ALTER COLUMN activitypub_sound_favorites SET DEFAULT true';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'notification_preferences'
             AND column_name = 'activitypub_sound_reblogs') THEN
    EXECUTE 'ALTER TABLE notification_preferences ALTER COLUMN activitypub_sound_reblogs SET DEFAULT true';
  END IF;
END $$;

-- 2. Update existing users who have the old false defaults to true,
-- but only if they haven't explicitly changed them (we assume false = never changed from default)
UPDATE notification_preferences
SET desktop_reactions = true
WHERE desktop_reactions = false;

UPDATE notification_preferences
SET sound_reactions = true
WHERE sound_reactions = false;

UPDATE notification_preferences
SET activitypub_desktop_favorites = true
WHERE activitypub_desktop_favorites = false;

UPDATE notification_preferences
SET activitypub_desktop_reblogs = true
WHERE activitypub_desktop_reblogs = false;

-- Update sound variants if columns exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'notification_preferences'
             AND column_name = 'activitypub_sound_favorites') THEN
    EXECUTE 'UPDATE notification_preferences SET activitypub_sound_favorites = true WHERE activitypub_sound_favorites = false';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'notification_preferences'
             AND column_name = 'activitypub_sound_reblogs') THEN
    EXECUTE 'UPDATE notification_preferences SET activitypub_sound_reblogs = true WHERE activitypub_sound_reblogs = false';
  END IF;
END $$;

COMMIT;
