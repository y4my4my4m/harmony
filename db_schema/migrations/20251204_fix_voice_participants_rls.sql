-- Fix RLS policies for voice_channel_participants table
-- The previous "FOR ALL" policy may not work correctly for INSERT operations

-- Drop existing policies
DROP POLICY IF EXISTS "View voice participants in servers you're a member of" ON public.voice_channel_participants;
DROP POLICY IF EXISTS "Manage own voice participation" ON public.voice_channel_participants;
DROP POLICY IF EXISTS "Service role full access" ON public.voice_channel_participants;

-- Recreate with explicit policies for each operation

-- SELECT: Users can see participants in servers they're members of
CREATE POLICY "Select voice participants"
    ON public.voice_channel_participants FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = voice_channel_participants.server_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- INSERT: Users can insert their own participation
CREATE POLICY "Insert own voice participation"
    ON public.voice_channel_participants FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

-- UPDATE: Users can update their own participation
CREATE POLICY "Update own voice participation"
    ON public.voice_channel_participants FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- DELETE: Users can delete their own participation
CREATE POLICY "Delete own voice participation"
    ON public.voice_channel_participants FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

-- Service role can do everything (for federation backend)
CREATE POLICY "Service role full access"
    ON public.voice_channel_participants FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant usage to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_channel_participants TO authenticated;
GRANT ALL ON public.voice_channel_participants TO service_role;

