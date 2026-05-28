BEGIN;

-- Fix: Allow any active conversation participant to toggle encryption,
-- not just the conversation creator.
DROP POLICY IF EXISTS "conversation_encryption_settings_modify" ON public.conversation_encryption_settings;
CREATE POLICY "conversation_encryption_settings_modify" ON public.conversation_encryption_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = conversation_encryption_settings.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        )
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
