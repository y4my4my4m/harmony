-- Bot creation and token rotation, each one transaction: no bot row exists without a token, and
-- no rotation leaves the superseded token live beside its replacement.
--
-- Token format: 'harmony_bot_' followed by 64 hex characters (32 bytes from gen_random_bytes).
-- bot_tokens.token_hash is the SHA-256 hex digest of the whole token, the value BotAuthMiddleware
-- and WebSocketGateway compute before calling verify_bot_token. The plaintext is returned once
-- and not stored.
--
-- bot_tokens.token_prefix holds the last 4 characters of the token, a display hint. Rows
-- written before this migration hold 'harmony_', the first 8 characters of every token, which
-- identifies nothing. No reader looks tokens up by this column.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.issue_bot_token(p_bot_id uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_token text := 'harmony_bot_' || encode(extensions.gen_random_bytes(32), 'hex');
    v_row public.bot_tokens;
BEGIN
    INSERT INTO public.bot_tokens (bot_id, token_hash, token_prefix, name, scopes)
    VALUES (p_bot_id,
            encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
            right(v_token, 4),
            p_name,
            ARRAY['bot'])
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'token', v_token,
        'token_hint', v_row.token_prefix,
        'token_created_at', v_row.created_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.issue_bot_token(uuid, text) FROM PUBLIC, anon, authenticated;

-- 'integration' remains valid in bots_bot_type_check for existing rows; nothing reads it.
CREATE OR REPLACE FUNCTION public.create_bot(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_bot_type text DEFAULT 'bot',
    p_is_public boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid := public.get_current_profile_id();
    v_bot public.bots;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_bot_type IS NULL OR p_bot_type NOT IN ('bot', 'bridge') THEN
        RAISE EXCEPTION 'Unsupported bot type: %', p_bot_type USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.bots (username, display_name, bio, bot_type, is_public, owner_id)
    VALUES (p_username,
            COALESCE(NULLIF(btrim(p_display_name), ''), p_username),
            NULLIF(btrim(p_bio), ''),
            p_bot_type,
            COALESCE(p_is_public, true),
            v_owner)
    RETURNING * INTO v_bot;

    RETURN jsonb_build_object('bot', to_jsonb(v_bot))
        || public.issue_bot_token(v_bot.id, 'Default Token');
END;
$$;

REVOKE ALL ON FUNCTION public.create_bot(text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_bot(text, text, text, text, boolean) TO authenticated;

-- The row lock on bots serialises concurrent rotations of one bot, so exactly one token
-- survives.
CREATE OR REPLACE FUNCTION public.rotate_bot_token(p_bot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid;
BEGIN
    SELECT owner_id INTO v_owner FROM public.bots WHERE id = p_bot_id FOR UPDATE;

    IF v_owner IS NULL OR v_owner IS DISTINCT FROM public.get_current_profile_id() THEN
        RAISE EXCEPTION 'Bot not found or not owned by caller' USING ERRCODE = '42501';
    END IF;

    UPDATE public.bot_tokens
       SET is_active = false,
           revoked_at = now()
     WHERE bot_id = p_bot_id
       AND is_active;

    RETURN public.issue_bot_token(p_bot_id, 'Reset Token');
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_bot_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_bot_token(uuid) TO authenticated;

-- bot_server_permissions is readable only by members of the server, so an owner cannot count
-- installs of their own bot in servers they are not in. bots.server_count is never written.
CREATE OR REPLACE FUNCTION public.get_owned_bot_server_counts()
RETURNS TABLE (bot_id uuid, server_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT b.id, count(p.id)::integer
      FROM public.bots b
      LEFT JOIN public.bot_server_permissions p
        ON p.bot_id = b.id AND p.is_active
     WHERE b.owner_id = (SELECT public.get_current_profile_id())
     GROUP BY b.id;
$$;

REVOKE ALL ON FUNCTION public.get_owned_bot_server_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owned_bot_server_counts() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
