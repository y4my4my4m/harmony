-- Fix RLS policies for megolm_session_shares table
-- The issue is that upsert requires both INSERT and UPDATE, but UPDATE was only for recipients

-- Drop existing policies
DROP POLICY IF EXISTS "Recipients can view their session shares" ON public.megolm_session_shares;
DROP POLICY IF EXISTS "Recipients can claim their session shares" ON public.megolm_session_shares;
DROP POLICY IF EXISTS "Senders can create session shares" ON public.megolm_session_shares;

-- Create comprehensive policies

-- SELECT: Both senders and recipients can view shares
CREATE POLICY "Users can view their session shares"
    ON public.megolm_session_shares FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.auth_user_id = auth.uid()
            AND (
                profiles.id = megolm_session_shares.recipient_user_id
                OR profiles.id = megolm_session_shares.sender_user_id
            )
        )
    );

-- INSERT: Senders can create shares
CREATE POLICY "Senders can create session shares"
    ON public.megolm_session_shares FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_session_shares.sender_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- UPDATE: Both senders (for upsert) and recipients (for claiming) can update
CREATE POLICY "Users can update session shares"
    ON public.megolm_session_shares FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.auth_user_id = auth.uid()
            AND (
                -- Recipients can claim their shares
                profiles.id = megolm_session_shares.recipient_user_id
                -- Senders can update their shares (for upsert)
                OR profiles.id = megolm_session_shares.sender_user_id
            )
        )
    );

-- DELETE: Senders can delete their shares
CREATE POLICY "Senders can delete their session shares"
    ON public.megolm_session_shares FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_session_shares.sender_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Ensure grants are in place
GRANT SELECT, INSERT, UPDATE, DELETE ON public.megolm_session_shares TO authenticated;

