BEGIN;

-- =============================================================================
-- Add missing RLS policies for channel_categories
-- =============================================================================
-- The init schema enabled RLS on channel_categories but had NO policies,
-- causing PostgREST queries to return zero rows - channels invisible in UI.
-- =============================================================================

ALTER TABLE public.channel_categories ENABLE ROW LEVEL SECURITY;

-- Clean up any existing policies (production has some FIXME policies)
DROP POLICY IF EXISTS "Enable read access for all users" ON public.channel_categories;
DROP POLICY IF EXISTS "FIXME: Server owners can insert/update/delete" ON public.channel_categories;
DROP POLICY IF EXISTS "channel_categories_update_policy" ON public.channel_categories;
DROP POLICY IF EXISTS "channel_categories_select" ON public.channel_categories;
DROP POLICY IF EXISTS "channel_categories_insert" ON public.channel_categories;
DROP POLICY IF EXISTS "channel_categories_update" ON public.channel_categories;
DROP POLICY IF EXISTS "channel_categories_delete" ON public.channel_categories;

CREATE POLICY "channel_categories_select" ON public.channel_categories
    FOR SELECT USING (true);

CREATE POLICY "channel_categories_insert" ON public.channel_categories
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channel_categories.server_id
            AND owner = public.get_current_profile_id()
        )
    );

CREATE POLICY "channel_categories_update" ON public.channel_categories
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = channel_categories.server_id
            AND us.user_id = public.get_current_profile_id()
        )
    );

CREATE POLICY "channel_categories_delete" ON public.channel_categories
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channel_categories.server_id
            AND owner = public.get_current_profile_id()
        )
    );

COMMIT;
