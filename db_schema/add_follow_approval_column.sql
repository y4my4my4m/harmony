-- Add ActivityPub standard follow approval column

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS manually_approves_followers BOOLEAN DEFAULT false;

COMMENT ON COLUMN profiles.manually_approves_followers IS 
'ActivityPub standard: If true, follows require approval. If false, auto-accept.';

-- Create index for querying
CREATE INDEX IF NOT EXISTS idx_profiles_manually_approves 
  ON profiles(manually_approves_followers) 
  WHERE manually_approves_followers = true;

-- Verification
DO $$
BEGIN
  RAISE NOTICE '✅ Added manually_approves_followers column';
  RAISE NOTICE '   - Default: false (auto-accept follows)';
  RAISE NOTICE '   - Users can enable in profile settings';
  RAISE NOTICE '   - ActivityPub compliant!';
END $$;

