-- Application findings of the security audit, after 20261005900001.
--
-- Client caller. A statement whose role GUC is anon or authenticated: PostgREST sets it
-- with SET LOCAL ROLE, and SECURITY DEFINER changes current_user, not the GUC. Service
-- callers (federation-backend, bot-gateway as service_role; postgres; supabase_admin) are
-- never client callers.
--
-- Content parts. posts.content, messages.content and profiles.bio hold MessagePart arrays,
-- or JSON text of one. The web renderer turned a `system` part's event_type into HTML.
-- No server writer emits system parts; a client write that carries one is refused,
-- including through a definer RPC.
--
-- follows. A client INSERT starts pending unless the followed profile auto-accepts
-- (manually_approves_followers is not true) and the client asked for accepted; ap_id,
-- is_local, federation and timestamp fields are server-set. A client UPDATE changes only
-- status, by the followed side, from pending to accepted or rejected; accepted_at follows
-- status. Federation writes (service_role) are unchanged.
--
-- user_media. allowed_mime_types lists raster images, video, audio, the document and
-- archive types of the attachment picker, and application/octet-stream (a file the browser
-- cannot type). SVG, HTML, XML and script types are refused; objects already stored keep
-- their type.
--
-- instance_funding.kofi_webhook_token. Clients hold column privileges on every other
-- column; instance admins read and write the token through get_kofi_webhook_token() and
-- set_kofi_webhook_token(). The Ko-fi webhook reads it as service_role.
--
-- Definers that trusted a caller-supplied id now check client callers:
--   import_remote_emoji        instance scope: instance admin; server scope: server owner
--                              or instance admin
--   register_recovery_key      p_user_id is the caller's profile
--   get_federated_timeline     p_user_id is null or the caller's profile
--   get_unread_announcements   p_user_id is the caller's auth uid or profile id
--   get_admin_user_counts      instance admin
--   recompute_supporter_tier   instance admin
--   update_group_name, update_group_icon, remove_group_icon
--                              act as get_current_profile_id(); the argument is ignored
--   add_bot_to_server, is_room_member and the above lose anon EXECUTE;
--   can_manage_group_icon loses client EXECUTE.
--
-- is_room_member. A channel room admits can_view_channel(): an accepted member or the
-- owner, with VIEW_CHANNEL on a restricted channel. Banned and pending rows, and members
-- without VIEW_CHANNEL, no longer pass, so megolm_session_shares and key requests refuse
-- them. get_room_member_ids() lists the profiles that pass, for Megolm recipients. A
-- client megolm_session_shares row for a recipient outside the room is skipped, and an
-- update by the sender is held to the insert rule.
--
-- post_interactions. SELECT returns the caller's own rows, and other rows except bookmarks
-- on posts the caller can read (posts RLS). broadcast_post_interaction_event sends to
-- feed:user:<author> only for public and unlisted posts, and a bookmark only to the
-- bookmarker's user: topic.
--
-- voice_channel_participants. SELECT: own rows and rows of channels the caller can view.
-- INSERT and UPDATE: own row, in a channel the caller can view, with the channel's
-- server_id. is_profile_in_voice() answers whether a profile is in any voice channel.
--
-- session_meets_aal. A token whose session_id names no auth.sessions row does not meet
-- the assurance level, as enforce_request_assurance() already refuses it on PostgREST.
-- Storage and Realtime evaluate it through their RESTRICTIVE policies.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Content parts
-- ---------------------------------------------------------------------------

-- True when the value, or the JSON text it holds, is an array with an element whose type
-- is system. The web renderer parses one level of JSON text the same way.
CREATE OR REPLACE FUNCTION public.content_has_system_part(p_content jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v jsonb := p_content;
    v_text text;
BEGIN
    IF v IS NULL THEN
        RETURN false;
    END IF;

    IF jsonb_typeof(v) = 'string' THEN
        v_text := ltrim(v #>> '{}', E' \t\n\r');
        IF left(v_text, 1) <> '[' THEN
            RETURN false;
        END IF;
        BEGIN
            v := v_text::jsonb;
        EXCEPTION WHEN others THEN
            RETURN false;
        END;
    END IF;

    RETURN jsonb_typeof(v) = 'array' AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v) e
         WHERE jsonb_typeof(e) = 'object'
           AND lower(e ->> 'type') = 'system');
