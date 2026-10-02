-- Joins through database functions, what non-members see of a server, boosts and replies
-- built from posts the caller can read, server-derived display-name emoji, channel and
-- category placement, and removal of system rows.
--
-- Client write: a statement executed as authenticated or anon at trigger depth 1, as in
-- 20261005600001_message_path_security.sql.
--
-- Joining. Clients insert no user_servers row, except an owner's own row in their own server:
-- older clients insert it after creating a server, the trigger below already has, and they
-- read the 23505 as success. A membership comes from:
--   join_public_server(server)    local server with servers.public (the public directory)
--   redeem_invite(code)           local server, through an invite
--   add_server_owner_membership   AFTER INSERT on servers, the owner of a client-created
--                                 local server
--   service_role                  federation joins and remote member sync
-- consume_invite(server, code) locks the invite row, checks it (exists for that server, not
-- exhausted, not revoked, not expired) and counts one use; max_uses <= 0 is unlimited and
-- used = true marks a revoked or exhausted invite. redeem_invite and the federation backend
-- call it. A caller already accepted consumes nothing. get_invite_preview(code) is the server
-- card shown to a holder of a valid invite.
-- invites: INSERT needs an accepted membership and CREATE_INVITE (the owner holds every
-- permission); a client UPDATE only revokes (used false -> true).
--
-- Visibility. servers: public rows; for authenticated callers also rows they hold a membership
-- of (any status), own, or administer. channel_categories, server_roles, user_roles: for
-- authenticated callers, rows of servers they are a member of or own, or any as instance
-- admin; user_roles also the caller's own rows. anon reads none of these three.
-- channels, invites and user_servers carry member-scoped policies of their own.
-- get_server_member_counts answers 0 for a server the caller cannot see.
-- lookup_invite_by_code is service_role only.
--
-- posts, client INSERT. metadata.reblog_of makes a boost, metadata.is_quote a quote. The target
-- is read under the caller's RLS and must be live, public or unlisted, and not itself a plain
-- boost. reblog, reblog_author, ap_type 'Announce', conversation fields and metadata
-- reblog_of/original_author derive from it; a plain boost also takes its content, visibility,
-- warning and sensitivity. A second live plain boost of one post raises 23505. Without
-- reblog_of: reblog fields, Announce and boost metadata keys are refused, ap_type is 'Note';
-- in_reply_to must be a live post the caller can read, conversation_id and
-- conversation_root_id derive from it.
-- posts, client UPDATE: boost metadata keys stay; a plain boost keeps its copied fields.
--
-- profiles, client writes. federation_metadata is the old value (empty on insert) with
-- display_name_emojis derived from display_name: each :shortcode: resolves to one emojis row
-- with an image URL, preferring instance emoji, then local server emoji, then the oldest
-- row. Empty when instance_config allow_custom_emojis_in_display_names is false. The field is
-- recomputed only when display_name changes.
--
-- messages, every writer: reply_to names a message in the same channel and conversation.
-- messages, client writes: a system row is soft-deleted or deleted only by a holder of
-- MANAGE_MESSAGES in its channel, or by an admin participant of its conversation.
--
-- channels, client UPDATE: server_id is fixed. channels, every writer: category belongs to the
-- channel's server. channel_categories, client UPDATE: server_id is fixed; the policy needs
-- the owner, MANAGE_CHANNELS or an instance admin.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Joining
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.consume_invite(p_server_id uuid, p_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv record;
    v_uses integer;
    v_limited boolean;
BEGIN
    SELECT i.id, i.server_id, i.used, i.expires_at, i.max_uses, COALESCE(i.uses, 0) AS uses
      INTO v_inv
      FROM public.invites i
     WHERE i.code = p_code
       FOR UPDATE;

    IF NOT FOUND OR v_inv.server_id IS DISTINCT FROM p_server_id THEN
        RETURN 'not_found';
    END IF;

    v_limited := COALESCE(v_inv.max_uses, 0) > 0;
    IF v_limited AND v_inv.uses >= v_inv.max_uses THEN
        RETURN 'exhausted';
    END IF;
    IF v_inv.used IS TRUE THEN
        RETURN 'revoked';
    END IF;
    IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at <= now() THEN
        RETURN 'expired';
    END IF;

    v_uses := v_inv.uses + 1;
    UPDATE public.invites
       SET uses = v_uses,
           used = v_limited AND v_uses >= v_inv.max_uses
     WHERE id = v_inv.id;
    RETURN NULL;
END;
$$;

-- A caller already accepted gets joined = false and uses nothing; a pending row is accepted.
CREATE OR REPLACE FUNCTION public.redeem_invite(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
    v_temporary boolean;
    v_local boolean;
    v_status text;
    v_reason text;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT i.server_id, i.temporary, s.is_local_server
      INTO v_server, v_temporary, v_local
      FROM public.invites i
      JOIN public.servers s ON s.id = i.server_id
     WHERE i.code = p_code;

    IF v_server IS NULL OR v_local IS NOT TRUE THEN
        RAISE EXCEPTION 'INVITE_NOT_FOUND: invalid invite code' USING ERRCODE = 'P0002';
    END IF;

    SELECT us.status INTO v_status
      FROM public.user_servers us
     WHERE us.server_id = v_server AND us.user_id = v_me;

    IF v_status = 'accepted' THEN
        RETURN jsonb_build_object('server_id', v_server, 'joined', false);
    END IF;
    IF v_status = 'banned' OR EXISTS (
            SELECT 1 FROM public.server_bans b WHERE b.server_id = v_server AND b.user_id = v_me) THEN
        RAISE EXCEPTION 'BANNED_FROM_SERVER: this account is banned from the server'
            USING ERRCODE = '42501';
    END IF;

    v_reason := public.consume_invite(v_server, p_code);
    IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'INVITE_%: %', upper(v_reason),
            CASE v_reason
                WHEN 'exhausted' THEN 'this invite has reached its maximum uses'
                WHEN 'revoked' THEN 'this invite has been revoked'
                WHEN 'expired' THEN 'this invite has expired'
                ELSE 'invalid invite code'
            END
            USING ERRCODE = 'P0001';
    END IF;

    IF v_status IS NULL THEN
        INSERT INTO public.user_servers (server_id, user_id, status, temporary)
        VALUES (v_server, v_me, 'accepted', COALESCE(v_temporary, false));
    ELSE
        UPDATE public.user_servers SET status = 'accepted'
         WHERE server_id = v_server AND user_id = v_me;
    END IF;

    RETURN jsonb_build_object('server_id', v_server, 'joined', true);
END;
$$;

-- Same answers as redeem_invite.
CREATE OR REPLACE FUNCTION public.join_public_server(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_public boolean;
    v_local boolean;
    v_status text;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT s.public, s.is_local_server INTO v_public, v_local
      FROM public.servers s WHERE s.id = p_server_id;
    IF v_public IS NOT TRUE OR v_local IS NOT TRUE THEN
        RAISE EXCEPTION 'SERVER_NOT_PUBLIC: this server is joined through an invite'
            USING ERRCODE = '42501';
    END IF;

    SELECT us.status INTO v_status
      FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = v_me;

    IF v_status = 'accepted' THEN
        RETURN jsonb_build_object('server_id', p_server_id, 'joined', false);
    END IF;
    IF v_status = 'banned' OR EXISTS (
            SELECT 1 FROM public.server_bans b WHERE b.server_id = p_server_id AND b.user_id = v_me) THEN
        RAISE EXCEPTION 'BANNED_FROM_SERVER: this account is banned from the server'
            USING ERRCODE = '42501';
    END IF;

    IF v_status IS NULL THEN
        INSERT INTO public.user_servers (server_id, user_id, status)
        VALUES (p_server_id, v_me, 'accepted');
    ELSE
        UPDATE public.user_servers SET status = 'accepted'
         WHERE server_id = p_server_id AND user_id = v_me;
    END IF;

    RETURN jsonb_build_object('server_id', p_server_id, 'joined', true);
END;
$$;

-- status: valid, not_found, exhausted, revoked, expired. Server fields only when valid.
CREATE OR REPLACE FUNCTION public.get_invite_preview(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row record;
    v_count bigint;
BEGIN
    SELECT i.code, i.server_id, i.used, i.expires_at, i.max_uses, COALESCE(i.uses, 0) AS uses,
           s.name, s.description, s.icon, s.banner, s.rules, s.is_local_server
      INTO v_row
      FROM public.invites i
      JOIN public.servers s ON s.id = i.server_id
     WHERE i.code = p_code;

    IF NOT FOUND OR v_row.is_local_server IS NOT TRUE THEN
        RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF COALESCE(v_row.max_uses, 0) > 0 AND v_row.uses >= v_row.max_uses THEN
        RETURN jsonb_build_object('status', 'exhausted');
    END IF;
    IF v_row.used IS TRUE THEN
        RETURN jsonb_build_object('status', 'revoked');
    END IF;
    IF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
        RETURN jsonb_build_object('status', 'expired');
    END IF;

    SELECT count(*) INTO v_count
      FROM public.user_servers us
     WHERE us.server_id = v_row.server_id AND us.status = 'accepted';

    RETURN jsonb_build_object(
        'status', 'valid',
        'code', v_row.code,
        'server_id', v_row.server_id,
        'name', v_row.name,
        'description', v_row.description,
        'icon', v_row.icon,
        'banner', v_row.banner,
        'rules', COALESCE(v_row.rules, '[]'::jsonb),
        'member_count', v_count,
        'expires_at', v_row.expires_at,
        'is_member', v_me IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.user_servers us
             WHERE us.server_id = v_row.server_id AND us.user_id = v_me AND us.status = 'accepted'));
END;
$$;

CREATE OR REPLACE FUNCTION public.add_server_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.user_servers (server_id, user_id, status)
    VALUES (NEW.id, NEW.owner, 'accepted')
    ON CONFLICT (user_id, server_id) DO NOTHING;
    RETURN NULL;
END;
$$;

-- Client-created local servers only: service_role and definer callers write their own
-- memberships. The WHEN clause reads current_user before the definer function runs.
-- AFTER INSERT triggers fire in name order; the default role exists before this one, so
-- assign_default_role_to_member gives the owner @everyone.
DROP TRIGGER IF EXISTS trigger_server_owner_membership ON public.servers;
CREATE TRIGGER trigger_server_owner_membership
    AFTER INSERT ON public.servers
    FOR EACH ROW
    WHEN (NEW.is_local_server IS NOT FALSE AND NEW.owner IS NOT NULL
          AND current_user IN ('authenticated', 'anon'))
    EXECUTE FUNCTION public.add_server_owner_membership();

CREATE OR REPLACE FUNCTION public.guard_invite_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.uses := 0;
        NEW.used := false;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - 'used') IS DISTINCT FROM (to_jsonb(OLD) - 'used')
       OR (OLD.used IS TRUE AND NEW.used IS NOT TRUE) THEN
        RAISE EXCEPTION 'an invite can only be revoked' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_invites_client_write_guard ON public.invites;
CREATE TRIGGER a_invites_client_write_guard
    BEFORE INSERT OR UPDATE ON public.invites
    FOR EACH ROW EXECUTE FUNCTION public.guard_invite_client_write();

-- ---------------------------------------------------------------------------
-- Member counts and invite lookup
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_server_member_counts(p_server_ids uuid[])
RETURNS TABLE(server_id uuid, member_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH visible AS (
    SELECT s.id
      FROM public.servers s
     WHERE s.id = ANY(p_server_ids)
       AND (s.public IS TRUE
            OR s.owner = public.get_current_profile_id()
            OR s.id IN (SELECT public.current_user_server_ids())
            OR public.is_current_user_admin())
  ),
  counts AS (
    SELECT us.server_id, COUNT(*)::bigint AS cnt
      FROM public.user_servers us
     WHERE us.server_id IN (SELECT v.id FROM visible v)
     GROUP BY us.server_id
  )
  SELECT id AS server_id, COALESCE(c.cnt, 0) AS member_count
    FROM unnest(p_server_ids) AS id
    LEFT JOIN counts c ON c.server_id = id;
$$;

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('consume_invite', 'redeem_invite', 'join_public_server',
                             'get_invite_preview', 'add_server_owner_membership',
                             'guard_invite_client_write', 'lookup_invite_by_code',
                             'get_server_member_counts')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_invite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_public_server(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_member_counts(uuid[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invite_preview(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Policies replaced below are removed by command, whatever their name on this instance.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND ((p.tablename = 'servers' AND p.cmd = 'SELECT')
             OR (p.tablename = 'user_servers' AND p.cmd = 'INSERT')
             OR (p.tablename = 'channel_categories' AND p.cmd IN ('SELECT', 'UPDATE'))
             OR (p.tablename = 'server_roles' AND p.cmd = 'SELECT')
             OR (p.tablename = 'user_roles' AND p.cmd = 'SELECT')
             OR (p.tablename = 'invites' AND p.cmd = 'INSERT'))
           AND p.policyname NOT IN ('servers_select_public', 'servers_select_member',
                                    'user_servers_insert_owner',
                                    'channel_categories_select_member', 'channel_categories_update_manager',
                                    'server_roles_select_member', 'user_roles_select_member',
                                    'invites_insert_member')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
        RAISE NOTICE 'dropped policy % on %', r.policyname, r.tablename;
    END LOOP;
END;
$$;

-- Member-scoped policies are TO authenticated: anon holds no EXECUTE on
-- current_user_server_ids and reads public servers only.
DROP POLICY IF EXISTS servers_select_public ON public.servers;
CREATE POLICY servers_select_public ON public.servers FOR SELECT
    USING (servers.public IS TRUE);

DROP POLICY IF EXISTS servers_select_member ON public.servers;
CREATE POLICY servers_select_member ON public.servers FOR SELECT TO authenticated
    USING (servers.owner = (SELECT public.get_current_profile_id())
           OR servers.id IN (SELECT public.current_user_server_ids())
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS user_servers_insert_owner ON public.user_servers;
CREATE POLICY user_servers_insert_owner ON public.user_servers FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT public.get_current_profile_id())
                AND EXISTS (SELECT 1 FROM public.servers s
                             WHERE s.id = user_servers.server_id
                               AND s.owner = (SELECT public.get_current_profile_id())));

DROP POLICY IF EXISTS channel_categories_select_member ON public.channel_categories;
CREATE POLICY channel_categories_select_member ON public.channel_categories FOR SELECT TO authenticated
    USING (server_id IN (SELECT public.current_user_server_ids())
           OR EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = channel_categories.server_id
                         AND s.owner = (SELECT public.get_current_profile_id()))
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS channel_categories_update_manager ON public.channel_categories;
CREATE POLICY channel_categories_update_manager ON public.channel_categories FOR UPDATE
    USING (EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = channel_categories.server_id
                      AND s.owner = (SELECT public.get_current_profile_id()))
           OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS')
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS server_roles_select_member ON public.server_roles;
CREATE POLICY server_roles_select_member ON public.server_roles FOR SELECT TO authenticated
    USING (server_id IN (SELECT public.current_user_server_ids())
           OR EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = server_roles.server_id
                         AND s.owner = (SELECT public.get_current_profile_id()))
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS user_roles_select_member ON public.user_roles;
CREATE POLICY user_roles_select_member ON public.user_roles FOR SELECT TO authenticated
    USING (user_id = (SELECT public.get_current_profile_id())
           OR server_id IN (SELECT public.current_user_server_ids())
           OR EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = user_roles.server_id
                         AND s.owner = (SELECT public.get_current_profile_id()))
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS invites_insert_member ON public.invites;
CREATE POLICY invites_insert_member ON public.invites FOR INSERT TO authenticated
    WITH CHECK (created_by = (SELECT public.get_current_profile_id())
                AND EXISTS (SELECT 1 FROM public.user_servers us
                             WHERE us.server_id = invites.server_id
                               AND us.user_id = (SELECT public.get_current_profile_id())
                               AND us.status = 'accepted')
                AND public.has_permission((SELECT public.get_current_profile_id()), server_id, 'CREATE_INVITE'));

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_post_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'is_local', 'ap_id', 'ap_type', 'url', 'created_at', 'replies_count',
        'reblogs_count', 'favorites_count', 'federation_status', 'federated_to',
        'last_federated_at', 'reblog', 'reblog_author', 'in_reply_to', 'conversation_id',
        'conversation_root_id', 'edit_history'];
    v_boost_copied CONSTANT text[] := ARRAY[
        'content', 'visibility', 'content_warning', 'is_sensitive', 'media_attachments'];
    v_boost_keys CONSTANT text[] := ARRAY[
        'reblog_of', 'original_author', 'is_quote', 'quote_ap_url', 'in_reply_to_ap_url'];
    v_meta jsonb;
    v_old jsonb;
    v_keep jsonb;
    v_key text;
    v_target uuid;
    v_is_quote boolean;
    v_orig public.posts%ROWTYPE;
    v_parent public.posts%ROWTYPE;
    v_author jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote posts arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.ap_id IS NOT NULL
           AND NEW.ap_id !~ '^https://[^/]+/activities/[0-9a-fA-F-]{36}$' THEN
            RAISE EXCEPTION 'ap_id is assigned by the server' USING ERRCODE = '42501';
        END IF;
        IF NEW.url IS NOT NULL THEN
            RAISE EXCEPTION 'url is assigned by the server' USING ERRCODE = '42501';
        END IF;

        IF v_meta ? 'reblog_of' THEN
            BEGIN
                v_target := (v_meta ->> 'reblog_of')::uuid;
            EXCEPTION WHEN invalid_text_representation THEN
                v_target := NULL;
            END;
            v_is_quote := COALESCE(v_meta -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false);

            -- Read under the caller's RLS: a post the caller cannot see is absent.
            SELECT p.* INTO v_orig FROM public.posts p WHERE p.id = v_target;
            IF NOT FOUND OR v_orig.is_deleted IS TRUE THEN
                RAISE EXCEPTION 'REBLOG_TARGET_NOT_FOUND: post not found' USING ERRCODE = 'P0002';
            END IF;
            IF v_orig.visibility IS NULL OR v_orig.visibility NOT IN ('public', 'unlisted') THEN
                RAISE EXCEPTION 'REBLOG_NOT_ALLOWED: only public and unlisted posts are boosted or quoted'
                    USING ERRCODE = '42501';
            END IF;
            IF v_orig.metadata ? 'reblog_of'
               AND NOT COALESCE(v_orig.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false) THEN
                RAISE EXCEPTION 'REBLOG_NOT_ALLOWED: a boost is boosted through its original post'
                    USING ERRCODE = '42501';
            END IF;
            IF NOT v_is_quote AND EXISTS (
                    SELECT 1 FROM public.posts b
                     WHERE b.author_id = NEW.author_id
                       AND b.metadata ->> 'reblog_of' = v_orig.id::text
                       AND b.is_deleted IS NOT TRUE
                       AND NOT COALESCE(b.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false)) THEN
                RAISE EXCEPTION 'Post already reblogged' USING ERRCODE = '23505';
            END IF;

            SELECT jsonb_build_object(
                       'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                       'avatar_url', pr.avatar_url,
                       'domain', COALESCE(pr.domain, current_setting('app.domain', true)),
                       'handle', CASE WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                                      ELSE '@' || pr.username || '@' || pr.domain END,
                       'is_local', COALESCE(pr.is_local, true))
              INTO v_author
              FROM public.profiles pr WHERE pr.id = v_orig.author_id;

            NEW.reblog := jsonb_build_object(
                'id', v_orig.id,
                'content', v_orig.content,
                'created_at', v_orig.created_at,
                'author', v_author,
                'visibility', v_orig.visibility,
                'favorites_count', COALESCE(v_orig.favorites_count, 0),
                'reblogs_count', COALESCE(v_orig.reblogs_count, 0),
                'replies_count', COALESCE(v_orig.replies_count, 0),
                'media_attachments', COALESCE(v_orig.media_attachments, '[]'::jsonb),
                'content_warning', v_orig.content_warning,
                'is_sensitive', COALESCE(v_orig.is_sensitive, false),
                'url', v_orig.url,
                'in_reply_to', v_orig.in_reply_to);
            NEW.reblog_author := v_author;
            NEW.ap_type := 'Announce';
            NEW.in_reply_to := NULL;
            NEW.conversation_id := v_orig.conversation_id;
            NEW.conversation_root_id := COALESCE(v_orig.conversation_root_id, v_orig.id);
            NEW.metadata := (v_meta - v_boost_keys)
                || jsonb_build_object('reblog_of', v_orig.id, 'original_author', v_orig.author_id)
                || CASE WHEN v_is_quote THEN '{"is_quote": true}'::jsonb ELSE '{}'::jsonb END;
            IF NOT v_is_quote THEN
                NEW.content := v_orig.content;
                NEW.visibility := v_orig.visibility;
                NEW.content_warning := v_orig.content_warning;
                NEW.is_sensitive := COALESCE(v_orig.is_sensitive, false);
                NEW.media_attachments := '[]'::jsonb;
            END IF;
        ELSE
            IF NEW.reblog IS NOT NULL OR NEW.reblog_author IS NOT NULL
               OR NEW.ap_type = 'Announce' OR v_meta ?| v_boost_keys THEN
                RAISE EXCEPTION 'boost fields are set by the server' USING ERRCODE = '42501';
            END IF;
            NEW.ap_type := 'Note';
            IF NEW.in_reply_to IS NOT NULL THEN
                SELECT p.* INTO v_parent FROM public.posts p WHERE p.id = NEW.in_reply_to;
                IF NOT FOUND OR v_parent.is_deleted IS TRUE THEN
                    RAISE EXCEPTION 'REPLY_TARGET_NOT_FOUND: post not found' USING ERRCODE = 'P0002';
                END IF;
                NEW.conversation_id := v_parent.conversation_id;
                NEW.conversation_root_id := COALESCE(v_parent.conversation_root_id, v_parent.id);
            ELSE
                NEW.conversation_id := NULL;
                NEW.conversation_root_id := NULL;
            END IF;
        END IF;

        NEW.created_at := now();
        NEW.replies_count := 0;
        NEW.reblogs_count := 0;
        NEW.favorites_count := 0;
        NEW.federated_to := NULL;
        NEW.last_federated_at := NULL;
        NEW.edit_history := '[]'::jsonb;
        NEW.is_deleted := false;
        NEW.deleted_at := NULL;
        RETURN NEW;
    END IF;

    IF OLD.is_deleted IS TRUE AND NEW.is_deleted IS NOT TRUE THEN
        RAISE EXCEPTION 'a deleted post cannot be restored' USING ERRCODE = '42501';
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed || CASE
                    WHEN OLD.metadata ? 'reblog_of'
                         AND NOT COALESCE(OLD.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false)
                    THEN v_boost_copied ELSE ARRAY[]::text[] END) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;

    v_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;
    FOREACH v_key IN ARRAY v_boost_keys LOOP
        IF v_meta -> v_key IS DISTINCT FROM OLD.metadata -> v_key THEN
            v_meta := CASE WHEN OLD.metadata ? v_key
                           THEN v_meta || jsonb_build_object(v_key, OLD.metadata -> v_key)
                           ELSE v_meta - v_key END;
        END IF;
    END LOOP;
    IF v_meta IS DISTINCT FROM NEW.metadata THEN
        NEW.metadata := v_meta;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_post_client_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.derive_display_name_emojis()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_base jsonb := '{}'::jsonb;
    v_allowed boolean;
    v_emojis jsonb := '[]'::jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
            NEW.federation_metadata := OLD.federation_metadata;
            RETURN NEW;
        END IF;
        IF jsonb_typeof(OLD.federation_metadata) = 'object' THEN
            v_base := OLD.federation_metadata;
        ELSIF jsonb_typeof(OLD.federation_metadata) = 'string' THEN
            -- Rows written as a JSON-encoded string by older federation code.
            BEGIN
                v_base := (OLD.federation_metadata #>> '{}')::jsonb;
                IF jsonb_typeof(v_base) IS DISTINCT FROM 'object' THEN
                    v_base := '{}'::jsonb;
                END IF;
            EXCEPTION WHEN invalid_text_representation THEN
                v_base := '{}'::jsonb;
            END;
        END IF;
    END IF;

    SELECT NOT (c.config_value IN ('false'::jsonb, '"false"'::jsonb)) INTO v_allowed
      FROM public.instance_config c
     WHERE c.config_key = 'allow_custom_emojis_in_display_names';

    IF COALESCE(v_allowed, true) AND NEW.display_name IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('name', e.name, 'url', e.url, 'id', e.id)
                                  ORDER BY codes.first_at), '[]'::jsonb)
          INTO v_emojis
          FROM (SELECT r.match[1] AS code, min(r.at) AS first_at
                  FROM regexp_matches(NEW.display_name, ':([a-zA-Z0-9_+-]+):', 'g')
                       WITH ORDINALITY AS r(match, at)
                 GROUP BY r.match[1]) codes
          JOIN LATERAL (
                SELECT em.id, em.name, em.url
                  FROM public.emojis em
                 WHERE em.name = codes.code AND em.url IS NOT NULL AND em.url <> ''
                 ORDER BY (em.scope = 'instance') DESC, (em.domain IS NULL) DESC, em.created_at, em.id
                 LIMIT 1) e ON true;
    END IF;

    NEW.federation_metadata := v_base || jsonb_build_object('display_name_emojis', v_emojis);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.derive_display_name_emojis() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_profiles_display_name_emojis ON public.profiles;
CREATE TRIGGER a_profiles_display_name_emojis
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.derive_display_name_emojis();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_message_reply_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
    v_conversation uuid;
BEGIN
    IF NEW.reply_to IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.reply_to IS NOT DISTINCT FROM OLD.reply_to
       AND NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id
       AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id THEN
        RETURN NEW;
    END IF;

    SELECT m.channel_id, m.conversation_id INTO v_channel, v_conversation
      FROM public.messages m WHERE m.id = NEW.reply_to;
    IF NOT FOUND
       OR v_channel IS DISTINCT FROM NEW.channel_id
       OR v_conversation IS DISTINCT FROM NEW.conversation_id THEN
        RAISE EXCEPTION 'REPLY_OUT_OF_SCOPE: a reply names a message in the same channel or conversation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_message_reply_scope() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_reply_scope ON public.messages;
CREATE TRIGGER a_messages_reply_scope
    BEFORE INSERT OR UPDATE OF reply_to, channel_id, conversation_id ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.enforce_message_reply_scope();

-- Other changes to a system row are refused by guard_message_client_write().
CREATE OR REPLACE FUNCTION public.guard_system_message_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
    v_server uuid;
    v_allowed boolean;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1
       OR OLD.is_system IS NOT TRUE
       OR (TG_OP = 'UPDATE' AND NOT (OLD.is_deleted IS NOT TRUE AND NEW.is_deleted IS TRUE)) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    v_me := public.get_current_profile_id();
    IF OLD.channel_id IS NOT NULL THEN
        SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = OLD.channel_id;
        v_allowed := v_server IS NOT NULL
                     AND public.has_permission(v_me, v_server, 'MANAGE_MESSAGES', OLD.channel_id);
    ELSE
        v_allowed := EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = OLD.conversation_id
               AND cp.user_id = v_me
               AND cp.role = 'admin'
               AND cp.left_at IS NULL);
    END IF;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'SYSTEM_MESSAGE_PROTECTED: system messages are removed by moderators'
            USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_system_message_removal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_system_row_guard ON public.messages;
CREATE TRIGGER a_messages_system_row_guard
    BEFORE UPDATE OF is_deleted OR DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_system_message_removal();

-- ---------------------------------------------------------------------------
-- channels and categories
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_channel_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY['ap_id', 'is_remote', 'federation_status', 'created_at'];
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.ap_id IS NOT NULL OR NEW.is_remote IS TRUE THEN
            RAISE EXCEPTION 'remote channels arrive through federation' USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'a channel stays in its server' USING ERRCODE = '42501';
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_channel_client_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_channel_category_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.category IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.channel_categories cc
             WHERE cc.id = NEW.category AND cc.server_id = NEW.server_id) THEN
        RAISE EXCEPTION 'CATEGORY_OUT_OF_SCOPE: a channel''s category belongs to its server'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_channel_category_scope() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_channels_category_scope ON public.channels;
CREATE TRIGGER a_channels_category_scope
    BEFORE INSERT OR UPDATE OF category, server_id ON public.channels
    FOR EACH ROW EXECUTE FUNCTION public.enforce_channel_category_scope();

CREATE OR REPLACE FUNCTION public.guard_category_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'a category stays in its server' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_category_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_channel_categories_client_write_guard ON public.channel_categories;
CREATE TRIGGER a_channel_categories_client_write_guard
    BEFORE UPDATE ON public.channel_categories
    FOR EACH ROW EXECUTE FUNCTION public.guard_category_client_write();

-- Pairs that predate enforce_channel_category_scope() are reported, not changed.
DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count
      FROM public.channels c
      JOIN public.channel_categories cc ON cc.id = c.category
     WHERE cc.server_id IS DISTINCT FROM c.server_id;
    IF v_count > 0 THEN
        RAISE NOTICE 'channels: % row(s) name a category of another server', v_count;
    END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
