-- ---------------------------------------------------------------------------
-- Restrict access to the encrypted-private-key columns of
-- `public.user_key_pairs`.
--
-- Why:
-- The current SELECT policy on `user_key_pairs` is row-wide
--   USING (is_active = true)
-- and PostgreSQL RLS cannot hide columns. That means every authenticated
-- user can read the wrapped private key material of every other user via
--   SELECT identity_private_key_encrypted,
--          identity_signing_private_key_encrypted
--   FROM   user_key_pairs WHERE is_active = true;
-- Megolm wraps the bytes with AES-GCM under a recovery-derived key, but
-- the ciphertext is still harvestable for offline brute force, and the
-- legacy Signal setup path writes the private key *unwrapped*
-- (see BUGS.md item C6). Either way, broadcasting the column to everyone
-- is unnecessary.
--
-- Fix:
--   1. Drop the broad row policy.
--   2. Add an owner-only SELECT policy (full row access for the owner).
--   3. Use column-level GRANTs so other authenticated users can read ONLY
--      the public columns. PostgreSQL evaluates column privileges before
--      RLS, so a non-owner who tries to project a private column will get
--      `permission denied for table user_key_pairs` rather than a row.
--   4. Provide a SECURITY DEFINER RPC `get_my_key_pair()` for the owner
--      to retrieve their wrapped private columns (used during unlock and
--      signing-key restoration).
--
-- Client follow-up (see same-day commit):
--   - `MegolmMessageEncryptionService.ensureIdentityKeyPair` / `ensureSigningKeyPair`
--     replace `from('user_key_pairs').select('identity_private_key_encrypted, ...')`
--     with `rpc('get_my_key_pair')`.
--   - Other-user public-key lookups (`identity_public_key`,
--     `identity_signing_public_key`) keep working unchanged via column GRANTs.
--
-- Idempotency: DROP POLICY / CREATE OR REPLACE / DROP-then-GRANT are safe
-- to re-run.
--
-- Ordering note: this filename sorts BEFORE
-- `20260520_user_key_pairs_signing_keys.sql` ("r" < "s"). To stay safe when
-- migrations are applied in lexicographic order, the signing-key columns
-- are also added here defensively. The companion migration's
-- ADD COLUMN IF NOT EXISTS is a no-op on the second pass.
-- ---------------------------------------------------------------------------
BEGIN;

-- 0. Ensure the columns referenced by the policies / RPC exist. If
-- `20260520_user_key_pairs_signing_keys.sql` has already run, these are
-- no-ops; otherwise we add them with the same definitions so the RPC's
-- RETURNS TABLE signature compiles.
ALTER TABLE public.user_key_pairs
    ADD COLUMN IF NOT EXISTS identity_signing_public_key text;
ALTER TABLE public.user_key_pairs
    ADD COLUMN IF NOT EXISTS identity_signing_private_key_encrypted text;

-- 1. Drop the row-wide public SELECT policy.
DROP POLICY IF EXISTS "Users can view others' public keys for encryption" ON public.user_key_pairs;

-- 2. Owner-only SELECT - full row, including encrypted private columns.
DROP POLICY IF EXISTS "Users can view own key pair (full row)" ON public.user_key_pairs;
CREATE POLICY "Users can view own key pair (full row)" ON public.user_key_pairs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = user_key_pairs.user_id
              AND profiles.auth_user_id = auth.uid()
        )
    );

-- 3. Other-users SELECT - restricted to active rows; column GRANTs below
-- enforce the public-only column projection.
DROP POLICY IF EXISTS "Users can view active public key columns" ON public.user_key_pairs;
CREATE POLICY "Users can view active public key columns" ON public.user_key_pairs
    FOR SELECT
    USING (is_active = true);

-- 4. Replace broad SELECT GRANT with column-restricted GRANT.
REVOKE SELECT ON public.user_key_pairs FROM authenticated;
REVOKE SELECT ON public.user_key_pairs FROM anon;

GRANT SELECT (
    id,
    user_id,
    device_id,
    identity_public_key,
    identity_signing_public_key,
    key_version,
    is_active,
    created_at,
    last_used_at,
    expires_at,
    metadata
) ON public.user_key_pairs TO authenticated;

-- 5. SECURITY DEFINER RPC so the owner can still fetch the encrypted private
-- columns of their own row (needed during local unlock).
CREATE OR REPLACE FUNCTION public.get_my_key_pair()
RETURNS TABLE (
    id uuid,
    user_id uuid,
    device_id text,
    identity_public_key text,
    identity_private_key_encrypted text,
    identity_signing_public_key text,
    identity_signing_private_key_encrypted text,
    key_version integer,
    is_active boolean,
    created_at timestamptz,
    last_used_at timestamptz,
    expires_at timestamptz,
    metadata jsonb
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        ukp.id,
        ukp.user_id,
        ukp.device_id,
        ukp.identity_public_key,
        ukp.identity_private_key_encrypted,
        ukp.identity_signing_public_key,
        ukp.identity_signing_private_key_encrypted,
        ukp.key_version,
        ukp.is_active,
        ukp.created_at,
        ukp.last_used_at,
        ukp.expires_at,
        ukp.metadata
    FROM public.user_key_pairs ukp
    JOIN public.profiles p ON p.id = ukp.user_id
    WHERE p.auth_user_id = auth.uid()
      AND ukp.is_active = true
    ORDER BY ukp.created_at DESC
    LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_my_key_pair() IS
    'Returns the caller''s active user_key_pairs row including encrypted private columns. Used by clients during unlock/signing-key restoration. SECURITY DEFINER because the columns are not granted to the authenticated role.';

GRANT EXECUTE ON FUNCTION public.get_my_key_pair() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