END;
$$;

CREATE OR REPLACE FUNCTION public.refuse_client_system_parts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_content jsonb;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated') THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'profiles' THEN
        IF TG_OP = 'UPDATE' AND NEW.bio IS NOT DISTINCT FROM OLD.bio THEN
            RETURN NEW;
        END IF;
        v_content := to_jsonb(NEW.bio);
    ELSE
        IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
            RETURN NEW;
        END IF;
        v_content := to_jsonb(NEW.content);
    END IF;

    IF public.content_has_system_part(v_content) THEN
        RAISE EXCEPTION 'SYSTEM_PART_FORBIDDEN: system content parts are server-generated'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_posts_system_part_guard ON public.posts;
CREATE TRIGGER a_posts_system_part_guard
    BEFORE INSERT OR UPDATE OF content ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.refuse_client_system_parts();

DROP TRIGGER IF EXISTS a_messages_system_part_guard ON public.messages;
CREATE TRIGGER a_messages_system_part_guard
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.refuse_client_system_parts();

DROP TRIGGER IF EXISTS a_profiles_system_part_guard ON public.profiles;
CREATE TRIGGER a_profiles_system_part_guard
    BEFORE INSERT OR UPDATE OF bio ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.refuse_client_system_parts();

-- ---------------------------------------------------------------------------
-- follows
-- ---------------------------------------------------------------------------

-- Sorts before trigger_federate_follow and trigger_federate_follow_response, which copy
-- NEW.status into the federation job.
CREATE OR REPLACE FUNCTION public.guard_follow_client_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid;
    v_manual boolean;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
       OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT p.manually_approves_followers INTO v_manual
          FROM public.profiles p
         WHERE p.id = NEW.following_id;

        IF v_manual IS TRUE OR NEW.status IS DISTINCT FROM 'accepted' THEN
            NEW.status := 'pending';
        END IF;
        NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN now() END;
        NEW.ap_id := NULL;
        NEW.is_local := true;
        NEW.federation_status := 'pending';
        NEW.created_at := now();
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.follower_id IS DISTINCT FROM OLD.follower_id
       OR NEW.following_id IS DISTINCT FROM OLD.following_id
       OR NEW.ap_id IS DISTINCT FROM OLD.ap_id
       OR NEW.is_local IS DISTINCT FROM OLD.is_local
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.federation_status IS DISTINCT FROM OLD.federation_status
       OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        RAISE EXCEPTION 'follow participants and federation fields are fixed'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS NULL OR OLD.following_id IS DISTINCT FROM v_caller THEN
            RAISE EXCEPTION 'only the followed account answers a follow request'
                USING ERRCODE = '42501';
        END IF;
        IF OLD.status IS DISTINCT FROM 'pending'
           OR COALESCE(NEW.status, '') NOT IN ('accepted', 'rejected') THEN
            RAISE EXCEPTION 'a pending follow request is answered with accepted or rejected'
                USING ERRCODE = '42501';
        END IF;
        NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN now() END;
    ELSE
        NEW.accepted_at := OLD.accepted_at;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_follows_client_write_guard ON public.follows;
CREATE TRIGGER a_follows_client_write_guard
    BEFORE INSERT OR UPDATE ON public.follows
    FOR EACH ROW EXECUTE FUNCTION public.guard_follow_client_write();

-- ---------------------------------------------------------------------------
-- user_media
-- ---------------------------------------------------------------------------

-- Inserts the baseline bucket where it is absent; an existing bucket keeps its public flag
-- and size limit.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('user_media', 'user_media', true, 52428800, ARRAY[
           'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif',
           'image/apng', 'image/bmp', 'image/heic', 'image/heif', 'image/tiff',
           'video/*', 'audio/*',
           'application/pdf', 'text/plain',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.oasis.opendocument.text',
           'application/zip', 'application/x-zip-compressed',
           'application/vnd.rar', 'application/x-rar-compressed',
           'application/x-7z-compressed', 'application/gzip', 'application/x-tar',
           'application/octet-stream'])
