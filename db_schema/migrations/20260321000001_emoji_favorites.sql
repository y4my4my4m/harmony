BEGIN;

-- Emoji favorites table
CREATE TABLE IF NOT EXISTS public.emoji_favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    emoji_id text NOT NULL,
    emoji_name text NOT NULL,
    emoji_url text,
    emoji_server_id uuid,
    created_at timestamp with time zone DEFAULT now(),

    UNIQUE(user_id, emoji_id)
);

CREATE INDEX IF NOT EXISTS idx_emoji_favorites_user ON public.emoji_favorites(user_id);

ALTER TABLE public.emoji_favorites ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS "Users can view own emoji favorites" ON public.emoji_favorites;
CREATE POLICY "Users can view own emoji favorites" ON public.emoji_favorites
    FOR SELECT USING (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can insert own emoji favorites" ON public.emoji_favorites;
CREATE POLICY "Users can insert own emoji favorites" ON public.emoji_favorites
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can delete own emoji favorites" ON public.emoji_favorites;
CREATE POLICY "Users can delete own emoji favorites" ON public.emoji_favorites
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- Table-level privileges for PostgREST access
GRANT SELECT, INSERT, DELETE ON public.emoji_favorites TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
