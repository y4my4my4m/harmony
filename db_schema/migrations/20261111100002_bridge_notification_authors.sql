-- Notification snapshots retain the server-validated generic author, not arbitrary metadata.
BEGIN;

CREATE OR REPLACE FUNCTION public.message_notification_sender_json(
    p_user_id uuid, p_bot_id uuid, p_metadata jsonb, p_sender_profile public.profiles)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE v_bot public.bots; v_author jsonb := p_metadata->'bridge_author';
BEGIN
    IF p_user_id IS NOT NULL THEN
        RETURN public.notification_actor_json(p_sender_profile);
    END IF;
    IF p_bot_id IS NOT NULL AND jsonb_typeof(v_author) = 'object'
       AND v_author->>'platform' IN ('matrix', 'discord') THEN
        RETURN jsonb_build_object(
            'username', v_author->>'username',
            'display_name', COALESCE(NULLIF(v_author->>'display_name', ''), v_author->>'username'),
            'avatar_url', v_author->>'avatar_url',
            'is_local', false,
            'handle', CASE WHEN v_author->>'platform' = 'matrix' THEN v_author->>'id'
                           ELSE '@' || (v_author->>'username') END,
            'metadata', jsonb_build_object('bridge_author', v_author));
    END IF;
    IF p_metadata IS NOT NULL AND p_metadata ? 'discord_user' THEN
        RETURN jsonb_build_object(
            'username', p_metadata->'discord_user'->>'username',
            'display_name', COALESCE(p_metadata->'discord_user'->>'display_name', p_metadata->'discord_user'->>'username'),
            'avatar_url', p_metadata->'discord_user'->>'avatar_url',
            'is_local', false,
            'handle', '@' || COALESCE(p_metadata->'discord_user'->>'username', 'discord'));
    END IF;
    IF p_bot_id IS NOT NULL THEN
        SELECT * INTO v_bot FROM public.bots WHERE id = p_bot_id;
        IF FOUND THEN
            RETURN jsonb_build_object(
                'username', v_bot.username,
                'display_name', COALESCE(v_bot.display_name, v_bot.username),
                'avatar_url', v_bot.avatar_url,
                'is_local', false,
                'handle', '@' || v_bot.username);
        END IF;
    END IF;
    RETURN '{}'::jsonb;
END;
$$;

-- All four trigger builders use NEW.metadata from the persisted message. Do not snapshot
-- the entire metadata object: custom transport/private fields do not belong in notifications.
DO $patch$
DECLARE fn regprocedure; body text;
        anchor text := $code$'message', jsonb_build_object($code$;
        replacement text := $code$'message', jsonb_build_object(
                    'metadata', jsonb_strip_nulls(jsonb_build_object('bridge_author', NEW.metadata->'bridge_author')),$code$;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.handle_message_federation()',
        'public.handle_role_mention_notifications()',
        'public.handle_channel_message_notifications()',
        'public.handle_thread_reply_notification()']::regprocedure[] LOOP
        body := pg_get_functiondef(fn);
        IF strpos(body, anchor) = 0 THEN RAISE EXCEPTION 'Notification message anchor missing: %', fn; END IF;
        EXECUTE replace(body, anchor, replacement);
    END LOOP;
END;
$patch$;

COMMIT;