ON CONFLICT (id) DO UPDATE SET allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- instance_funding
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.instance_funding FROM anon;
REVOKE SELECT, INSERT, UPDATE ON public.instance_funding FROM authenticated;

DO $$
DECLARE
    v_col name;
BEGIN
    FOR v_col IN
        SELECT a.attname
          FROM pg_attribute a
         WHERE a.attrelid = 'public.instance_funding'::regclass
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND a.attname <> 'kofi_webhook_token'
    LOOP
        EXECUTE format('GRANT SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I) ON public.instance_funding TO authenticated',
                       v_col);
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_kofi_webhook_token()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT f.kofi_webhook_token FROM public.instance_funding f LIMIT 1);
END;
$$;

-- An empty token disables the webhook.
CREATE OR REPLACE FUNCTION public.set_kofi_webhook_token(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_token text := NULLIF(btrim(p_token), '');
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    -- pg-safeupdate refuses an UPDATE without WHERE on PostgREST connections.
    UPDATE public.instance_funding
       SET kofi_webhook_token = v_token,
           updated_at = now()
     WHERE true;
    IF NOT FOUND THEN
        INSERT INTO public.instance_funding (kofi_webhook_token) VALUES (v_token);
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Definers that trusted a caller-supplied id
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_remote_emoji(
    p_remote_emoji_id uuid,
    p_new_name text DEFAULT NULL::text,
    p_server_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  IF current_setting('role', true) IN ('anon', 'authenticated') THEN
    IF p_server_id IS NULL THEN
      IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins import instance emojis' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT public.is_current_user_admin() AND NOT EXISTS (
        SELECT 1 FROM public.servers s
         WHERE s.id = p_server_id AND s.owner = public.get_current_profile_id()) THEN
      RAISE EXCEPTION 'Only the server owner imports emojis into a server' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;

  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;

  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;

  v_name := COALESCE(p_new_name, v_remote.shortcode);

  -- domain IS NULL is a local emoji.
  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;

  INSERT INTO public.emojis (name, url, server_id, scope, domain)
  VALUES (v_name, v_remote.url, p_server_id,
          CASE WHEN p_server_id IS NULL THEN 'instance' ELSE 'server' END, NULL)
  RETURNING id INTO v_new_id;

  UPDATE public.remote_emojis_cache
     SET imported_as = v_new_id, imported_at = now()
   WHERE id = p_remote_emoji_id;

  RETURN v_new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_recovery_key(
    p_user_id uuid,
    p_verification_code text,
    p_word_count integer DEFAULT 12)
RETURNS recovery_key_metadata
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result public.recovery_key_metadata;
    v_caller uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS NULL OR p_user_id IS DISTINCT FROM v_caller THEN
            RAISE EXCEPTION 'A recovery key is registered for the caller only'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.recovery_key_metadata (user_id, verification_code, word_count, created_at)
    VALUES (p_user_id, p_verification_code, p_word_count, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
        verification_code = EXCLUDED.verification_code,
        word_count = EXCLUDED.word_count,
        key_version = recovery_key_metadata.key_version + 1
    RETURNING * INTO v_result;

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_federated_timeline(
    p_user_id uuid,
    p_limit integer DEFAULT 20,
    p_max_id text DEFAULT NULL::text)
RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone,
              content jsonb, content_warning text, language text, author_id text, ap_id text,
              ap_type text, url text, conversation_id text, visibility text, is_local boolean,
              is_federated boolean, replies_count integer, reblogs_count integer,
              favorites_count integer, media_attachments jsonb, metadata jsonb,
              is_sensitive boolean, author jsonb, is_favorited boolean, is_reblogged boolean,
              is_bookmarked boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND p_user_id IS NOT NULL
       AND p_user_id IS DISTINCT FROM public.get_current_profile_id() THEN
        RAISE EXCEPTION 'Interaction state is returned for the caller only'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        p.id::TEXT,
        p.created_at,
        p.updated_at,
        p.content,
        p.content_warning,
        p.language,
        p.author_id::TEXT,
        p.ap_id,
        p.ap_type,
        p.url,
        p.conversation_id::TEXT,
        p.visibility,
        p.is_local,
        p.is_federated,
        COALESCE(p.replies_count, 0)::INTEGER,
        COALESCE(p.reblogs_count, 0)::INTEGER,
        COALESCE(p.favorites_count, 0)::INTEGER,
        COALESCE(p.media_attachments, '[]'::jsonb),
        COALESCE(p.metadata, '{}'::jsonb),
        COALESCE(p.is_sensitive, false),
        jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'avatar_url', pr.avatar_url,
            'domain', COALESCE(pr.domain, 'har.mony.lol'),
            'handle', CASE
                WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                ELSE '@' || pr.username || '@' || pr.domain
            END,
            'is_local', COALESCE(pr.is_local, true),
            'bio', pr.bio,
            'color', pr.color
        ) AS author,
        EXISTS(
            SELECT 1 FROM post_interactions pi
            WHERE pi.post_id = p.id
              AND pi.user_id = p_user_id
              AND pi.interaction_type = 'favorite'
        ) AS is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi
            WHERE pi.post_id = p.id
              AND pi.user_id = p_user_id
              AND pi.interaction_type = 'reblog'
        ) AS is_reblogged,
        EXISTS(
            SELECT 1 FROM post_interactions pi
            WHERE pi.post_id = p.id
              AND pi.user_id = p_user_id
              AND pi.interaction_type = 'bookmark'
        ) AS is_bookmarked
    FROM posts p
    INNER JOIN profiles pr ON p.author_id = pr.id
    WHERE p.is_local = false
      AND p.visibility = 'public'
      AND (p.is_deleted = false OR p.is_deleted IS NULL)
      AND p.deleted_at IS NULL
      AND (pr.is_suspended = false OR pr.is_suspended IS NULL)
      AND (pr.is_silenced = false OR pr.is_silenced IS NULL)
      AND p.in_reply_to IS NULL
      AND (p_max_id IS NULL OR p.created_at < (
          SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
      ))
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

