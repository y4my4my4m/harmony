-- ============================================================================
-- FEDERATED REACTIONS: Allow reactions from remote/federated users
-- 
-- Problem: reactions.user_id FK points to auth.users(id), but remote users
-- only exist in profiles (they don't have auth.users entries).
-- 
-- Solution: Change the FK to point to profiles(id) instead of auth.users(id)
-- This works because:
--   - Local users: profiles.id = auth.users.id (same UUID)
--   - Remote users: profiles.id exists (different UUID, no auth.users entry)
-- ============================================================================

-- 1. Drop the existing FK constraint
ALTER TABLE public.reactions 
DROP CONSTRAINT IF EXISTS reactions_user_id_fkey;

-- 2. Add new FK constraint pointing to profiles(id)
ALTER TABLE public.reactions
ADD CONSTRAINT reactions_user_id_fkey 
FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 3. Add an index for federated reactions lookup (by profile_id + message_id)
CREATE INDEX IF NOT EXISTS idx_reactions_user_message 
ON public.reactions(user_id, message_id);

-- 4. Add comment explaining the change
COMMENT ON COLUMN public.reactions.user_id IS 
'References profiles.id (not auth.users.id). This allows reactions from both local users (where profiles.id = auth.users.id) and federated/remote users (who only have profiles entries).';

-- 5. Grant service_role access for federation backend
GRANT ALL ON public.reactions TO service_role;

