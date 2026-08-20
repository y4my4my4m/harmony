BEGIN;

-- The emoji_favorites table was created with RLS policies but without
-- GRANT privileges for the authenticated role, causing 42501 errors
-- on all REST API access.
GRANT SELECT, INSERT, DELETE ON public.emoji_favorites TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
