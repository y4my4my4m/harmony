-- Reactions written by clients name an emoji, not a bare word.
--
-- Bare names ("RIP", "ananas", "6303_monkaSTEER") reached reactions.custom_emoji_content: the
-- client keyed a bridged Discord pill built from a realtime event by its display name
-- (metadata.remote_emoji_name) instead of its `discord:name:id` content (reactionGroupKey before
-- 1.9.4), and third-party clients write what they like. Those rows rendered as text and
-- federated with no Emoji tag, so member instances showed text pills.
--
-- custom_emoji_content a client writes is now one of:
--   - a unicode emoji: no ASCII letter, space or control character;
--   - `:name:`, `:name@host:` or `discord:[a:]name:id`, the forms the client sends for a remote or
--     bridged emoji, gated on USE_EXTERNAL_EMOJIS by a_reactions_external_emoji
--     (20261017100001_message_content_permissions);
--   - the content of a reaction already on the message (joining a pill);
--   - a bare name that names a pill already on the message: its remote_emoji_name, or the name
--     inside its `discord:` or `:name@host:` content. The row takes that pill's content and image
--     metadata, and passes the same USE_EXTERNAL_EMOJIS gate, which saw only the bare name;
--   - a bare name naming an emoji of the message's server: the row takes that emoji_id.
--   Clients before 1.9.4 send bare names, from such pills and from frequent-emoji entries.
-- An emoji_id names an emoji that exists and is not removed (deleted_at,
-- 20261107100001_emoji_lifecycle), unless it is already on the message. Anything else is
-- refused with 22023 (REACTION_EMOJI). b_ orders this check after a_reactions_external_emoji,
-- so its 42501 stands. Federation, the Discord bridge and bots write as service_role and are not
-- checked here.

