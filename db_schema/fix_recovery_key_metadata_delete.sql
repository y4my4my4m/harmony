-- Fix: Allow users to delete their own recovery_key_metadata
-- The original schema only granted SELECT, INSERT, UPDATE but not DELETE

-- Grant DELETE permission
GRANT DELETE ON public.recovery_key_metadata TO authenticated;

-- Also ensure the RLS policy allows delete (the FOR ALL should cover it, but let's be explicit)
DROP POLICY IF EXISTS "Users can manage their own recovery metadata" ON public.recovery_key_metadata;

CREATE POLICY "Users can manage their own recovery metadata"
    ON public.recovery_key_metadata FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = recovery_key_metadata.user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Also add DELETE for other tables that might need it
GRANT DELETE ON public.megolm_key_requests TO authenticated;
GRANT DELETE ON public.megolm_room_sessions TO authenticated;
GRANT DELETE ON public.megolm_session_shares TO authenticated;

