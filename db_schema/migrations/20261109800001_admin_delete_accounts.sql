-- Instance admins delete accounts and free their usernames.
--
--   erase_account(auth_id)
--       The deletion of delete_my_account, moved here unchanged: tombstone, per-user rows, anonymized
--       profile, account-deleted job, auth user. No checks; no client role runs it.
--   delete_my_account(password)
--       Its re-authentication and ownership check, then erase_account.
--   admin_delete_accounts_preview(profile_ids)
--       Per account: why it is skipped, if it is; activity; follows; owned servers.
--   admin_delete_accounts(profile_ids, reason)
--       One transaction, at most 200 accounts. One admin_audit_log row per account, action_type
--       user_delete, with action_details.reason, username, bulk, batch_id, batch_size.
--
-- Admitted: instance admins that are not suspended. A moderator is refused.
-- Skipped: the caller, instance staff, accounts of other instances, accounts without a sign-in,
-- deleted accounts, and owners of a server with another member, as delete_my_account refuses.
-- An account of AdminService's 'delete', a suspension with a DELETED: reason, still holds its
-- username and is deleted here.
--
-- A username is free once profiles.username is the generated deleted_ name: the row is anonymized,
-- and only (username, domain) is unique. A new account on that name is a new actor: ActorService and
-- WebFingerService read live profiles before deleted_actors.
--
-- signup_ledger has no link to an account, so the inbox still counts toward signup_mailbox_cap.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.erase_account(p_auth_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_auth_id uuid := p_auth_id;
    v_profile public.profiles%ROWTYPE;
    v_key text;
    v_actor text;
    v_inboxes text[];
BEGIN
    SELECT p.* INTO v_profile FROM public.profiles p WHERE p.auth_user_id = v_auth_id;

    IF v_profile.id IS NOT NULL THEN
        -- Snapshot for the ActivityPub Delete before follows and keys are purged.
        IF v_profile.is_local IS NOT FALSE AND v_profile.username IS NOT NULL THEN
            SELECT k.private_key INTO v_key FROM public.user_private_keys k WHERE k.user_id = v_profile.id;
            v_actor := coalesce(nullif(v_profile.federated_id, ''),
                                'https://' || v_profile.domain || '/users/' || v_profile.username);
            SELECT coalesce(array_agg(DISTINCT x.inbox), '{}') INTO v_inboxes
              FROM (SELECT coalesce(nullif(rp.shared_inbox_url, ''), rp.inbox_url) AS inbox
                      FROM public.follows f
                      JOIN public.profiles rp
                        ON rp.id = CASE WHEN f.follower_id = v_profile.id
                                        THEN f.following_id ELSE f.follower_id END
                     WHERE (f.follower_id = v_profile.id OR f.following_id = v_profile.id)
                       AND rp.is_local IS FALSE) x
             WHERE x.inbox LIKE 'https://%' OR x.inbox LIKE 'http://%';
            INSERT INTO public.deleted_actors (profile_id, username, domain, actor_uri, private_key, inboxes)
            VALUES (v_profile.id, v_profile.username, v_profile.domain, v_actor, v_key, v_inboxes)
            ON CONFLICT (profile_id) DO NOTHING;
        END IF;

        DELETE FROM public.servers s WHERE s.owner = v_profile.id;

        DELETE FROM public.user_key_pairs        WHERE user_id = v_profile.id;
        DELETE FROM public.megolm_session_shares WHERE sender_user_id = v_profile.id OR recipient_user_id = v_profile.id;
        DELETE FROM public.megolm_key_requests   WHERE requester_user_id = v_profile.id OR sender_user_id = v_profile.id;
        DELETE FROM public.megolm_key_backups    WHERE user_id = v_profile.id;
        DELETE FROM public.recovery_key_metadata WHERE user_id = v_profile.id;
        DELETE FROM public.mfa_recovery_codes    WHERE user_id IN (v_profile.id, v_auth_id);
        DELETE FROM public.follows               WHERE follower_id = v_profile.id OR following_id = v_profile.id;
        DELETE FROM public.timeline_entries      WHERE user_id = v_profile.id;
        DELETE FROM public.unread_counts         WHERE user_id = v_profile.id;
        DELETE FROM public.post_interactions     WHERE user_id = v_profile.id;
        DELETE FROM public.invites               WHERE created_by = v_profile.id;
        DELETE FROM public.user_servers          WHERE user_id = v_profile.id;
        DELETE FROM public.user_private_keys     WHERE user_id = v_profile.id;
        DELETE FROM public.push_subscriptions    WHERE user_id = v_profile.id;
        DELETE FROM public.notifications         WHERE user_id = v_profile.id;
        DELETE FROM public.user_blocks           WHERE blocker_id = v_profile.id OR blocked_user_id = v_profile.id;
        DELETE FROM public.user_mutes            WHERE muter_id = v_profile.id OR muted_user_id = v_profile.id;
        DELETE FROM public.user_roles            WHERE user_id = v_profile.id;
        DELETE FROM public.thread_members        WHERE user_id = v_profile.id;
        DELETE FROM public.voice_channel_participants WHERE user_id = v_profile.id;
        DELETE FROM public.notification_preferences   WHERE user_id = v_profile.id;
        DELETE FROM public.notification_channels      WHERE user_id = v_profile.id;
        DELETE FROM public.server_folders        WHERE user_id = v_profile.id;
        DELETE FROM public.emoji_favorites       WHERE user_id = v_profile.id;
        DELETE FROM public.gif_favorites         WHERE user_id = v_profile.id;
        DELETE FROM public.user_list_members     WHERE account_id = v_profile.id;
        DELETE FROM public.user_lists            WHERE user_id = v_profile.id;
        DELETE FROM public.account_data_exports  WHERE profile_id = v_profile.id;
        DELETE FROM public.account_security_attempts WHERE auth_user_id = v_auth_id;

        -- Deployments differ on these.
        BEGIN
            DELETE FROM public.user_devices WHERE user_id = v_profile.id;
        EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
        END;
        BEGIN
            DELETE FROM public.user_sessions WHERE user_id = v_profile.id;
        EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
        END;
        BEGIN
            DELETE FROM public.announcement_reads WHERE user_id = v_profile.id;
        EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
        END;
        BEGIN
            DELETE FROM public.emoji_usage WHERE user_id = v_profile.id;
        EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
        END;
        BEGIN
            UPDATE public.bot_tokens t SET is_active = false
             WHERE t.bot_id IN (SELECT b.id FROM public.bots b WHERE b.owner_id = v_profile.id);
            UPDATE public.bots b SET is_active = false WHERE b.owner_id = v_profile.id;
        EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
        END;

        -- auth_user_id = NULL detaches the row before the auth delete, so the cascade
        -- cannot reach it. The generated username satisfies profiles_username_check.
        UPDATE public.profiles SET
            username = 'deleted_' || replace(substr(v_profile.id::text, 1, 13), '-', ''),
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
            deleted_at = now(),
            updated_at = now()
        WHERE id = v_profile.id;

        PERFORM public.queue_federation_job('account-deleted',
            jsonb_build_object('profile_id', v_profile.id, 'auth_user_id', v_auth_id),
            3, 10, 86400);
    END IF;

    -- Cascades sessions, identities and factors through GoTrue's foreign keys.
    DELETE FROM auth.users WHERE id = v_auth_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_account(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_my_account(p_password text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_auth_id uuid := auth.uid();
    v_hash text;
    v_profile public.profiles%ROWTYPE;
    v_blocking text[];
BEGIN
    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: requires an authenticated session' USING ERRCODE = '42501';
    END IF;

    IF public.mfa_enabled_for(v_auth_id)
       AND (public.current_jwt_claims() ->> 'aal' IS DISTINCT FROM 'aal2'
            OR NOT public.session_step_up_fresh('totp', interval '10 minutes')) THEN
        RETURN jsonb_build_object('error', 'mfa_required');
    END IF;

    SELECT u.encrypted_password INTO v_hash FROM auth.users u WHERE u.id = v_auth_id;
    IF v_hash LIKE '$2%' THEN
        IF coalesce(p_password, '') = '' THEN
            RETURN jsonb_build_object('error', 'password_required');
        END IF;
        PERFORM public.assert_security_attempt_budget(v_auth_id, 'password');
        IF extensions.crypt(p_password, v_hash) IS DISTINCT FROM v_hash THEN
            PERFORM public.record_security_attempt(v_auth_id, 'password', false);
            RETURN jsonb_build_object('error', 'invalid_password');
        END IF;
    ELSIF NOT public.session_step_up_fresh(NULL, interval '10 minutes') THEN
        RETURN jsonb_build_object('error', 'reauthentication_required');
    END IF;

    SELECT p.* INTO v_profile FROM public.profiles p WHERE p.auth_user_id = v_auth_id;

    IF v_profile.id IS NOT NULL THEN
        SELECT array_agg(s.name ORDER BY s.name) INTO v_blocking
          FROM public.servers s
         WHERE s.owner = v_profile.id
           AND EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = s.id AND us.user_id <> v_profile.id);
        IF v_blocking IS NOT NULL THEN
            RETURN jsonb_build_object('error', 'transfer_ownership_required',
                                      'servers', to_jsonb(v_blocking));
        END IF;
    END IF;

    PERFORM public.erase_account(v_auth_id);

    RETURN jsonb_build_object('success', true);
END;
$$;

-- Why an admin cannot delete p_profile; null when they can. A row of nulls is a missing account.
CREATE OR REPLACE FUNCTION public.admin_delete_skip_reason(p_caller uuid, p_profile public.profiles)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN (p_profile).id IS NULL THEN 'not_found'
        WHEN (p_profile).id = p_caller THEN 'self'
        WHEN (p_profile).is_admin IS TRUE OR (p_profile).is_moderator IS TRUE THEN 'staff'
        WHEN (p_profile).is_local IS FALSE THEN 'remote'
        WHEN (p_profile).auth_user_id IS NULL THEN 'no_sign_in'
        WHEN (p_profile).deleted_at IS NOT NULL THEN 'deleted'
        WHEN EXISTS (SELECT 1 FROM public.servers s
                      WHERE s.owner = (p_profile).id
                        AND EXISTS (SELECT 1 FROM public.user_servers us
                                     WHERE us.server_id = s.id AND us.user_id <> (p_profile).id))
            THEN 'owns_server'
    END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_skip_reason(uuid, public.profiles) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_delete_caller()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    RETURN v_me;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_caller() FROM PUBLIC, anon, authenticated, service_role;

-- Accounts that can be deleted first, then by username.
CREATE OR REPLACE FUNCTION public.admin_delete_accounts_preview(p_profile_ids uuid[])
RETURNS TABLE (
    id uuid,
    username text,
    display_name text,
    avatar_url text,
    skip_reason text,
    post_count integer,
    message_count integer,
    local_follows integer,
    remote_followers integer,
    owned_servers jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.admin_delete_caller();
BEGIN
    PERFORM public.staff_bulk_check_ids(p_profile_ids);

    RETURN QUERY
    WITH requested AS (
        SELECT DISTINCT u.pid FROM unnest(p_profile_ids) AS u(pid)
    ),
    rows AS (
        SELECT r.pid, p, public.admin_delete_skip_reason(v_me, p) AS skip
          FROM requested r
          LEFT JOIN public.profiles p ON p.id = r.pid
    )
    SELECT r.pid, (r.p).username, (r.p).display_name, (r.p).avatar_url, r.skip,
           (SELECT count(*)::integer FROM public.posts po
             WHERE po.author_id = r.pid AND po.is_deleted IS NOT TRUE),
           (SELECT count(*)::integer FROM public.messages msg
             WHERE msg.user_id = r.pid AND msg.is_deleted IS NOT TRUE AND msg.is_system IS NOT TRUE),
           (SELECT count(*)::integer FROM public.follows f
              JOIN public.profiles o ON o.id = CASE WHEN f.follower_id = r.pid THEN f.following_id ELSE f.follower_id END
             WHERE (f.follower_id = r.pid OR f.following_id = r.pid) AND o.is_local IS TRUE),
           (SELECT count(*)::integer FROM public.follows f
              JOIN public.profiles o ON o.id = f.follower_id
             WHERE f.following_id = r.pid AND o.is_local IS FALSE),
           COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'suspended', s.suspended_at IS NOT NULL,
                          'member_count', mc.members, 'remote_member_count', mc.remote)
                      ORDER BY mc.members DESC, s.name)
                 FROM public.servers s
                 LEFT JOIN LATERAL (
                     SELECT count(*)::integer AS members,
                            count(*) FILTER (WHERE mp.is_local IS FALSE)::integer AS remote
                       FROM public.user_servers us
                       JOIN public.profiles mp ON mp.id = us.user_id
                      WHERE us.server_id = s.id AND us.status = 'accepted') mc ON true
                WHERE s.owner = r.pid AND s.is_local_server IS NOT FALSE), '[]'::jsonb)
      FROM rows r
     ORDER BY r.skip IS NOT NULL, (r.p).username, r.pid;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_accounts(p_profile_ids uuid[], p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.admin_delete_caller();
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 512), '');
    v_batch uuid := gen_random_uuid();
    v_size integer;
    v_id uuid;
    v_row public.profiles%ROWTYPE;
    v_skip text;
    v_deleted jsonb := '[]'::jsonb;
    v_skipped jsonb := '[]'::jsonb;
