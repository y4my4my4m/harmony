-- Client writes that name another entity: a thread's author, channel and federation id, a
-- conversation row, the inbound dedupe ledger, a remote identity, a bot's installer, and a
-- reaction on a post the caller cannot read. Permission lookups answer for the caller, or for
-- a member of a server the caller is in.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------

-- threads.created_by picks the key that signs the federated Update (threadHandler.ts).
CREATE OR REPLACE FUNCTION public.guard_thread_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM public.messages m
                        WHERE m.id = NEW.parent_message_id AND m.channel_id = NEW.channel_id) THEN
            RAISE EXCEPTION 'a thread starts from a message of its channel' USING ERRCODE = '42501';
        END IF;
        NEW.ap_id := NULL;
        NEW.federation_status := 'pending';
        NEW.message_count := 0;
        NEW.member_count := 0;
        NEW.last_message_id := NULL;
        NEW.last_message_at := NULL;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['name', 'archived', 'archived_at', 'locked', 'auto_archive_duration', 'updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['name', 'archived', 'archived_at', 'locked', 'auto_archive_duration', 'updated_at']) THEN
        RAISE EXCEPTION 'a client changes only a thread''s name, archive state, lock and archive duration'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_thread_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_threads_client_write_guard ON public.threads;
CREATE TRIGGER a_threads_client_write_guard
    BEFORE INSERT OR UPDATE ON public.threads
    FOR EACH ROW EXECUTE FUNCTION public.guard_thread_client_write();

-- ---------------------------------------------------------------------------
-- Conversation membership
-- ---------------------------------------------------------------------------

-- The UPDATE policy constrains user_id only. Without this a row moves into any conversation; only
-- safeupdate and the SELECT policy on the new row refuse that over PostgREST.
CREATE OR REPLACE FUNCTION public.guard_conversation_participant_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'a participant row stays with its conversation and user' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_conversation_participant_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_conversation_participants_client_write_guard ON public.conversation_participants;
CREATE TRIGGER a_conversation_participants_client_write_guard
    BEFORE UPDATE ON public.conversation_participants
    FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_participant_client_write();

-- ---------------------------------------------------------------------------
-- Inbound dedupe ledger
-- ---------------------------------------------------------------------------

-- ap_activities.ap_id is the inbox's dedupe key: a client row drops the real delivery.
DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities;
DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities;
REVOKE INSERT, UPDATE, DELETE ON public.ap_activities FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Functions no client calls
-- ---------------------------------------------------------------------------

-- insert_ap_activity_outbound writes the same ledger. create_federated_profile takes a remote
-- identity from the caller; /lookup-user resolves accounts server-side. get_default_channel names
-- a channel of a private server; its callers are definers. By name: live instances carry overloads.
DO $$
DECLARE
    f regprocedure;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('insert_ap_activity_outbound', 'create_federated_profile', 'get_default_channel')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permission lookups
-- ---------------------------------------------------------------------------

-- Definers keep role = authenticated, so this also runs for internal calls under a client session:
-- moderation and role checks hold it through the caller's membership.
CREATE OR REPLACE FUNCTION public.caller_reads_member_standing(p_user_id uuid, p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
        OR p_user_id IS NOT DISTINCT FROM public.get_current_profile_id()
        OR EXISTS (SELECT 1 FROM public.user_servers me
                    WHERE me.user_id = public.get_current_profile_id()
                      AND me.server_id = p_server_id
                      AND me.status = 'accepted')
        OR EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.owner = public.get_current_profile_id())
        OR EXISTS (SELECT 1 FROM public.profiles me
                    WHERE me.id = public.get_current_profile_id()
                      AND (me.is_admin IS TRUE OR me.is_moderator IS TRUE));
$$;

REVOKE ALL ON FUNCTION public.caller_reads_member_standing(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_user_permissions(p_user_id uuid, p_server_id uuid, p_channel_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_names text[] := public.permission_bit_names();
    v_copy_bits CONSTANT bigint := 3344953346;
    v_is_owner boolean;
    v_is_copy boolean;
    v_mask bigint := 0;
    v_role record;
    v_override record;
    v_everyone_role_id uuid;
    v_everyone_allow bigint := 0;
    v_everyone_deny  bigint := 0;
    v_role_allow     bigint := 0;
    v_role_deny      bigint := 0;
    v_user_allow     bigint := 0;
    v_user_deny      bigint := 0;
    v_result jsonb := '{}'::jsonb;
    v_i int;
BEGIN
    IF NOT public.caller_reads_member_standing(p_user_id, p_server_id) THEN
        RETURN '{}'::jsonb;
    END IF;
    IF p_channel_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.channels c WHERE c.id = p_channel_id AND c.server_id = p_server_id
    ) THEN
        RETURN '{}'::jsonb;
    END IF;

    SELECT s.owner = p_user_id AND s.is_local_server, NOT s.is_local_server
      INTO v_is_owner, v_is_copy
      FROM public.servers s WHERE s.id = p_server_id;

    IF v_is_owner THEN
        v_mask := -1;
    ELSIF EXISTS (SELECT 1 FROM public.user_servers us
                   WHERE us.user_id = p_user_id
                     AND us.server_id = p_server_id
                     AND us.status = 'accepted') THEN
        SELECT id, COALESCE(permissions, 0) INTO v_everyone_role_id, v_mask
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true
         LIMIT 1;
        v_mask := COALESCE(v_mask, 0);

        FOR v_role IN
            SELECT sr.permissions
              FROM public.user_roles ur
              JOIN public.server_roles sr ON ur.role_id = sr.id
             WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
        LOOP
            v_mask := v_mask | COALESCE(v_role.permissions, 0);
        END LOOP;

        IF v_is_copy THEN
            v_mask := v_mask & v_copy_bits;
        END IF;

        IF (v_mask & 1) != 0 THEN
            v_mask := -1;
        ELSIF p_channel_id IS NOT NULL THEN
            FOR v_override IN
                SELECT role_id, user_id,
                       COALESCE(allow_permissions, 0) AS allow_p,
                       COALESCE(deny_permissions, 0)  AS deny_p
                  FROM public.channel_permission_overrides
                 WHERE channel_id = p_channel_id
                   AND (
                        role_id = v_everyone_role_id
                     OR role_id IN (
                            SELECT ur.role_id
                              FROM public.user_roles ur
                             WHERE ur.user_id = p_user_id
                               AND ur.server_id = p_server_id
                        )
                     OR user_id = p_user_id
                   )
            LOOP
                IF v_override.user_id = p_user_id THEN
                    v_user_allow := v_user_allow | v_override.allow_p;
                    v_user_deny  := v_user_deny  | v_override.deny_p;
                ELSIF v_override.role_id = v_everyone_role_id THEN
                    v_everyone_allow := v_everyone_allow | v_override.allow_p;
                    v_everyone_deny  := v_everyone_deny  | v_override.deny_p;
                ELSIF v_override.role_id IS NOT NULL THEN
                    v_role_allow := v_role_allow | v_override.allow_p;
                    v_role_deny  := v_role_deny  | v_override.deny_p;
                END IF;
            END LOOP;

            v_mask := (v_mask & ~v_everyone_deny) | v_everyone_allow;
            v_mask := (v_mask & ~v_role_deny) | v_role_allow;
            v_mask := (v_mask & ~v_user_deny) | v_user_allow;

            IF (v_mask & 2) = 0 THEN
                v_mask := 0;
            END IF;
        END IF;

        IF v_is_copy THEN
            v_mask := v_mask & v_copy_bits;
        END IF;
    END IF;

    FOR v_i IN 1..array_length(v_names, 1) LOOP
        v_result := v_result || jsonb_build_object(
            v_names[v_i],
            (v_mask & (1::bigint << (v_i - 1))) != 0
        );
    END LOOP;

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_highest_role_position(p_user_id uuid, p_server_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_is_owner boolean;
    v_max_position integer;
BEGIN
    IF NOT public.caller_reads_member_standing(p_user_id, p_server_id) THEN
        RETURN 0;
    END IF;

    SELECT (owner = p_user_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF v_is_owner THEN
        RETURN 2147483647;
    END IF;

    SELECT COALESCE(MAX(sr.position), 0) INTO v_max_position
    FROM public.user_roles ur
    JOIN public.server_roles sr ON sr.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND ur.server_id = p_server_id;

    RETURN v_max_position;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Bot installs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_bot_permission_grants()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.server_id IS DISTINCT FROM OLD.server_id OR NEW.bot_id IS DISTINCT FROM OLD.bot_id) THEN
        RAISE EXCEPTION 'an installation stays with its bot and server' USING ERRCODE = '42501';
    END IF;
    -- installed_by sets the bot's rank cap for role edits (bot-gateway botPermissions).
    IF TG_OP = 'INSERT' THEN
        NEW.installed_by := public.get_current_profile_id();
    ELSIF NEW.installed_by IS DISTINCT FROM OLD.installed_by THEN
        RAISE EXCEPTION 'an installation keeps its installer' USING ERRCODE = '42501';
    END IF;
    -- allowed_channel_ids grants VIEW_CHANNEL past @everyone's deny; set_bot_allowed_channels
    -- checks each channel against the caller's own view and is its only client writer.
    IF (TG_OP = 'INSERT' AND NEW.allowed_channel_ids IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.allowed_channel_ids IS DISTINCT FROM OLD.allowed_channel_ids) THEN
        RAISE EXCEPTION 'allowed_channel_ids is set through set_bot_allowed_channels' USING ERRCODE = '42501';
    END IF;
    PERFORM public.assert_grantable_bot_flags(NEW.server_id, to_jsonb(NEW),
                                              CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END);
    RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

-- A definer sees every post, so RLS cannot answer this inside one. Mirrors posts_select_public.
CREATE OR REPLACE FUNCTION public.current_user_reads_post(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.posts
         WHERE posts.id = p_post_id
           AND ((author_id = ( SELECT get_current_profile_id() AS get_current_profile_id)) OR ((NOT (author_id IN ( SELECT current_user_block_peer_ids() AS current_user_block_peer_ids))) AND ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((visibility = 'followers'::text) AND (EXISTS ( SELECT 1
   FROM follows
  WHERE ((follows.follower_id = ( SELECT get_current_profile_id() AS get_current_profile_id)) AND (follows.following_id = posts.author_id) AND (follows.status = 'accepted'::text))))) OR ((visibility = ANY (ARRAY['followers'::text, 'direct'::text])) AND (EXISTS ( SELECT 1
   FROM jsonb_array_elements(posts.content) part(value)
  WHERE (((part.value ->> 'type'::text) = 'mention'::text) AND ((part.value ->> 'isLocal'::text) = 'true'::text) AND ((part.value ->> 'username'::text) = ( SELECT current_profile_username() AS current_profile_username)))))))))
    );
$$;

REVOKE ALL ON FUNCTION public.current_user_reads_post(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_interaction_id uuid;
    v_resolved_content text;
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create reactions as another user';
    END IF;

    IF NOT public.current_user_reads_post(p_post_id) THEN
        RAISE EXCEPTION 'Post not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;

    -- Auto-populate custom_emoji_content from emoji table when missing
    v_resolved_content := p_custom_emoji_content;
    IF p_emoji_id IS NOT NULL AND v_resolved_content IS NULL THEN
        SELECT CASE
            WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
            ELSE e.name
        END INTO v_resolved_content
        FROM emojis e WHERE e.id = p_emoji_id;
    END IF;

    -- The heart is the caller's favourite (is_heart_reaction), made explicit when a reaction
    -- implied it. Idempotent, as below.
    IF public.is_heart_reaction(v_resolved_content) THEN
        UPDATE post_interactions
           SET implied_by_reaction = false
         WHERE user_id = p_user_id
           AND post_id = p_post_id
           AND interaction_type = 'favorite'
        RETURNING id INTO v_interaction_id;

        IF v_interaction_id IS NOT NULL THEN
            RETURN v_interaction_id;
        END IF;

        BEGIN
            INSERT INTO post_interactions (user_id, post_id, interaction_type, is_local)
            VALUES (p_user_id, p_post_id, 'favorite', true)
            RETURNING id INTO v_interaction_id;
        EXCEPTION WHEN unique_violation THEN
            SELECT id INTO v_interaction_id
            FROM post_interactions
            WHERE user_id = p_user_id
              AND post_id = p_post_id
              AND interaction_type = 'favorite';
        END;

        RETURN v_interaction_id;
    END IF;

    -- Idempotent: an existing reaction is returned, not duplicated. A second row is a
    -- second count on the chip, and remove_post_emoji_reaction deletes every matching row
    -- in one statement.
    -- IS NOT DISTINCT FROM matches idx_post_interactions_emoji_unique, which is
    -- NULLS NOT DISTINCT: emoji_id is null on a unicode reaction, custom_emoji_content is
    -- null on a row written without one.
    SELECT id INTO v_interaction_id
    FROM post_interactions
    WHERE user_id = p_user_id
      AND post_id = p_post_id
      AND interaction_type = 'emoji_reaction'
      AND emoji_id IS NOT DISTINCT FROM p_emoji_id
      AND custom_emoji_content IS NOT DISTINCT FROM v_resolved_content
    ORDER BY created_at, id
    LIMIT 1;

    IF v_interaction_id IS NOT NULL THEN
        RETURN v_interaction_id;
    END IF;

    BEGIN
        INSERT INTO post_interactions (
            user_id, post_id, interaction_type,
            emoji_id, custom_emoji_content, is_local
        ) VALUES (
            p_user_id, p_post_id, 'emoji_reaction',
            p_emoji_id, v_resolved_content, true
        ) RETURNING id INTO v_interaction_id;
    EXCEPTION WHEN unique_violation THEN
        -- Concurrent caller committed the same reaction between the check and the insert.
        -- READ COMMITTED gives the re-read a fresh snapshot, so the winning row is visible.
        SELECT id INTO v_interaction_id
        FROM post_interactions
        WHERE user_id = p_user_id
          AND post_id = p_post_id
          AND interaction_type = 'emoji_reaction'
          AND emoji_id IS NOT DISTINCT FROM p_emoji_id
          AND custom_emoji_content IS NOT DISTINCT FROM v_resolved_content
        ORDER BY created_at, id
        LIMIT 1;
    END;

    RETURN v_interaction_id;
END;
$function$;

DROP POLICY IF EXISTS post_interactions_insert_own ON public.post_interactions;
CREATE POLICY post_interactions_insert_own ON public.post_interactions FOR INSERT
    WITH CHECK (user_id = (SELECT public.get_current_profile_id())
                AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_interactions.post_id)
                AND NOT public.is_blocked_by((SELECT posts.author_id FROM public.posts
                                               WHERE posts.id = post_interactions.post_id)));

-- Prod definers have mixed owners, postgres and supabase_admin. A definer runs as its owner, and a
-- non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT h.helper, pg_get_userbyid(p.proowner) AS owner
          FROM (VALUES
                  ('caller_reads_member_standing(uuid, uuid)', ARRAY['get_user_permissions', 'get_user_highest_role_position']),
                  ('current_user_reads_post(uuid)', ARRAY['add_post_emoji_reaction'])
               ) AS h(helper, callers)
          JOIN pg_proc p ON p.proname = ANY (h.callers) AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', r.helper, r.owner);
    END LOOP;
END
$$;

COMMIT;
