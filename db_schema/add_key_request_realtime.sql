-- =====================================================
-- ADD SENDER_USER_ID TO KEY REQUESTS
-- This enables the realtime key request/fulfillment flow
-- =====================================================

-- Add sender_user_id column (the user who has the session key)
ALTER TABLE public.megolm_key_requests 
ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Add requester_user_id column (rename user_id conceptually for clarity)
-- Keep user_id for backwards compatibility but add requester_user_id as alias
ALTER TABLE public.megolm_key_requests 
ADD COLUMN IF NOT EXISTS requester_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Migrate existing data: set requester_user_id = user_id where not set
UPDATE public.megolm_key_requests 
SET requester_user_id = user_id 
WHERE requester_user_id IS NULL;

-- Add index for sender lookups (for realtime subscription filtering)
CREATE INDEX IF NOT EXISTS idx_megolm_requests_sender 
ON public.megolm_key_requests(sender_user_id) 
WHERE status = 'pending';

-- Add index for requester lookups (for realtime subscription filtering)
CREATE INDEX IF NOT EXISTS idx_megolm_requests_requester_status 
ON public.megolm_key_requests(requester_user_id, status);

-- =====================================================
-- UPDATE RLS POLICIES
-- Senders need to see and fulfill requests for their sessions
-- =====================================================

-- Drop old policy
DROP POLICY IF EXISTS "Users can manage their own key requests" ON public.megolm_key_requests;

-- Create new policy: requesters can manage their requests
CREATE POLICY "Requesters can manage their key requests"
    ON public.megolm_key_requests FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_key_requests.requester_user_id
            AND profiles.auth_user_id = auth.uid()
        )
        OR
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_key_requests.user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Create policy: senders can view and fulfill requests for their sessions
CREATE POLICY "Senders can view and fulfill key requests"
    ON public.megolm_key_requests FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_key_requests.sender_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- =====================================================
-- ENABLE REALTIME FOR KEY REQUESTS TABLE
-- =====================================================

-- Enable realtime for this table (if not already enabled)
ALTER PUBLICATION supabase_realtime ADD TABLE public.megolm_key_requests;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON COLUMN public.megolm_key_requests.sender_user_id IS 'The user who sent the original message and has the session key';
COMMENT ON COLUMN public.megolm_key_requests.requester_user_id IS 'The user who is requesting the session key';

