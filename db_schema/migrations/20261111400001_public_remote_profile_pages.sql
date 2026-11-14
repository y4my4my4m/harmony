-- Public pages of remote accounts: /@<username>@<domain> shows visitors without a session the
-- account as this instance holds it, as /@<username> shows a local one.
--
-- public_profile_page(p_username, p_before, p_limit, p_domain) replaces the three-argument form;
-- a call without p_domain reads as before. With p_domain, the account is the remote one of that
-- username and domain, both matched without case, the exact spelling first; a local account is
-- never one. public_page_account's rules stand: not deleted, suspended or silenced, not of a
-- blocked instance.
--
-- A remote account's counts are its origin's figures where read (remote_posts_count,
-- remote_followers_count, remote_following_count), this instance's counters otherwise. Its posts
-- are the ones this instance holds, under public_page_post's rules. No remote fetch happens: an
-- account this instance has not met is not found.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.public_profile_page(text, uuid, integer);

CREATE OR REPLACE FUNCTION public.public_profile_page(
    p_username text,
    p_before uuid DEFAULT NULL,
    p_limit integer DEFAULT NULL,
    p_domain text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_instance jsonb := public.public_page_instance();
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 40);
    v_domain text := NULLIF(lower(btrim(p_domain)), '');
    v_profile public.profiles%ROWTYPE;
    v_account jsonb;
    v_cursor_at timestamptz;
    v_cursor_id uuid;
    v_pinned jsonb := '[]'::jsonb;
    v_posts jsonb := '[]'::jsonb;
    v_next uuid;
    v_count integer := 0;
    v_post jsonb;
    r record;
BEGIN
    IF v_domain IS NULL THEN
        SELECT * INTO v_profile
          FROM public.profiles p
         WHERE p.is_local IS NOT FALSE
           AND lower(p.username) = lower(btrim(p_username))
         ORDER BY (p.username = btrim(p_username)) DESC, p.created_at
         LIMIT 1;
    ELSE
        SELECT * INTO v_profile
          FROM public.profiles p
         WHERE p.is_local IS FALSE
           AND lower(p.username) = lower(btrim(p_username))
           AND lower(p.domain) = v_domain
         ORDER BY (p.username = btrim(p_username)) DESC, p.created_at
         LIMIT 1;
    END IF;
    IF FOUND THEN
        v_account := public.public_page_account(v_profile.id);
    END IF;
    IF v_account IS NULL THEN
        RETURN jsonb_build_object('enabled', v_instance -> 'enabled', 'instance', v_instance, 'account', NULL);
    END IF;

    v_account := v_account || jsonb_build_object(
        'bio', v_profile.bio,
        'banner_url', v_profile.banner_url,
        'color', v_profile.color,
        'profile_fields', COALESCE(v_profile.profile_fields, '[]'::jsonb),
        'bio_emojis', COALESCE(v_profile.federation_metadata -> 'bio_emojis', '[]'::jsonb),
        'followers_count', CASE WHEN v_domain IS NULL THEN COALESCE(v_profile.followers_count, 0)
                                ELSE COALESCE(v_profile.remote_followers_count, v_profile.followers_count, 0) END,
        'following_count', CASE WHEN v_domain IS NULL THEN COALESCE(v_profile.following_count, 0)
                                ELSE COALESCE(v_profile.remote_following_count, v_profile.following_count, 0) END,
        'posts_count', CASE WHEN v_domain IS NULL THEN COALESCE(v_profile.posts_count, 0)
                            ELSE COALESCE(v_profile.remote_posts_count, v_profile.posts_count, 0) END,
        'created_at', CASE WHEN v_domain IS NULL THEN v_profile.created_at END,
        'locked', v_profile.manually_approves_followers IS TRUE,
        'moved_to_uri', NULLIF(v_profile.moved_to_uri, ''));

    IF p_before IS NOT NULL THEN
        SELECT created_at, id INTO v_cursor_at, v_cursor_id
          FROM public.posts WHERE id = p_before AND author_id = v_profile.id;
    ELSE
        FOR r IN
            SELECT id FROM public.posts
             WHERE author_id = v_profile.id AND is_pinned IS TRUE
               AND is_deleted IS NOT TRUE AND visibility IN ('public', 'unlisted')
             ORDER BY created_at DESC, id DESC
             LIMIT 10
        LOOP
            v_post := public.public_page_post(r.id, 1);
            IF v_post IS NOT NULL THEN
                v_pinned := v_pinned || jsonb_build_array(v_post);
            END IF;
        END LOOP;
    END IF;

    FOR r IN
        SELECT p.id
          FROM public.posts p
         WHERE p.author_id = v_profile.id
           AND p.is_deleted IS NOT TRUE
           AND p.visibility IN ('public', 'unlisted')
           AND p.is_pinned IS NOT TRUE
           AND (NULLIF(p.metadata ->> 'reblog_of', '') IS NULL OR p.metadata ->> 'is_quote' = 'true')
           AND (p.in_reply_to IS NULL
                OR EXISTS (SELECT 1 FROM public.posts parent
                            WHERE parent.id = p.in_reply_to AND parent.author_id = p.author_id))
           AND (p_before IS NULL
                OR (v_cursor_at IS NOT NULL
                    AND (p.created_at < v_cursor_at OR (p.created_at = v_cursor_at AND p.id < v_cursor_id))))
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT v_limit + 1
    LOOP
        v_count := v_count + 1;
        EXIT WHEN v_count > v_limit;
        v_post := public.public_page_post(r.id, 1);
        IF v_post IS NOT NULL THEN
            v_posts := v_posts || jsonb_build_array(v_post);
        END IF;
        v_next := r.id;
    END LOOP;
    IF v_count <= v_limit THEN
        v_next := NULL;
    END IF;

    RETURN jsonb_build_object(
        'enabled', v_instance -> 'enabled',
        'instance', v_instance,
        'account', v_account,
        'pinned', v_pinned,
        'posts', v_posts,
        'next', v_next);
END;
$$;

COMMENT ON FUNCTION public.public_profile_page(text, uuid, integer, text) IS
'An account''s public page: account, pinned and public or unlisted posts, newest first. p_domain names a remote account. Service callers only.';

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.public_profile_page(text, uuid, integer, text) FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.public_profile_page(text, uuid, integer, text) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