CREATE OR REPLACE FUNCTION public.reaction_content_well_formed(p_content text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_content IS NOT NULL
       AND char_length(p_content) BETWEEN 1 AND 200
       AND (
            -- Unicode emoji. Digits, '#' and '*' occur only inside keycap sequences.
            (p_content !~ '[A-Za-z[:space:][:cntrl:]]' AND p_content !~ '^[0-9#*:._-]+$'
             AND char_length(p_content) <= 64)
         OR p_content ~ '^:[A-Za-z0-9_+-]{1,64}(@[A-Za-z0-9.-]+(:[0-9]{1,5})?)?:$'
         OR p_content ~ '^discord:(a:)?[A-Za-z0-9_~-]{1,64}:[0-9]{5,25}$'
       );
$$;

-- USE_EXTERNAL_EMOJIS for a reaction (20261017100001_message_content_permissions): an emoji
-- external to the message's local server needs the permission, unless @everyone holds it in
-- the channel. enforce_reaction_external_emoji and check_reaction_emoji's rewrite both ask here.
CREATE OR REPLACE FUNCTION public.reaction_external_emoji_allowed(p_message_id uuid, p_emoji_id uuid, p_content text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
    v_server uuid;
    v_key text;
BEGIN
    IF p_emoji_id IS NOT NULL THEN
        v_key := 'id:' || p_emoji_id::text || '|';
    ELSIF p_content ~ '^discord:(a:)?[A-Za-z0-9_]{2,32}:[0-9]{17,20}$' THEN
        v_key := 'discord:' || substring(p_content from '([0-9]{17,20})$');
    ELSE
        v_key := 'url:' || p_content;
    END IF;

    SELECT m.channel_id, c.server_id INTO v_channel, v_server
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.servers s ON s.id = c.server_id
     WHERE m.id = p_message_id
       AND s.is_local_server IS NOT FALSE;
    RETURN v_server IS NULL
        OR public.channel_grants_everyone(v_channel, 524288)
        OR cardinality(public.external_emoji_keys(ARRAY[v_key], v_server)) = 0
        OR public.has_permission(public.get_current_profile_id(), v_server, 'USE_EXTERNAL_EMOJIS', v_channel);
END;
$$;

-- Latest before: 20261017100001_message_content_permissions. Same rule, through the helper.
CREATE OR REPLACE FUNCTION public.enforce_reaction_external_emoji()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF public.reaction_external_emoji_allowed(NEW.message_id, NEW.emoji_id, NEW.custom_emoji_content) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Missing permission: USE_EXTERNAL_EMOJIS' USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.check_reaction_emoji()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_emoji public.emojis%ROWTYPE;
    v_pill record;
    v_emoji_id uuid;
BEGIN
    IF NEW.emoji_id IS NULL AND NULLIF(NEW.custom_emoji_content, '') IS NULL THEN
        RAISE EXCEPTION 'REACTION_EMOJI: a reaction names an emoji' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.reactions r
         WHERE r.message_id = NEW.message_id
           AND r.id IS DISTINCT FROM NEW.id
           AND CASE WHEN NEW.emoji_id IS NOT NULL THEN r.emoji_id = NEW.emoji_id
                    ELSE r.emoji_id IS NULL AND r.custom_emoji_content = NEW.custom_emoji_content END
    ) THEN
        RETURN NEW;
    END IF;

    IF NEW.emoji_id IS NOT NULL THEN
        SELECT * INTO v_emoji FROM public.emojis e WHERE e.id = NEW.emoji_id;
        IF NOT FOUND OR v_emoji.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'REACTION_EMOJI: that emoji is not available' USING ERRCODE = '22023';
        END IF;
        RETURN NEW;
    END IF;

    IF public.reaction_content_well_formed(NEW.custom_emoji_content) THEN
        RETURN NEW;
    END IF;

    -- A bare name naming a pill already on the message.
    IF NEW.custom_emoji_content ~ '^[A-Za-z0-9_~-]{1,64}$' THEN
        SELECT r.custom_emoji_content, r.metadata INTO v_pill
          FROM public.reactions r
         WHERE r.message_id = NEW.message_id
           AND r.id IS DISTINCT FROM NEW.id
           AND r.emoji_id IS NULL
           AND r.custom_emoji_content IS DISTINCT FROM NEW.custom_emoji_content
           AND public.reaction_content_well_formed(r.custom_emoji_content)
           AND (r.metadata ->> 'remote_emoji_name' = NEW.custom_emoji_content
                OR (split_part(r.custom_emoji_content, ':', 1) = 'discord'
                    AND NEW.custom_emoji_content IN (split_part(r.custom_emoji_content, ':', 2),
                                                     split_part(r.custom_emoji_content, ':', 3)))
                OR r.custom_emoji_content = ':' || NEW.custom_emoji_content || ':'
                OR left(r.custom_emoji_content, length(NEW.custom_emoji_content) + 2) = ':' || NEW.custom_emoji_content || '@')
         ORDER BY r.created_at
         LIMIT 1;
        IF FOUND THEN
            IF NOT public.reaction_external_emoji_allowed(NEW.message_id, NULL, v_pill.custom_emoji_content) THEN
                RAISE EXCEPTION 'Missing permission: USE_EXTERNAL_EMOJIS' USING ERRCODE = '42501';
            END IF;
            NEW.custom_emoji_content := v_pill.custom_emoji_content;
            NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
                'remote_emoji_url', v_pill.metadata -> 'remote_emoji_url',
                'remote_emoji_name', v_pill.metadata -> 'remote_emoji_name'));
            RETURN NEW;
        END IF;
    END IF;

    -- A bare name naming an emoji of the message's server: the row takes that emoji.
    IF NEW.custom_emoji_content ~ '^[A-Za-z0-9_~-]{1,64}$' THEN
        SELECT e.id INTO v_emoji_id
          FROM public.messages m
          JOIN public.channels c ON c.id = m.channel_id
          JOIN public.emojis e ON e.server_id = c.server_id
         WHERE m.id = NEW.message_id
           AND e.name = NEW.custom_emoji_content
           AND e.deleted_at IS NULL
         ORDER BY e.created_at
         LIMIT 1;
        IF FOUND THEN
            NEW.emoji_id := v_emoji_id;
            NEW.custom_emoji_content := NULL;
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'REACTION_EMOJI: % is no emoji', left(NEW.custom_emoji_content, 64) USING ERRCODE = '22023';
END;
$$;

DROP TRIGGER IF EXISTS b_reactions_emoji_check ON public.reactions;
CREATE TRIGGER b_reactions_emoji_check
    BEFORE INSERT OR UPDATE OF emoji_id, custom_emoji_content ON public.reactions
    FOR EACH ROW
    WHEN (CURRENT_USER IN ('authenticated', 'anon'))
    EXECUTE FUNCTION public.check_reaction_emoji();

REVOKE ALL ON FUNCTION public.reaction_content_well_formed(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reaction_external_emoji_allowed(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_reaction_external_emoji() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_reaction_emoji() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_reaction_emoji() TO service_role;
