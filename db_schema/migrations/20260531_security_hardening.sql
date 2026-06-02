-- ===========================================================================
-- Security hardening migration (2026-05-31)
--
-- Idempotent. Mirrors the same fixes applied to db_schema/init/* so existing
-- dev/prod databases get the patches. Safe to run multiple times.
--
-- Covers audit findings:
--   C1 DM conversation_participants self-join / enumeration
--   C2 save_recovery_codes missing caller binding (+ batch_id)
--   C3 moderation report RPCs missing admin guard
--   C4 notifications INSERT forgery
--   C5 profile self-escalation trigger (port to all envs)
--   C6 user_key_pairs private-column exposure
--   H  broadcast_user_event grant, generate_livekit_token membership,
--      bump_room_epoch authz, megolm_session_shares membership,
--      server_bans / timeline_entries / server_federation_events RLS,
--      device-approval server enforcement
--   M  claim/get_unclaimed_session_shares caller binding
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- Helper: is_conversation_participant (used by C1 RLS, recursion-safe)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_conversation_participant(p_conversation_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.conversation_participants
        WHERE conversation_id = p_conversation_id
          AND user_id = p_user_id
          AND left_at IS NULL
    );
$$;
GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- C1: conversation_participants
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "conversation_participants_select_policy" ON public.conversation_participants;
CREATE POLICY "conversation_participants_select_policy" ON public.conversation_participants
    FOR SELECT USING (
        public.is_conversation_participant(conversation_id, public.get_current_profile_id())
    );

DROP POLICY IF EXISTS "Authenticated users can manage participants" ON public.conversation_participants;
DROP POLICY IF EXISTS "conversation_participants_insert_self_owned" ON public.conversation_participants;
CREATE POLICY "conversation_participants_insert_self_owned" ON public.conversation_participants
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = conversation_id
              AND c.created_by = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- C4: notifications INSERT (service_role only; definers bypass RLS)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "notifications_insert_system" ON public.notifications;
CREATE POLICY "notifications_insert_system" ON public.notifications
    FOR INSERT TO service_role WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- C3: moderation report RPCs (admin/mod guard)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pending_reports_count()
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT COUNT(*)::integer FROM public.reports WHERE status = 'pending');
END;
$$;

-- get_reports_with_details: re-add the guard inside the existing body. We patch
-- by prepending the guard via CREATE OR REPLACE only if the function lacks it.
-- (Full body kept in init; here we wrap the existing function defensively.)
DO $guard$
DECLARE
    v_src text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_reports_with_details'
    LIMIT 1;

    IF v_src IS NOT NULL AND position('is_current_user_admin_or_mod' in v_src) = 0 THEN
        -- Inject the guard right after the first BEGIN (3-arg regexp_replace
        -- replaces only the first match; the body's BEGIN is the first literal
        -- "BEGIN" in the definition).
        v_src := regexp_replace(
            v_src,
            'BEGIN',
            E'BEGIN\n    IF NOT public.is_current_user_admin_or_mod() THEN\n        RAISE EXCEPTION ''Permission denied: moderator access required'' USING ERRCODE = ''42501'';\n    END IF;'
        );
        EXECUTE v_src;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- C2: save_recovery_codes caller binding + batch_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_recovery_codes(p_user_id uuid, p_codes text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code TEXT;
  v_code_hash TEXT;
  v_caller uuid;
  v_batch_id uuid := gen_random_uuid();
BEGIN
  v_caller := public.get_current_profile_id();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Permission denied: can only save your own recovery codes' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.mfa_recovery_codes WHERE user_id = v_caller;

  FOREACH v_code IN ARRAY p_codes LOOP
    v_code_hash := encode(extensions.digest(v_code::bytea, 'sha256'), 'hex');
    INSERT INTO public.mfa_recovery_codes (user_id, code_hash, batch_id)
    VALUES (v_caller, v_code_hash, v_batch_id);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- C5: profile self-escalation guard
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_moderator boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_suspended boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_silenced boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS force_sensitive boolean DEFAULT false;

CREATE OR REPLACE FUNCTION public.prevent_profile_moderation_self_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_role text;
    v_is_admin boolean;
BEGIN
    v_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
    IF v_role = 'service_role' OR session_user = 'postgres' THEN
        RETURN NEW;
    END IF;
    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin
       OR NEW.is_moderator IS DISTINCT FROM OLD.is_moderator
       OR NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
       OR NEW.is_silenced IS DISTINCT FROM OLD.is_silenced
       OR NEW.force_sensitive IS DISTINCT FROM OLD.force_sensitive
    THEN
        SELECT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.auth_user_id = auth.uid() AND p.is_admin = true
              AND COALESCE(p.is_suspended, false) = false
        ) INTO v_is_admin;
        IF v_is_admin IS NOT TRUE THEN
            RAISE EXCEPTION 'Permission denied: cannot modify moderation flags on profile'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS prevent_profile_moderation_self_update_trigger ON public.profiles;
CREATE TRIGGER prevent_profile_moderation_self_update_trigger
    BEFORE UPDATE OF is_admin, is_moderator, is_suspended, is_silenced, force_sensitive
    ON public.profiles FOR EACH ROW
    EXECUTE FUNCTION public.prevent_profile_moderation_self_update();

-- ---------------------------------------------------------------------------
-- C6: user_key_pairs private-column restriction
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS identity_signing_public_key text;
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS identity_signing_private_key_encrypted text;

DROP POLICY IF EXISTS "Users can view others' public keys for encryption" ON public.user_key_pairs;
DROP POLICY IF EXISTS "Users can view own key pair (full row)" ON public.user_key_pairs;
CREATE POLICY "Users can view own key pair (full row)" ON public.user_key_pairs
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.profiles
                WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    );
DROP POLICY IF EXISTS "Users can view active public key columns" ON public.user_key_pairs;
CREATE POLICY "Users can view active public key columns" ON public.user_key_pairs
    FOR SELECT USING (is_active = true);

REVOKE SELECT ON public.user_key_pairs FROM authenticated;
REVOKE SELECT ON public.user_key_pairs FROM anon;
GRANT SELECT (
    id, user_id, device_id, identity_public_key, identity_signing_public_key,
    key_version, is_active, created_at, last_used_at, expires_at, metadata
) ON public.user_key_pairs TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_key_pair()
RETURNS TABLE (
    id uuid, user_id uuid, device_id text,
    identity_public_key text, identity_private_key_encrypted text,
    identity_signing_public_key text, identity_signing_private_key_encrypted text,
    key_version integer, is_active boolean, created_at timestamptz,
    last_used_at timestamptz, expires_at timestamptz, metadata jsonb
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
    SELECT ukp.id, ukp.user_id, ukp.device_id,
           ukp.identity_public_key, ukp.identity_private_key_encrypted,
           ukp.identity_signing_public_key, ukp.identity_signing_private_key_encrypted,
           ukp.key_version, ukp.is_active, ukp.created_at,
           ukp.last_used_at, ukp.expires_at, ukp.metadata
    FROM public.user_key_pairs ukp
    JOIN public.profiles p ON p.id = ukp.user_id
    WHERE p.auth_user_id = auth.uid() AND ukp.is_active = true
    ORDER BY ukp.created_at DESC LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_key_pair() TO authenticated;

-- ---------------------------------------------------------------------------
-- H: broadcast_user_event - service_role only
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.broadcast_user_event(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_user_event(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- H: megolm_session_shares INSERT membership check
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "megolm_session_shares_insert" ON public.megolm_session_shares;
CREATE POLICY "megolm_session_shares_insert" ON public.megolm_session_shares
    FOR INSERT WITH CHECK (
        sender_user_id = public.get_current_profile_id()
        AND public.is_room_member(room_id, sender_user_id)
        AND public.is_room_member(room_id, recipient_user_id)
    );

-- ---------------------------------------------------------------------------
-- M: claim_session_share / get_unclaimed_session_shares caller binding
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_session_share(p_share_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
DECLARE v_caller uuid;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL OR p_user_id IS DISTINCT FROM v_caller THEN
        RETURN false;
    END IF;
    UPDATE public.megolm_session_shares
    SET is_claimed = true, claimed_at = NOW()
    WHERE id = p_share_id AND recipient_user_id = v_caller AND is_claimed = false;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_unclaimed_session_shares(p_user_id uuid)
RETURNS TABLE(share_id uuid, room_id text, session_id text, sender_user_id uuid, encrypted_session_key text, first_known_index integer, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
DECLARE v_caller uuid;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL OR p_user_id IS DISTINCT FROM v_caller THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT s.id, s.room_id, s.session_id, s.sender_user_id,
           s.encrypted_session_key, s.first_known_index, s.created_at
    FROM public.megolm_session_shares s
    WHERE s.recipient_user_id = v_caller AND s.is_claimed = false
    ORDER BY s.created_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- H: bump_room_epoch authz (revoke direct grant + guarded wrapper)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.bump_room_epoch(text, text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.request_room_epoch_bump(p_room_id text, p_reason text DEFAULT 'manual_rotate')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF p_room_id IS NULL THEN RETURN NULL; END IF;
    IF NOT public.is_room_member(p_room_id, public.get_current_profile_id()) THEN
        RAISE EXCEPTION 'Permission denied: not a member of this room' USING ERRCODE = '42501';
    END IF;
    RETURN public.bump_room_epoch(p_room_id, p_reason);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_room_epoch_bump(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- H: device approval server enforcement (RPCs + lock down table UPDATE)
--
-- NOTE: public.device_approval_requests is created by the LATER-numbered
-- migration 20260601_device_identity_and_epochs.sql. If migrations are applied
-- in filename order on a DB that doesn't yet have the table, the policy DDL
-- below would raise "relation does not exist" and abort this ENTIRE
-- transaction, silently rolling back every C1-C6 / RLS hardening fix above.
-- We therefore guard the table-dependent statements with to_regclass(); the
-- 20260601 migration sets the same hardened (SELECT + INSERT only) policies, so
-- the end state is correct regardless of which migration runs first.
-- ---------------------------------------------------------------------------
DO $devapproval$
BEGIN
    IF to_regclass('public.device_approval_requests') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "device_approval_requests_own" ON public.device_approval_requests';
        EXECUTE 'DROP POLICY IF EXISTS "device_approval_requests_select_own" ON public.device_approval_requests';
        EXECUTE 'CREATE POLICY "device_approval_requests_select_own" ON public.device_approval_requests
            FOR SELECT USING (user_id = public.get_current_profile_id())';
        EXECUTE 'DROP POLICY IF EXISTS "device_approval_requests_insert_own" ON public.device_approval_requests';
        EXECUTE 'CREATE POLICY "device_approval_requests_insert_own" ON public.device_approval_requests
            FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())';
    ELSE
        RAISE NOTICE 'device_approval_requests not present yet; its policies are set by 20260601_device_identity_and_epochs.sql';
    END IF;
END
$devapproval$;

CREATE OR REPLACE FUNCTION public.approve_device_request(
    p_request_id uuid, p_approver_device_id text, p_encrypted_sync_bundle text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_caller uuid; v_req record; v_approver record;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
    SELECT * INTO v_req FROM public.device_approval_requests WHERE id = p_request_id;
    IF v_req IS NULL OR v_req.user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE='42501';
    END IF;
    IF v_req.status <> 'pending' THEN RETURN false; END IF;
    IF p_approver_device_id IS NULL OR p_approver_device_id = v_req.requesting_device_id THEN
        RAISE EXCEPTION 'A device cannot approve its own login' USING ERRCODE='42501';
    END IF;
    SELECT * INTO v_approver FROM public.user_devices
    WHERE user_id = v_caller AND device_id = p_approver_device_id;
    IF v_approver IS NULL OR v_approver.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Approving device is not a valid device on this account' USING ERRCODE='42501';
    END IF;
    IF NOT (v_approver.trust_state IN ('verified','recovery')
            OR v_approver.created_at <= v_req.created_at - interval '5 seconds') THEN
        RAISE EXCEPTION 'Only an established device can approve a new login' USING ERRCODE='42501';
    END IF;
    UPDATE public.device_approval_requests
    SET status='approved', approved_by_device_id=p_approver_device_id,
        encrypted_sync_bundle=p_encrypted_sync_bundle, resolved_at=now()
    WHERE id = p_request_id;
    UPDATE public.user_devices SET trust_state='verified'
    WHERE user_id = v_caller AND device_id = v_req.requesting_device_id;
    RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_device_request(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.deny_device_request(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_caller uuid; v_req record;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
    SELECT * INTO v_req FROM public.device_approval_requests WHERE id = p_request_id;
    IF v_req IS NULL OR v_req.user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE='42501';
    END IF;
    UPDATE public.device_approval_requests SET status='denied', resolved_at=now()
    WHERE id = p_request_id AND status='pending';
    UPDATE public.user_devices SET trust_state='revoked', revoked_at=now()
    WHERE user_id = v_caller AND device_id = v_req.requesting_device_id;
    RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.deny_device_request(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- H: server_bans RLS (read = permission-gated; writes = service_role/RPC)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "server_bans_select_moderator" ON public.server_bans;
CREATE POLICY "server_bans_select_moderator" ON public.server_bans
    FOR SELECT TO authenticated USING (
        public.is_current_user_admin()
        OR public.has_permission(public.get_current_profile_id(), server_id, 'BAN_MEMBERS')
    );
DROP POLICY IF EXISTS "server_bans_insert_rpc" ON public.server_bans;
DROP POLICY IF EXISTS "server_bans_insert_service" ON public.server_bans;
CREATE POLICY "server_bans_insert_service" ON public.server_bans
    FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS "server_bans_delete_rpc" ON public.server_bans;
DROP POLICY IF EXISTS "server_bans_delete_service" ON public.server_bans;
CREATE POLICY "server_bans_delete_service" ON public.server_bans
    FOR DELETE TO service_role USING (true);

-- ---------------------------------------------------------------------------
-- H: timeline_entries RLS (read own; writes service_role/triggers)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can manage all timeline entries" ON public.timeline_entries;
DROP POLICY IF EXISTS "timeline_entries_select_own" ON public.timeline_entries;
CREATE POLICY "timeline_entries_select_own" ON public.timeline_entries
    FOR SELECT USING (user_id = public.get_current_profile_id());
DROP POLICY IF EXISTS "timeline_entries_service_write" ON public.timeline_entries;
CREATE POLICY "timeline_entries_service_write" ON public.timeline_entries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- H: server_federation_events RLS (drop permissive manage-all policy)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF to_regclass('public.server_federation_events') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage server events" ON public.server_federation_events';
        EXECUTE 'DROP POLICY IF EXISTS "Service role can manage server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Service role can manage server events" ON public.server_federation_events TO service_role USING (true) WITH CHECK (true)';
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='server_federation_events' AND column_name='user_id'
        ) THEN
            EXECUTE 'DROP POLICY IF EXISTS "Users can view server events they''re involved in" ON public.server_federation_events';
            EXECUTE 'CREATE POLICY "Users can view server events they''re involved in" ON public.server_federation_events FOR SELECT USING (user_id = public.get_current_profile_id())';
            EXECUTE 'DROP POLICY IF EXISTS "Users can create their own server events" ON public.server_federation_events';
            EXECUTE 'CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())';
        END IF;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Grants used by storage RLS (evaluated as authenticated)
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_permissions(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- H: storage upload policies (ownership / permission / path scoping)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can upload user_media" ON storage.objects;
CREATE POLICY "Authenticated users can upload user_media" ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'user_media' AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text)
        )
    );
DROP POLICY IF EXISTS "Users can update their own user_media" ON storage.objects;
CREATE POLICY "Users can update their own user_media" ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'user_media' AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text)
        )
    );
DROP POLICY IF EXISTS "Users can delete their own user_media" ON storage.objects;
CREATE POLICY "Users can delete their own user_media" ON storage.objects FOR DELETE
    USING (
        bucket_id = 'user_media' AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text)
        )
    );

DROP POLICY IF EXISTS "Server owners can upload server icons" ON storage.objects;
CREATE POLICY "Server owners can upload server icons" ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'server_icons'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER'));
DROP POLICY IF EXISTS "Server owners can update server icons" ON storage.objects;
CREATE POLICY "Server owners can update server icons" ON storage.objects FOR UPDATE
    USING (bucket_id = 'server_icons'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER'));
DROP POLICY IF EXISTS "Server owners can upload server banners" ON storage.objects;
CREATE POLICY "Server owners can upload server banners" ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'server_banners'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER'));
DROP POLICY IF EXISTS "Server owners can update server banners" ON storage.objects;
CREATE POLICY "Server owners can update server banners" ON storage.objects FOR UPDATE
    USING (bucket_id = 'server_banners'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER'));

DROP POLICY IF EXISTS "Users can upload emojis" ON storage.objects;
CREATE POLICY "Users can upload emojis" ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'emojis'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_EMOJIS'));
DROP POLICY IF EXISTS "Users can delete emojis" ON storage.objects;
CREATE POLICY "Users can delete emojis" ON storage.objects FOR DELETE
    USING (bucket_id = 'emojis'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_EMOJIS'));

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ---------------------------------------------------------------------------
-- H: generate_livekit_token membership check (separate statement; CREATE OR
-- REPLACE of the full function). Run outside the txn block above for clarity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_livekit_token(
  room_name text,
  room_type text DEFAULT 'voice_channel'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_profile_id uuid;
  v_username text;
  v_display_name text;
  v_api_key text;
  v_api_secret text;
  v_livekit_url text;
  v_payload jsonb;
  v_token text;
  v_issued_at bigint;
  v_expires_at bigint;
  v_jti text;
  v_room_uuid_text text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated', 'code', 'AUTH_REQUIRED');
  END IF;

  SELECT id, username, display_name INTO v_profile_id, v_username, v_display_name
  FROM profiles WHERE auth_user_id = v_user_id;

  IF v_username IS NULL THEN
    v_username := 'user_' || LEFT(v_user_id::text, 8);
  END IF;

  v_room_uuid_text := regexp_replace(room_name, '^(channel|stage|voice-channel|dm)-', '');
  IF v_profile_id IS NULL OR NOT public.is_room_member(v_room_uuid_text, v_profile_id) THEN
    RETURN jsonb_build_object('error', 'You do not have access to this room', 'code', 'ROOM_ACCESS_DENIED');
  END IF;

  SELECT livekit_api_key, livekit_api_secret, COALESCE(livekit_public_url, livekit_url)
  INTO v_api_key, v_api_secret, v_livekit_url
  FROM instance_webrtc_settings LIMIT 1;

  IF v_api_key IS NULL OR v_api_secret IS NULL OR v_livekit_url IS NULL THEN
    RETURN jsonb_build_object('error', 'Voice not configured. Admin needs to set LiveKit credentials in Settings.', 'code', 'VOICE_NOT_CONFIGURED');
  END IF;

  v_issued_at := EXTRACT(EPOCH FROM now())::bigint;
  v_expires_at := v_issued_at + 86400;
  v_jti := gen_random_uuid()::text;

  v_payload := jsonb_build_object(
    'iss', v_api_key, 'sub', v_profile_id::text, 'iat', v_issued_at,
    'exp', v_expires_at, 'nbf', v_issued_at, 'jti', v_jti,
    'name', COALESCE(v_display_name, v_username),
    'video', jsonb_build_object('roomJoin', true, 'room', room_name,
      'canPublish', true, 'canSubscribe', true, 'canPublishData', true),
    'metadata', jsonb_build_object('user_id', v_user_id::text, 'profile_id', v_profile_id::text,
      'room_type', room_type, 'username', v_username)::text
  );

  v_token := extensions.sign(v_payload::json, v_api_secret, 'HS256');
  IF v_token IS NULL THEN
    RETURN jsonb_build_object('error', 'Failed to generate token', 'code', 'TOKEN_ERROR');
  END IF;

  RETURN jsonb_build_object('token', v_token, 'wsUrl', v_livekit_url, 'roomName', room_name,
    'identity', v_profile_id::text, 'name', COALESCE(v_display_name, v_username), 'expiresAt', v_expires_at);
END;
$$;
GRANT EXECUTE ON FUNCTION public.generate_livekit_token(text, text) TO authenticated;