-- announcement_reads.user_id is written with the auth uid by the client; both ids name
-- the caller.
CREATE OR REPLACE FUNCTION public.get_unread_announcements(
    p_user_id uuid,
    p_popup_only boolean DEFAULT false)
RETURNS TABLE(id uuid, title text, content text, image_url text, icon text, is_pinned boolean,
              show_popup boolean, silence boolean, created_at timestamp with time zone,
              author_id uuid, author_username text, author_display_name text,
              author_avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND (p_user_id IS NULL
            OR (p_user_id IS DISTINCT FROM auth.uid()
                AND p_user_id IS DISTINCT FROM public.get_current_profile_id())) THEN
        RAISE EXCEPTION 'Announcements are listed for the caller only'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH joined AS (
        SELECT COALESCE(
            (SELECT pr.created_at FROM public.profiles pr WHERE pr.id = p_user_id),
            'epoch'::timestamptz
        ) AS user_created_at
    )
    SELECT
        a.id, a.title, a.content, a.image_url, a.icon,
        a.is_pinned, a.show_popup, a.silence, a.created_at,
        a.author_id, p.username AS author_username,
        p.display_name AS author_display_name,
        p.avatar_url AS author_avatar_url
    FROM public.instance_announcements a
    LEFT JOIN public.profiles p ON p.id = a.author_id
    LEFT JOIN public.announcement_reads ar
        ON ar.announcement_id = a.id AND ar.user_id = p_user_id
    CROSS JOIN joined j
    WHERE a.is_active = true
      AND a.starts_at <= NOW()
      AND (a.ends_at IS NULL OR a.ends_at > NOW())
      AND ar.id IS NULL
      AND (
          NOT p_popup_only
          OR (
              a.show_popup = true
              AND a.starts_at >= j.user_created_at
          )
      )
    ORDER BY a.is_pinned DESC, a.display_order ASC, a.created_at DESC
    LIMIT CASE WHEN p_popup_only THEN 10 ELSE 1000 END;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_user_counts(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, post_count bigint, server_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH post_counts AS (
        SELECT po.author_id, COUNT(*)::bigint AS cnt
          FROM public.posts po
         WHERE po.author_id = ANY(p_user_ids) AND po.is_deleted = false
         GROUP BY po.author_id
    ),
    server_counts AS (
        SELECT us.user_id, COUNT(*)::bigint AS cnt
          FROM public.user_servers us
         WHERE us.user_id = ANY(p_user_ids)
         GROUP BY us.user_id
    )
    SELECT
        u.id AS user_id,
        COALESCE(pc.cnt, 0) AS post_count,
        COALESCE(sc.cnt, 0) AS server_count
      FROM unnest(p_user_ids) AS u(id)
      LEFT JOIN post_counts pc ON pc.author_id = u.id
      LEFT JOIN server_counts sc ON sc.user_id = u.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_supporter_tier(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_period text;
    v_total numeric;
    v_tier_id uuid;
    v_currency text;
    v_expires timestamptz;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    -- Manual and webhook callers create the supporter row first.
    IF NOT EXISTS (SELECT 1 FROM public.instance_supporters WHERE user_id = p_user_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(funding_period, 'monthly'), COALESCE(goal_currency, 'USD')
      INTO v_period, v_currency
    FROM public.instance_funding LIMIT 1;

    v_total := public.get_user_cycle_donation_total(p_user_id);
    v_tier_id := public.compute_supporter_tier_for_amount(v_total, v_currency);

    IF v_period = 'all' THEN
        v_expires := NULL;
    ELSE
        -- Latest donation + 30 days. No donation history (a manual grant) leaves
        -- expires_at NULL, which the badge query reads as no expiry.
        SELECT MAX(donated_at) + interval '30 days'
          INTO v_expires
        FROM public.instance_donation_history
        WHERE user_id = p_user_id;
    END IF;

    UPDATE public.instance_supporters
    SET tier_id = v_tier_id,
        amount = v_total,
        expires_at = v_expires
    WHERE user_id = p_user_id;

    RETURN v_tier_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_group_name(
    conversation_uuid uuid,
    user_profile_id uuid,
    new_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor uuid := user_profile_id;
BEGIN
  IF current_setting('role', true) IN ('anon', 'authenticated') THEN
    v_actor := public.get_current_profile_id();
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT public.can_manage_group_icon(conversation_uuid, v_actor) THEN
    RETURN jsonb_build_object('success', false,
                              'error', 'User is not a participant in this conversation');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = conversation_uuid AND type = 'group') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Group conversation not found');
  END IF;

  UPDATE conversations
     SET name = new_name,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = conversation_uuid
     AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', v_actor,
      'update_type', 'name',
      'new_value', COALESCE(new_name, '')
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object('success', true, 'message', 'Group name updated successfully');
END;
$$;

CREATE OR REPLACE FUNCTION public.update_group_icon(
    conversation_uuid uuid,
    user_profile_id uuid,
    icon_path text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor uuid := user_profile_id;
BEGIN
  IF current_setting('role', true) IN ('anon', 'authenticated') THEN
    v_actor := public.get_current_profile_id();
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT public.can_manage_group_icon(conversation_uuid, v_actor) THEN
    RETURN jsonb_build_object('success', false,
                              'error', 'User is not a participant in this conversation');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = conversation_uuid AND type = 'group') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Group conversation not found');
  END IF;

  UPDATE conversations
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
         updated_at = CURRENT_TIMESTAMP
   WHERE id = conversation_uuid
     AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', v_actor,
      'update_type', 'icon',
      'new_value', icon_path
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object('success', true, 'message', 'Group icon updated successfully');
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_group_icon(
    conversation_uuid uuid,
    user_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor uuid := user_profile_id;
BEGIN
  IF current_setting('role', true) IN ('anon', 'authenticated') THEN
    v_actor := public.get_current_profile_id();
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT public.can_manage_group_icon(conversation_uuid, v_actor) THEN
    RETURN jsonb_build_object('success', false,
                              'error', 'User is not a participant in this conversation');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = conversation_uuid AND type = 'group') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Group conversation not found');
  END IF;

  UPDATE conversations
     SET metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
         updated_at = CURRENT_TIMESTAMP
   WHERE id = conversation_uuid
     AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', v_actor,
      'update_type', 'icon_removed'
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object('success', true, 'message', 'Group icon removed successfully');
END;
$$;

-- ---------------------------------------------------------------------------
-- is_room_member
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_room_uuid uuid;
BEGIN
    IF p_room_id IS NULL OR p_user_id IS NULL THEN
        RETURN false;
    END IF;

    BEGIN
        v_room_uuid := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN false;
    END;

    IF EXISTS (SELECT 1 FROM public.channels WHERE id = v_room_uuid) THEN
        RETURN public.can_view_channel(p_user_id, v_room_uuid);
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.conversation_participants
         WHERE conversation_id = v_room_uuid
           AND user_id = p_user_id
           AND left_at IS NULL
    );
END;
$$;

-- Profiles that pass is_room_member for a room, for a caller in the room: the Megolm
-- recipients of a share.
CREATE OR REPLACE FUNCTION public.get_room_member_ids(p_room_id text)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_room uuid;
    v_server uuid;
    v_owner uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND (v_caller IS NULL OR NOT public.is_room_member(p_room_id, v_caller)) THEN
        RETURN;
    END IF;

    BEGIN
        v_room := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN;
    END;

    SELECT c.server_id, s.owner INTO v_server, v_owner
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = v_room;

    IF v_server IS NOT NULL THEN
        IF public.channel_is_restricted(v_room) THEN
            RETURN QUERY
            SELECT m.user_id
              FROM (SELECT us.user_id FROM public.user_servers us
                     WHERE us.server_id = v_server AND us.status = 'accepted'
                    UNION
                    SELECT v_owner) m
             WHERE m.user_id IS NOT NULL
               AND public.can_view_channel(m.user_id, v_room);
        ELSE
            RETURN QUERY
            SELECT us.user_id FROM public.user_servers us
             WHERE us.server_id = v_server AND us.status = 'accepted'
            UNION
            SELECT v_owner WHERE v_owner IS NOT NULL;
        END IF;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT cp.user_id FROM public.conversation_participants cp
     WHERE cp.conversation_id = v_room AND cp.left_at IS NULL;
END;
$$;

-- Clients before get_room_member_ids() send every user_servers row of a server, banned
-- and pending included, in one batch. A row for a recipient outside the room is skipped
-- rather than refused, so the batch still reaches the members.
CREATE OR REPLACE FUNCTION public.skip_share_outside_room()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
       AND NOT public.is_room_member(NEW.room_id, NEW.recipient_user_id) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_megolm_session_shares_room_guard ON public.megolm_session_shares;
CREATE TRIGGER a_megolm_session_shares_room_guard
    BEFORE INSERT ON public.megolm_session_shares
    FOR EACH ROW EXECUTE FUNCTION public.skip_share_outside_room();

-- An update keeps the insert rule: the sender cannot move a share to a recipient outside
-- the room. A recipient updates only rows addressed to them.
DROP POLICY IF EXISTS megolm_session_shares_update ON public.megolm_session_shares;
CREATE POLICY megolm_session_shares_update ON public.megolm_session_shares
    FOR UPDATE TO public
    USING (
        sender_user_id = (SELECT public.get_current_profile_id())
        OR recipient_user_id = (SELECT public.get_current_profile_id())
    )
    WITH CHECK (
        (sender_user_id = (SELECT public.get_current_profile_id())
         AND public.is_room_member(room_id, sender_user_id)
         AND public.is_room_member(room_id, recipient_user_id))
        OR recipient_user_id = (SELECT public.get_current_profile_id())
    );

-- ---------------------------------------------------------------------------
-- post_interactions
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS post_interactions_select_all ON public.post_interactions;
DROP POLICY IF EXISTS post_interactions_select_visible ON public.post_interactions;
CREATE POLICY post_interactions_select_visible ON public.post_interactions
    FOR SELECT TO public
    USING (
        user_id = (SELECT public.get_current_profile_id())
        OR (interaction_type <> 'bookmark'
            AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_interactions.post_id))
    );

CREATE OR REPLACE FUNCTION public.broadcast_post_interaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_interaction record;
  v_post_author uuid;
  v_visibility  text;
  v_is_local    boolean;
  v_payload     jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_interaction := OLD;
  ELSE
    v_interaction := NEW;
  END IF;

  SELECT author_id, visibility, COALESCE(is_local, false)
    INTO v_post_author, v_visibility, v_is_local
    FROM posts
   WHERE id = v_interaction.post_id;

  IF v_post_author IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_payload := jsonb_build_object(
    'type',             'post:interaction',
    'post_id',          v_interaction.post_id,
    'interaction_type', v_interaction.interaction_type,
    'user_id',          v_interaction.user_id,
    'emoji_id',         v_interaction.emoji_id,
    'op',               TG_OP
  );

  -- A bookmark is visible to the bookmarker only.
  IF v_interaction.interaction_type = 'bookmark' THEN
    PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_interaction.user_id::text, true);
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_post_author::text, true);

  -- feed: topics admit any authenticated subscriber.
  IF v_visibility IN ('public', 'unlisted') THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:user:' || v_post_author::text, true);
  END IF;
  IF v_visibility = 'public' THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:public', true);
    IF v_is_local THEN
      PERFORM realtime.send(v_payload, 'feed_event', 'feed:local', true);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- voice_channel_participants
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS voice_participants_select_all ON public.voice_channel_participants;
DROP POLICY IF EXISTS voice_participants_select_viewable ON public.voice_channel_participants;
CREATE POLICY voice_participants_select_viewable ON public.voice_channel_participants
    FOR SELECT TO public
    USING (
        user_id = (SELECT public.get_current_profile_id())
        OR channel_id IN (SELECT public.current_user_viewable_channel_ids())
    );

