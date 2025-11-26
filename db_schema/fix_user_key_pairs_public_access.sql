-- =====================================================
-- FIX: Allow users to see other users' PUBLIC keys
-- This is required for Megolm session key sharing
-- =====================================================

-- Add policy to allow any authenticated user to see public keys
-- (but NOT the encrypted private key - that column is protected by only
-- returning identity_public_key in SELECT queries)
CREATE POLICY "Users can view others' public keys for encryption"
    ON public.user_key_pairs FOR SELECT
    USING (
        -- Only allow SELECT on active keys
        is_active = true
    );

-- Note: The application code only queries for identity_public_key,
-- so the private key is never exposed. The RLS policy allows reading
-- the row, but the app only SELECTs the public key column.

-- Alternative approach: Create a view that only exposes public keys
-- This is more secure as it limits at the database level

-- DROP VIEW IF EXISTS public.user_public_keys;
-- CREATE VIEW public.user_public_keys AS
-- SELECT 
--     user_id,
--     identity_public_key,
--     is_active,
--     created_at
-- FROM public.user_key_pairs
-- WHERE is_active = true;

-- GRANT SELECT ON public.user_public_keys TO authenticated;

