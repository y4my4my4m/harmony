-- verify_bot_token on every instance.
--
-- Staging lacks the function the baseline creates; bot-gateway calls it for every bot
-- connection (WebSocketGateway, BotAuthMiddleware), so no bot authenticates there.
-- The baseline definition, unchanged; privileges of a fresh install.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.verify_bot_token(p_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_bot_token public.bot_tokens;
    v_bot public.bots;
    v_result JSONB;
BEGIN
    -- Find active token
    SELECT * INTO v_bot_token
    FROM public.bot_tokens
    WHERE token_hash = p_token_hash
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW());

    IF v_bot_token IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid or expired token');
    END IF;

    -- Get bot details
    SELECT * INTO v_bot
    FROM public.bots
    WHERE id = v_bot_token.bot_id
        AND is_active = true;

    IF v_bot IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Bot not found or inactive');
    END IF;

    -- Update last used
    UPDATE public.bot_tokens
    SET last_used_at = NOW(),
        uses_count = uses_count + 1
    WHERE id = v_bot_token.id;

    -- Return bot info
    v_result := jsonb_build_object(
        'valid', true,
        'bot_id', v_bot.id,
        'username', v_bot.username,
        'scopes', v_bot_token.scopes
    );

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_bot_token(text) TO anon, authenticated, service_role;

COMMIT;
