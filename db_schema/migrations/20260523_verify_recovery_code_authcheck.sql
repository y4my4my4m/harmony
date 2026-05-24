-- ---------------------------------------------------------------------------
-- Bind `verify_recovery_code` to the calling user (BUGS.md H49).
--
-- BACKGROUND
-- ----------
-- The pre-existing `verify_recovery_code(p_user_id uuid, p_code text)`
-- function trusted whatever UUID the caller supplied. Combined with
-- `SECURITY DEFINER` it bypassed the row-level lock on `mfa_recovery_codes`,
-- meaning *any authenticated user* could call:
--
--     supabase.rpc('verify_recovery_code', { p_user_id: '<victim>', p_code: 'XXXXXXXX' })
--
-- and atomically burn one of the victim's recovery codes (the UPDATE that
-- marks `used_at = NOW()` is unconditional once the hash matches). Even
-- without knowing a code, a brute-force grinder could exhaust the 10
-- codes by spraying random 8-character strings - the function returns
-- whether the call hit, so it's a usable oracle.
--
-- This migration adds two `auth.uid()` guards at the top of the function:
--   1. Reject anon callers (no JWT).
--   2. Reject callers whose JWT subject differs from `p_user_id`.
--
-- All in-tree callers (`AuthComponent.handle2FAVerification`,
-- `ResetPasswordView.handleMFAVerification`, and the new
-- `PrivacySettings.disable2FA` flow) already pass their own
-- `session.user.id`, so legitimate flows are unaffected.
--
-- ROLLOUT
-- -------
-- Idempotent. `CREATE OR REPLACE FUNCTION` updates the existing function
-- in place. Wrapped in BEGIN/COMMIT so a partial failure rolls back.
-- Paste into the Supabase SQL editor and click Run.
--
-- Mirror change in `db_schema/init/13_functions_rpc_extended.sql` so
-- fresh installs get the hardened version.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION public.verify_recovery_code(p_user_id uuid, p_code text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
  AS $$
DECLARE
  v_code_hash TEXT;
  v_code_id UUID;
BEGIN
  -- Reject calls from the anon role (no JWT → no caller identity to bind).
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: verify_recovery_code requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  -- Reject calls where the caller is trying to verify someone *else's*
  -- recovery code. `IS DISTINCT FROM` treats two NULLs as equal, but the
  -- guard above already rejects auth.uid() = NULL, so this only ever
  -- compares two non-null UUIDs.
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: cannot verify recovery codes for another user'
      USING ERRCODE = '42501';
  END IF;

  -- Hash the provided code (using SHA-256)
  v_code_hash := encode(extensions.digest(p_code::bytea, 'sha256'), 'hex');

  -- Find an unused recovery code matching the hash
  SELECT id INTO v_code_id
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND code_hash = v_code_hash
    AND used_at IS NULL
  LIMIT 1;

  IF v_code_id IS NOT NULL THEN
    -- Mark the code as used
    UPDATE public.mfa_recovery_codes
    SET used_at = NOW()
    WHERE id = v_code_id;

    RETURN TRUE;
  ELSE
    RETURN FALSE;
  END IF;
END;
$$;

COMMIT;
