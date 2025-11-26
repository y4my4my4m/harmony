-- =====================================================
-- FIX: Add INSERT permission for conversation_encryption_settings
-- This allows users to enable encryption on DM conversations
-- =====================================================

-- Add INSERT permission (was missing - only had SELECT, UPDATE)
GRANT INSERT ON public.conversation_encryption_settings TO authenticated;

-- Also add a policy to allow participants to INSERT
CREATE POLICY "Conversation participants can insert encryption settings"
    ON public.conversation_encryption_settings FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.conversation_participants
            JOIN public.profiles ON profiles.id = conversation_participants.user_id
            WHERE conversation_participants.conversation_id = conversation_encryption_settings.conversation_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

