-- ============================================================================
-- C11 / Pattern C fix: recovery-code login must not rely on the CLIENT to
-- disable MFA after a client-side code check.
--
-- Before: AuthComponent.vue called verify_recovery_code() and then
-- supabase.auth.mfa.unenroll() from an AAL1 session. The unenroll was the
-- security boundary, but it ran client-side on an AAL1 session - anyone with
-- just the password could attempt it, and the recovery-code check was merely
-- advisory.
--
-- After: this RPC is the single, atomic boundary. It verifies AND consumes a
-- recovery code for the calling user, and only on success removes the user's
-- MFA factors server-side. No factor is removed unless a valid, unused
-- recovery code was burned in the same transaction.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.redeem_recovery_code_and_disable_mfa(p_code text)
RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_user_id uuid;
  v_profile_id uuid;
  v_code_hash text;
  v_code_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  IF p_code IS NULL OR length(p_code) < 8 THEN
    RETURN false;
  END IF;

  -- mfa_recovery_codes.user_id FKs to profiles(id); save_recovery_codes
  -- writes rows under the PROFILE id, so the lookup must too (Pattern A).
  v_profile_id := public.get_current_profile_id();
  IF v_profile_id IS NULL THEN
    RETURN false;
  END IF;

  v_code_hash := encode(extensions.digest(p_code::bytea, 'sha256'), 'hex');

  -- Verify and consume atomically: the row lock from UPDATE ... RETURNING
  -- prevents the same code being redeemed twice concurrently.
  UPDATE public.mfa_recovery_codes
  SET used_at = NOW()
  WHERE id = (
    SELECT id FROM public.mfa_recovery_codes
    WHERE user_id = v_profile_id
      AND code_hash = v_code_hash
      AND used_at IS NULL
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id INTO v_code_id;

  IF v_code_id IS NULL THEN
    RETURN false;
  END IF;

  -- Code burned - now (and only now) remove the user's MFA factors so they
  -- can sign in and re-enroll. Server-side: an AAL1 attacker without a valid
  -- recovery code can never reach this statement.
  DELETE FROM auth.mfa_factors WHERE user_id = v_user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_recovery_code_and_disable_mfa(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_recovery_code_and_disable_mfa(text) TO authenticated;

COMMIT;
