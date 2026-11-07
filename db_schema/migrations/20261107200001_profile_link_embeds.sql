-- Link previews of this instance's account and post addresses (src/utils/permalinks.ts).
--
-- detect_embed_provider classifies a URL on this instance's domain (get_instance_domain(); the
-- hard-coded har.mony.lol is gone):
--   harmony-post      /posts/<id>, /social/post/<id>, /@user/<id>, /@user@domain/<id>
--   harmony-profile   /@user, /@user@domain, /social/profile/<handle>, /profile/<handle>,
--                     /users/<name>
-- build_harmony_embed reads the post id at the end of any of those post paths.
--
-- fetch_link_preview builds a harmony-profile card from the account as the public pages show
-- it (public_page_account: not deleted, suspended or silenced, not of a blocked instance);
-- an account it does not show has no card. The snapshot carries public fields only: the
-- account's names, avatar, bio (at most 1000 characters), counts, locked flag and colour.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.detect_embed_provider(p_url text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_host text := public.extract_url_host(p_url);
    v_path text := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
    v_domain text := lower(regexp_replace(public.get_instance_domain(), '^https?://', ''));
BEGIN
    IF v_host = v_domain THEN
        IF v_path ~ '^/(posts|social/post|@[^/]+)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/?$' THEN
            RETURN 'harmony-post';
        END IF;
        IF v_path ~ '^/@[A-Za-z0-9_.~-]{1,64}(@[A-Za-z0-9.-]+(:[0-9]{1,5})?)?/?$'
           OR v_path ~ '^/(social/)?profile/@?[A-Za-z0-9_.~-]{1,64}(@[A-Za-z0-9.-]+(:[0-9]{1,5})?)?/?$'
           OR v_path ~ '^/users/[A-Za-z0-9_]{1,64}/?$' THEN
            RETURN 'harmony-profile';
        END IF;
    END IF;
    IF v_host ~ '(youtube\.com|youtu\.be)$' THEN RETURN 'youtube'; END IF;
    IF v_host ~ 'spotify\.com$' THEN RETURN 'spotify'; END IF;
    RETURN 'generic';
END;
$$;

CREATE OR REPLACE FUNCTION public.build_harmony_embed(p_url text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_path text := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
    v_post_id uuid;
    v_post record;
    v_summary text;
    v_image text;
BEGIN
    v_post_id := substring(v_path from '/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/?$')::uuid;
    IF v_post_id IS NULL THEN
        RAISE EXCEPTION 'Invalid Harmony post URL: %', p_url;
    END IF;

    SELECT p.id, p.content, p.media_attachments, p.visibility, p.is_deleted, p.is_local, p.metadata,
           pr.id AS author_id, pr.username, pr.display_name, pr.domain, pr.avatar_url, pr.color
      INTO v_post
      FROM public.posts p
      JOIN public.profiles pr ON pr.id = p.author_id
     WHERE p.id = v_post_id;

    IF NOT FOUND OR v_post.is_deleted OR v_post.visibility NOT IN ('public', 'unlisted') THEN
        RAISE EXCEPTION 'Post % unavailable for embedding', v_post_id;
    END IF;

    v_summary := left(regexp_replace(public.convert_jsonb_to_ap(v_post.content), '<[^>]+>', '', 'g'), 280);

    IF jsonb_typeof(v_post.media_attachments) = 'array' THEN
        v_image := coalesce(v_post.media_attachments -> 0 ->> 'preview_url', v_post.media_attachments -> 0 ->> 'url');
    END IF;

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'title', coalesce(v_post.display_name, v_post.username, 'Harmony Post'),
        'description', v_summary, 'siteName', public.get_instance_domain(),
        'image', v_image, 'icon', v_post.avatar_url, 'color', v_post.color,
        'harmony', jsonb_build_object(
            'postId', v_post.id, 'instanceDomain', public.get_instance_domain(),
            'visibility', v_post.visibility, 'isLocal', v_post.is_local,
            'author', jsonb_build_object('id', v_post.author_id, 'username', v_post.username,
                'display_name', v_post.display_name, 'domain', v_post.domain,
                'avatar_url', v_post.avatar_url, 'color', v_post.color))));
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_link_preview(p_url text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_url text := public.normalize_embed_url(p_url);
    v_provider text;
    v_payload jsonb;
    v_path text;
    v_handle text;
    v_username text;
    v_domain text;
    v_here text := lower(regexp_replace(public.get_instance_domain(), '^https?://', ''));
    v_profile public.profiles%ROWTYPE;
    v_account jsonb;
    v_bio text;
BEGIN
    IF v_url IS NULL THEN
        RAISE EXCEPTION 'URL is required';
    END IF;
    v_provider := public.detect_embed_provider(v_url);

    IF v_provider = 'harmony-post' THEN
        v_payload := public.build_harmony_embed(v_url);
    ELSIF v_provider = 'harmony-profile' THEN
        v_path := coalesce(substring(v_url from 'https?://[^/]+(/[^?#]*)'), '/');
        v_handle := coalesce(substring(v_path from '^/@([^/]+)/?$'),
                             substring(v_path from '^/(?:social/)?profile/@?([^/]+)/?$'),
                             substring(v_path from '^/users/([^/]+)/?$'));
        v_username := split_part(v_handle, '@', 1);
        v_domain := lower(nullif(split_part(v_handle, '@', 2), ''));
        IF v_domain = v_here THEN
            v_domain := NULL;
        END IF;

        IF v_domain IS NULL THEN
            SELECT * INTO v_profile FROM public.profiles p
             WHERE p.is_local IS NOT FALSE AND lower(p.username) = lower(v_username)
             ORDER BY (p.username = v_username) DESC, p.created_at
             LIMIT 1;
        ELSE
            SELECT * INTO v_profile FROM public.profiles p
             WHERE p.is_local IS FALSE AND lower(p.username) = lower(v_username) AND lower(p.domain) = v_domain
             ORDER BY (p.username = v_username) DESC, p.created_at
             LIMIT 1;
        END IF;
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
        v_account := public.public_page_account(v_profile.id);
        IF v_account IS NULL THEN
            RETURN NULL;
        END IF;

        v_bio := left(v_profile.bio, 1000);
        v_payload := jsonb_strip_nulls(jsonb_build_object(
            'title', coalesce(nullif(v_profile.display_name, ''), v_profile.username),
            'description', left(btrim(regexp_replace(coalesce(v_bio, ''), '<[^>]+>', ' ', 'g')), 280),
            'siteName', public.get_instance_domain(),
            'icon', v_profile.avatar_url,
            'color', v_profile.color,
            'profile', v_account - 'discoverable' || jsonb_build_object(
                'domain', CASE WHEN v_account ->> 'is_local' = 'true' THEN NULL ELSE v_profile.domain END,
                'bio', v_bio,
                'color', v_profile.color,
                'followers_count', v_profile.followers_count,
                'following_count', v_profile.following_count,
                'posts_count', v_profile.posts_count,
                'locked', v_profile.manually_approves_followers IS TRUE)));
    ELSE
        RETURN NULL;
    END IF;

    RETURN v_payload || jsonb_build_object(
        'url', v_url, 'normalizedUrl', v_url, 'provider', v_provider,
        'fetchedAt', now(), 'expiresAt', now() + interval '24 hours');
END;
$$;

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.fetch_link_preview(text) FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.fetch_link_preview(text) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.detect_embed_provider(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.build_harmony_embed(text) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