BEGIN
    PERFORM public.staff_bulk_check_ids(p_profile_ids);
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'REASON_REQUIRED: a reason is required' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT u.pid)::integer INTO v_size FROM unnest(p_profile_ids) AS u(pid);

    -- Ascending id: two overlapping batches lock in one order.
    FOR v_id IN SELECT DISTINCT u.pid FROM unnest(p_profile_ids) AS u(pid) ORDER BY 1 LOOP
        v_row := NULL;
        SELECT * INTO v_row FROM public.profiles p WHERE p.id = v_id FOR UPDATE;
        v_skip := public.admin_delete_skip_reason(v_me, v_row);
        IF v_skip IS NOT NULL THEN
            v_skipped := v_skipped || jsonb_build_object('id', v_id, 'username', v_row.username, 'reason', v_skip);
            CONTINUE;
        END IF;

        PERFORM public.erase_account(v_row.auth_user_id);

        PERFORM public.log_admin_action(v_me, 'user_delete', 'user', v_id::text,
            jsonb_build_object('reason', v_reason, 'username', v_row.username,
                               'bulk', true, 'batch_id', v_batch, 'batch_size', v_size));

        v_deleted := v_deleted || jsonb_build_object('id', v_id, 'username', v_row.username);
    END LOOP;

    RETURN jsonb_build_object('batch_id', v_batch, 'deleted', v_deleted, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_accounts_preview(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_accounts(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_accounts_preview(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_accounts(uuid[], text) TO authenticated;

-- Prod definers have mixed owners, postgres and supabase_admin, and CREATE OR REPLACE keeps
-- delete_my_account's. A definer runs as its owner, and a non-superuser owner has no EXECUTE on a
-- helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT h.helper, pg_get_userbyid(p.proowner) AS owner
          FROM (VALUES
                  ('erase_account(uuid)', ARRAY['delete_my_account', 'admin_delete_accounts']),
                  ('admin_delete_skip_reason(uuid, public.profiles)', ARRAY['admin_delete_accounts_preview', 'admin_delete_accounts']),
                  ('admin_delete_caller()', ARRAY['admin_delete_accounts_preview', 'admin_delete_accounts'])
               ) AS h(helper, callers)
          JOIN pg_proc p ON p.proname = ANY (h.callers) AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', r.helper, r.owner);
    END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
