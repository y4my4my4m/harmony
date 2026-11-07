-- Reactions written by clients name an emoji, not a bare word.
--
-- A modified client stored bare names ("RIP", "ananas", "6303_monkaSTEER") in
-- reactions.custom_emoji_content. Those rows rendered as text and federated with no Emoji tag,
-- so member instances showed text pills. custom_emoji_content a client writes is now one of:
--   - a unicode emoji: no ASCII letter, space or control character;
--   - a shortcode `:name:` or `:name@host:`, and `discord:name:id`: the forms the client sends
--     for a remote or bridged emoji, which a_reactions_external_emoji
--     (20261017100001_message_content_permissions) gates on USE_EXTERNAL_EMOJIS;
-- and an emoji_id names an emoji that exists and is not removed (deleted_at,
-- 20261107100001_emoji_lifecycle), unless that emoji is already on the message. A reaction
-- joining one already on the message passes whatever its form. Anything else is refused with
-- 22023 (REACTION_EMOJI). Which emoji a member may use stays with a_reactions_external_emoji;
-- b_ orders this check after it, so its 42501 stands.
-- Federation, the Discord bridge and bots write as service_role and are not checked here.

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
         OR p_content ~ '^discord:[A-Za-z0-9_~-]{1,64}:[0-9]{5,25}$'
       );
$$;

CREATE OR REPLACE FUNCTION public.check_reaction_emoji()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_emoji public.emojis%ROWTYPE;
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

    IF NOT public.reaction_content_well_formed(NEW.custom_emoji_content) THEN
        RAISE EXCEPTION 'REACTION_EMOJI: % is no emoji', left(NEW.custom_emoji_content, 64) USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_reactions_emoji_check ON public.reactions;
CREATE TRIGGER b_reactions_emoji_check
    BEFORE INSERT OR UPDATE OF emoji_id, custom_emoji_content ON public.reactions
    FOR EACH ROW
    WHEN (CURRENT_USER IN ('authenticated', 'anon'))
    EXECUTE FUNCTION public.check_reaction_emoji();

REVOKE ALL ON FUNCTION public.reaction_content_well_formed(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_reaction_emoji() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_reaction_emoji() TO service_role;
