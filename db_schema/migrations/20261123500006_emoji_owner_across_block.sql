-- get_emoji_source names a personal emoji's owner to an account the owner blocks. emojis.uploader
-- and the owner's profile, deleted_at and is_suspended included, are readable by every account: an
-- unnamed owner whose profile is live could only be a block, and the owner hidden is one select
-- away. An owner the caller blocks stays unnamed; the caller knows its own blocks. Body otherwise, volatility, owner and grants as
-- 20261107100001_emoji_lifecycle.sql.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

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

    IF v_emoji.deleted_at IS NOT NULL THEN
        RETURN jsonb_build_object('kind', 'removed');
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
                    WHERE b.blocker_id = v_me AND b.blocked_user_id = p.id);
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
               AND e.deleted_at IS NULL
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

REVOKE ALL ON FUNCTION public.get_emoji_source(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_emoji_source(uuid, text) TO authenticated, service_role;

COMMIT;
