-- Emoji info card: where a custom emoji comes from, as far as the viewer may know it.
--
-- get_emoji_source(p_emoji_id, p_url) answers for an emojis row whose url is p_url, as the
-- message part or reaction that names it carries both; get_emoji_source_by_url(p_url, p_name)
-- for a part that carries only an image url (federated emoji): the emojis rows with that url,
-- then remote_emojis_cache. Both return jsonb with `kind`:
--
--   server       the emoji's server is revealed: the viewer is a member (user_servers status
--                'accepted'), or the server is public and not suspended (discovery's rule).
--                server: {id, name, icon, public, member_count, is_member, joinable, domain,
--                emojis}. joinable: signed in, not a member, public, local, not suspended
--                (join_public_server's rule). domain: host_domain of a remote server, else
--                NULL. emojis: up to 9 other emoji of the server, most used first.
--   personal     scope 'user'. owner: {id, username, display_name, avatar_url, domain,
--                is_local} when the owner's profile is shown to the viewer (not deleted, not
--                suspended, no block either way), else NULL.
--   instance     no server and no domain: an emoji of this instance.
--   remote       no server, a domain: an instance emoji imported from `domain`, or a
--                remote_emojis_cache entry from origin_domain.
--   unavailable  everything else: unknown id or url, an id whose row has another url, an
--                emoji whose server was deleted
--                (emojis.server_id cascades), a server not revealed to the viewer. Exactly
--                {"kind": "unavailable"}: not-found and not-allowed are the same bytes.
--
-- Server details come only from here. emojis rows stay world-readable (emojis_select_all);
-- servers RLS already hides a private server's row from non-members.
--
-- authenticated and service_role execute; anon does not. A caller without a profile is a
-- non-member.
--
-- create_my_emoji (20261016100004_personal_emoji_uploads.sql) is redefined: its url passes
-- is_storage_public_url (20261031200001_custom_stickers.sql), so instance_config
-- storage_origin pins its origin.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.get_emoji_source(uuid);

CREATE OR REPLACE FUNCTION public.get_emoji_source(p_emoji_id uuid, p_url text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_unavailable constant jsonb := '{"kind": "unavailable"}'::jsonb;
    v_emoji public.emojis%ROWTYPE;
    v_server public.servers%ROWTYPE;
    v_member boolean;
    v_owner jsonb;
    v_others jsonb;
    v_count bigint;
BEGIN
    IF p_emoji_id IS NULL OR p_url IS NULL THEN
        RETURN v_unavailable;
    END IF;

    SELECT * INTO v_emoji FROM public.emojis e WHERE e.id = p_emoji_id;
    IF NOT FOUND OR v_emoji.url::text IS DISTINCT FROM p_url THEN
        RETURN v_unavailable;
    END IF;

    IF v_emoji.scope = 'user' THEN
        SELECT jsonb_build_object(
                   'id', p.id,
                   'username', p.username,
                   'display_name', p.display_name,
                   'avatar_url', p.avatar_url,
                   'domain', p.domain,
                   'is_local', p.is_local IS NOT FALSE)
          INTO v_owner
          FROM public.profiles p
         WHERE p.id = v_emoji.uploader
           AND p.username IS NOT NULL
           AND p.deleted_at IS NULL
           AND p.is_suspended IS NOT TRUE
           AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                    WHERE (b.blocker_id = p.id AND b.blocked_user_id = v_me)
                       OR (b.blocker_id = v_me AND b.blocked_user_id = p.id));
        RETURN jsonb_build_object('kind', 'personal', 'owner', v_owner);
    END IF;

    IF v_emoji.server_id IS NULL THEN
        IF NULLIF(btrim(v_emoji.domain), '') IS NULL THEN
            RETURN jsonb_build_object('kind', 'instance');
        END IF;
        RETURN jsonb_build_object('kind', 'remote', 'domain', lower(btrim(v_emoji.domain)));
    END IF;

    SELECT * INTO v_server FROM public.servers s WHERE s.id = v_emoji.server_id;
    IF NOT FOUND THEN
        RETURN v_unavailable;
    END IF;

    v_member := v_me IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.server_id = v_server.id
           AND us.user_id = v_me
           AND us.status = 'accepted');

    IF NOT v_member AND NOT (v_server.public IS TRUE AND v_server.suspended_at IS NULL) THEN
        RETURN v_unavailable;
    END IF;

    SELECT count(*) INTO v_count
      FROM public.user_servers us
     WHERE us.server_id = v_server.id AND us.status = 'accepted';

    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'url', o.url)
                              ORDER BY o.usage_count DESC NULLS LAST, o.created_at, o.id), '[]'::jsonb)
      INTO v_others
      FROM (SELECT e.id, e.name, e.url, e.usage_count, e.created_at
              FROM public.emojis e
             WHERE e.server_id = v_server.id
               AND e.id <> v_emoji.id
               AND e.url IS NOT NULL
             ORDER BY e.usage_count DESC NULLS LAST, e.created_at, e.id
             LIMIT 9) o;

    RETURN jsonb_build_object(
        'kind', 'server',
        'server', jsonb_build_object(
            'id', v_server.id,
            'name', v_server.name,
            'icon', v_server.icon,
            'public', v_server.public IS TRUE,
            'member_count', v_count,
            'is_member', v_member,
            'joinable', v_me IS NOT NULL
                        AND NOT v_member
                        AND v_server.public IS TRUE
                        AND v_server.is_local_server IS TRUE
                        AND v_server.suspended_at IS NULL,
            'domain', CASE WHEN v_server.is_local_server IS FALSE
                           THEN lower(NULLIF(btrim(v_server.host_domain), '')) END,
            'emojis', v_others));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_emoji_source_by_url(p_url text, p_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_unavailable constant jsonb := '{"kind": "unavailable"}'::jsonb;
    v_name text := NULLIF(btrim(p_name), '');
    v_id uuid;
    v_result jsonb;
    v_domain text;
BEGIN
    IF p_url IS NULL OR p_url = '' OR length(p_url) > 2048 THEN
        RETURN v_unavailable;
    END IF;

    -- idx_emojis_name narrows by name; without one the url scan is sequential.
    FOR v_id IN
        SELECT e.id FROM public.emojis e
         WHERE e.url = p_url
           AND (v_name IS NULL OR lower(e.name::text) = lower(v_name))
         ORDER BY e.created_at, e.id
         LIMIT 25
    LOOP
        v_result := public.get_emoji_source(v_id, p_url);
        IF v_result ->> 'kind' <> 'unavailable' THEN
            RETURN v_result;
        END IF;
    END LOOP;

    SELECT lower(btrim(c.origin_domain)) INTO v_domain
      FROM public.remote_emojis_cache c
     WHERE (v_name IS NULL OR c.shortcode = v_name)
       AND (c.url = p_url OR c.static_url = p_url)
     ORDER BY c.last_seen_at DESC NULLS LAST, c.id
     LIMIT 1;
    IF NULLIF(v_domain, '') IS NOT NULL THEN
        RETURN jsonb_build_object('kind', 'remote', 'domain', v_domain);
    END IF;

    RETURN v_unavailable;
END;
$$;

-- 20261016100004 create_my_emoji, the url checked by is_storage_public_url.
CREATE OR REPLACE FUNCTION public.create_my_emoji(p_name text, p_path text, p_url text)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_suffix text;
    v_size text;
    v_base text;
    v_name text;
    v_n integer := 0;
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^' || v_me::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: an emoji file is <your profile id>/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_storage_public_url(p_url, 'emojis', p_path) THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_suffix := '/storage/v1/object/public/emojis/' || p_path;

    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_me::text, 0));

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'user'
           AND e.uploader = v_me
           AND right(e.url::text, char_length(v_suffix)) = v_suffix) THEN
        RAISE EXCEPTION 'That file is one of your emojis' USING ERRCODE = '23505';
    END IF;

    v_base := left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9_-]', '', 'g'), 32);
    IF char_length(v_base) < 2 THEN
        v_base := 'emoji';
    END IF;
    v_name := v_base;
    WHILE EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'user'
           AND e.uploader = v_me
           AND lower(e.name::text) = lower(v_name)) LOOP
        v_n := v_n + 1;
        v_name := v_base || '_' || v_n;
    END LOOP;

    INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated, file_size)
    VALUES (v_name, p_url, NULL, v_me, NULL, 'user', false,
            CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_my_emoji(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_my_emoji(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_emoji_source(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_emoji_source(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_emoji_source_by_url(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_emoji_source_by_url(text, text) TO authenticated, service_role;

COMMIT;
