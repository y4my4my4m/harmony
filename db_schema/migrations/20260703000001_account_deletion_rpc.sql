-- ============================================================================
-- Self-service account deletion.
--
-- Design: the profile row is a TOMBSTONE, not a delete. Messages, posts,
-- channels, DM conversations and every other FK keep pointing at the same
-- profiles.id, so nothing on screen breaks - the row is just anonymized to
-- "Deleted User" with the default avatar. Personal/private data (encryption
-- keys, devices, sessions, follows, notifications, interactions, ...) is
-- purged, and finally the auth.users row is removed.
--
-- Ordering matters: profiles.auth_user_id FKs to auth.users ON DELETE CASCADE.
-- auth_user_id is set to NULL during anonymization so deleting the auth user
-- afterwards cannot cascade the tombstone (and with it all content) away.
--
-- Security:
--   - Caller-bound via auth.uid(); no parameters.
--   - MFA step-up enforced server-side: if the account has a verified MFA
--     factor, the JWT must carry aal2. A stolen password alone cannot delete
--     an MFA-protected account.
--   - Server ownership: deletion is refused while the caller still owns
--     servers that have other members (transfer ownership first). Servers
--     where the caller is the only member are deleted outright.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_auth_id uuid;
  v_profile_id uuid;
  v_aal text;
  v_has_verified_mfa boolean;
  v_blocking_servers text[];
BEGIN
  v_auth_id := auth.uid();
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  -- MFA step-up gate (server-side, cannot be bypassed by a modified client).
  SELECT EXISTS (
    SELECT 1 FROM auth.mfa_factors
    WHERE user_id = v_auth_id AND status = 'verified'
  ) INTO v_has_verified_mfa;

  IF v_has_verified_mfa THEN
    v_aal := current_setting('request.jwt.claims', true)::jsonb ->> 'aal';
    IF v_aal IS DISTINCT FROM 'aal2' THEN
      RETURN jsonb_build_object('error', 'mfa_required');
    END IF;
  END IF;

  SELECT id INTO v_profile_id
  FROM public.profiles
  WHERE auth_user_id = v_auth_id;

  IF v_profile_id IS NOT NULL THEN
    -- Refuse while the caller owns servers that other people are members of.
    SELECT array_agg(s.name) INTO v_blocking_servers
    FROM public.servers s
    WHERE s.owner = v_profile_id
      AND EXISTS (
        SELECT 1 FROM public.user_servers us
        WHERE us.server_id = s.id
          AND us.user_id <> v_profile_id
      );

    IF v_blocking_servers IS NOT NULL AND array_length(v_blocking_servers, 1) > 0 THEN
      RETURN jsonb_build_object(
        'error', 'transfer_ownership_required',
        'servers', to_jsonb(v_blocking_servers)
      );
    END IF;

    -- Solo servers (caller is the only member) go away with the account.
    DELETE FROM public.servers s
    WHERE s.owner = v_profile_id;

    -- Purge personal data. Content tables (messages, posts, channels,
    -- conversations) are intentionally NOT touched - they keep pointing at
    -- the anonymized profile.
    DELETE FROM public.user_key_pairs        WHERE user_id = v_profile_id;
    DELETE FROM public.megolm_session_shares WHERE sender_user_id = v_profile_id OR recipient_user_id = v_profile_id;
    DELETE FROM public.megolm_key_requests   WHERE requester_user_id = v_profile_id OR sender_user_id = v_profile_id;
    DELETE FROM public.megolm_key_backups    WHERE user_id = v_profile_id;
    DELETE FROM public.recovery_key_metadata WHERE user_id = v_profile_id;
    DELETE FROM public.mfa_recovery_codes    WHERE user_id = v_profile_id;
    DELETE FROM public.follows               WHERE follower_id = v_profile_id OR following_id = v_profile_id;
    DELETE FROM public.timeline_entries      WHERE user_id = v_profile_id;
    DELETE FROM public.unread_counts         WHERE user_id = v_profile_id;
    DELETE FROM public.post_interactions     WHERE user_id = v_profile_id;
    DELETE FROM public.invites               WHERE created_by = v_profile_id;
    DELETE FROM public.user_servers          WHERE user_id = v_profile_id;

    -- Optional tables (deployments differ); ignore when absent.
    BEGIN
      DELETE FROM public.user_devices WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.push_subscriptions WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.notifications WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.user_blocks WHERE blocker_id = v_profile_id OR blocked_user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.user_private_keys WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;

    -- Anonymize. auth_user_id = NULL detaches the row from auth.users BEFORE
    -- the auth delete below, so the CASCADE cannot reach it. The generated
    -- username satisfies profiles_username_check and is unique per domain.
    UPDATE public.profiles SET
      username = 'deleted_' || replace(substr(v_profile_id::text, 1, 13), '-', ''),
      display_name = 'Deleted User',
      avatar_url = '/default_avatar.webp',
      banner_url = NULL,
      bio = NULL,
      color = NULL,
      status = 0,
      custom_status = NULL,
      profile_fields = '[]'::jsonb,
      appearance_settings = NULL,
      public_key = NULL,
      federated_id = NULL,
      inbox_url = NULL,
      outbox_url = NULL,
      followers_url = NULL,
      following_url = NULL,
      featured_url = NULL,
      shared_inbox_url = NULL,
      federation_metadata = '{}'::jsonb,
      is_admin = false,
      is_moderator = false,
      federation_enabled = false,
      federation_discoverable = false,
      followers_count = 0,
      following_count = 0,
      auth_user_id = NULL,
      updated_at = now()
    WHERE id = v_profile_id;
  END IF;

  -- Finally remove the auth user. Cascades auth-side rows (sessions,
  -- identities, mfa_factors) via Supabase's own FKs.
  DELETE FROM auth.users WHERE id = v_auth_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;

COMMIT;
