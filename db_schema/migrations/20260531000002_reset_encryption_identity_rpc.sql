-- ---------------------------------------------------------------------------
-- reset_my_encryption_identity(): let a user fully wipe their own encryption
-- identity so they can re-set-up cleanly.
--
-- Why this is needed:
--   The client's resetEncryption() deleted recovery metadata, session shares
--   and backups, but NEVER deleted the public.user_key_pairs row. After
--   20260520 tightened RLS on that table there is also no DELETE policy, so
--   the client cannot remove it directly. Result: after a "Reset Encryption",
--   a fresh setup still found the stale row via get_my_key_pair() and tried to
--   decrypt the OLD identity_private_key_encrypted with the NEW recovery key,
--   which fails ("Could not unlock your encryption identity ..."). The account
--   was effectively bricked for encryption.
--
--   This SECURITY DEFINER RPC removes the caller's key pair row(s) and the
--   dependent encryption state in one atomic call, bypassing the (intentional)
--   absence of a DELETE policy. It only ever touches the CALLER's own rows.
--
-- Idempotent and safe to run repeatedly. Dependent tables are guarded so the
-- function still works on deploys where some of them don't exist.
-- ---------------------------------------------------------------------------
BEGIN;

CREATE OR REPLACE FUNCTION public.reset_my_encryption_identity()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile_id uuid;
BEGIN
    SELECT id INTO v_profile_id
    FROM public.profiles
    WHERE auth_user_id = auth.uid();

    IF v_profile_id IS NULL THEN
        RAISE EXCEPTION 'No profile for current user';
    END IF;

    -- The identity itself. Removing ALL rows (not just is_active) clears any
    -- stale/duplicate rows from earlier setups so the next setup is clean.
    DELETE FROM public.user_key_pairs WHERE user_id = v_profile_id;

    -- Dependent encryption state. Guarded individually so a missing table or
    -- column on a given deploy doesn't abort the whole reset.
    BEGIN
        DELETE FROM public.megolm_session_shares
        WHERE sender_user_id = v_profile_id OR recipient_user_id = v_profile_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END;

    BEGIN
        DELETE FROM public.megolm_key_backups WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END;

    BEGIN
        DELETE FROM public.megolm_key_requests
        WHERE sender_user_id = v_profile_id OR user_id = v_profile_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END;

    BEGIN
        DELETE FROM public.recovery_key_metadata WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END;

    BEGIN
        DELETE FROM public.user_devices WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END;
END;
$$;

COMMENT ON FUNCTION public.reset_my_encryption_identity() IS
    'Deletes the calling user''s own encryption identity (user_key_pairs) and dependent state (session shares, backups, key requests, recovery metadata, devices) so they can re-set-up encryption from scratch. SECURITY DEFINER: there is intentionally no DELETE policy on user_key_pairs, and this only ever affects the caller''s own rows.';

GRANT EXECUTE ON FUNCTION public.reset_my_encryption_identity() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