DROP POLICY IF EXISTS voice_participants_insert_self ON public.voice_channel_participants;
CREATE POLICY voice_participants_insert_self ON public.voice_channel_participants
    FOR INSERT TO public
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
        AND server_id = (SELECT c.server_id FROM public.channels c
                          WHERE c.id = voice_channel_participants.channel_id)
    );

DROP POLICY IF EXISTS voice_participants_update_self ON public.voice_channel_participants;
CREATE POLICY voice_participants_update_self ON public.voice_channel_participants
    FOR UPDATE TO public
    USING (user_id = (SELECT public.get_current_profile_id()))
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
        AND server_id = (SELECT c.server_id FROM public.channels c
                          WHERE c.id = voice_channel_participants.channel_id)
    );

CREATE OR REPLACE FUNCTION public.is_profile_in_voice(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.get_current_profile_id() IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.voice_channel_participants v
                    WHERE v.user_id = p_profile_id);
$$;

-- ---------------------------------------------------------------------------
-- session_meets_aal
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.session_meets_aal()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_claims jsonb := public.current_jwt_claims();
    v_role text;
    v_sid text;
BEGIN
    v_role := coalesce(v_claims ->> 'role', nullif(current_setting('role', true), 'none'));
    IF v_role IS DISTINCT FROM 'authenticated' THEN
        RETURN true;
    END IF;

    v_sid := v_claims ->> 'session_id';
    IF v_sid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND to_regclass('auth.sessions') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = v_sid::uuid) THEN
        RETURN false;
    END IF;

    IF v_claims ->> 'aal' = 'aal2' THEN
        RETURN true;
    END IF;
    RETURN NOT public.mfa_enabled_for(auth.uid());
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    -- Client RPCs: authenticated and service_role.
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN (
               'import_remote_emoji', 'register_recovery_key', 'get_federated_timeline',
               'get_unread_announcements', 'get_admin_user_counts', 'recompute_supporter_tier',
               'update_group_name', 'update_group_icon', 'remove_group_icon',
               'add_bot_to_server', 'is_room_member', 'get_room_member_ids',
               'get_kofi_webhook_token', 'set_kofi_webhook_token', 'is_profile_in_voice')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    -- Internal: owner and service roles.
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN (
               'can_manage_group_icon', 'content_has_system_part',
               'refuse_client_system_parts', 'guard_follow_client_write',
               'skip_share_outside_room')
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

COMMIT;

NOTIFY pgrst, 'reload schema';
