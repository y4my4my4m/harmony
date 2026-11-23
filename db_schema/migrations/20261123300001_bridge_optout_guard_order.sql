-- Bridge opt-out guards: order after the client write guards, and author changes.
--
-- Triggers of one event fire in name order. a_messages_bridge_optout_guard sorted before
-- a_messages_client_write_guard, and a_reactions_bridge_optout_guard before
-- a_reactions_client_write_guard: a client insert carrying metadata.discord_user (or matrix_user)
-- was answered BRIDGE_AUTHOR_OPTED_OUT for an opted-out remote user and the reserved-key refusal
-- (messages) or a stored reaction (reactions) otherwise, so any account could read a server's
-- opt-outs. The guards are renamed to sort right after the client write guards, before
-- a_messages_content_emoji_parts and a_reactions_external_emoji: a client's message is refused
-- for the reserved key and a client's reaction loses its metadata before an opt-out is read.
--
--   a_messages_client_write_optout       BEFORE INSERT, WHEN as a_messages_bridge_optout_guard.
--   a_messages_client_write_optout_edit  BEFORE UPDATE OF content, metadata, WHEN the old or the new
--                                        row names a remote author and the row stays live. Was
--                                        UPDATE OF content: a bridge's metadata patch moved an
--                                        opted-out member's message to another author, or a message
--                                        onto an opted-out member.
--   a_reactions_client_write_optout      BEFORE INSERT, WHEN as a_reactions_bridge_optout_guard.
--
--   guard_bridge_author_optout           as 20261117900002_matrix_authors.sql. On UPDATE, an
--                                        unchanged author with unchanged content passes without a
--                                        lock (mapping, federation and preview writes); a changed
--                                        author is refused when the old author is opted out, as
--                                        when the new one is. A silent relink passes first, as
--                                        before; the erase rewrites its notices under it.
-- Body otherwise, volatility, owner and grants as 20261117900002_matrix_authors.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.guard_bridge_author_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_platform text := CASE WHEN NEW.metadata ? 'discord_user' THEN 'discord'
                            WHEN NEW.metadata ? 'matrix_user' THEN 'matrix' END;
    v_remote text := CASE WHEN NEW.metadata ? 'discord_user' THEN NEW.metadata #>> '{discord_user,id}'
                          ELSE NEW.metadata #>> '{matrix_user,id}' END;
    v_old_platform text;
    v_old_remote text;
    v_server uuid;
    v_author record;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- A link refresh or a mirror swap keeps the author's words.
        IF current_setting('harmony.silent_content_update', true) = 'true'
           AND public.message_parts_relinked(OLD.content, NEW.content) THEN
            RETURN NEW;
        END IF;
        v_old_platform := CASE WHEN OLD.metadata ? 'discord_user' THEN 'discord'
                               WHEN OLD.metadata ? 'matrix_user' THEN 'matrix' END;
        v_old_remote := CASE WHEN OLD.metadata ? 'discord_user' THEN OLD.metadata #>> '{discord_user,id}'
                             ELSE OLD.metadata #>> '{matrix_user,id}' END;
        IF v_old_platform IS NOT DISTINCT FROM v_platform AND v_old_remote IS NOT DISTINCT FROM v_remote THEN
            v_old_remote := NULL;
            IF NEW.content IS NOT DISTINCT FROM OLD.content THEN
                RETURN NEW;
            END IF;
        END IF;
    END IF;
    IF v_remote IS NULL AND v_old_remote IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id INTO v_server
      FROM public.channels c
     WHERE c.id = COALESCE(NEW.channel_id,
                           (SELECT t.channel_id FROM public.threads t WHERE t.id = NEW.thread_id));
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;
    -- Old and new author of a changed row, in lock key order.
    FOR v_author IN
        SELECT a.platform, a.remote
          FROM (VALUES (v_old_platform, v_old_remote), (v_platform, v_remote)) a(platform, remote)
         WHERE a.remote IS NOT NULL
         ORDER BY public.bridge_author_lock_key(v_server, a.platform, a.remote)
    LOOP
        PERFORM pg_advisory_xact_lock_shared(public.bridge_author_lock_key(v_server, v_author.platform, v_author.remote));
        IF EXISTS (
            SELECT 1 FROM public.bridge_remote_optouts o
             WHERE o.server_id = v_server AND o.platform = v_author.platform
               AND o.remote_user_id = v_author.remote) THEN
            RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_bridge_author_optout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_bridge_optout_guard ON public.messages;
DROP TRIGGER IF EXISTS a_messages_client_write_optout ON public.messages;
CREATE TRIGGER a_messages_client_write_optout
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ? 'discord_user' OR NEW.metadata ? 'matrix_user') AND NEW.is_deleted IS NOT TRUE)
    EXECUTE FUNCTION public.guard_bridge_author_optout();

DROP TRIGGER IF EXISTS a_messages_client_write_optout_edit ON public.messages;
CREATE TRIGGER a_messages_client_write_optout_edit
    BEFORE UPDATE OF content, metadata ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ? 'discord_user' OR NEW.metadata ? 'matrix_user'
           OR OLD.metadata ? 'discord_user' OR OLD.metadata ? 'matrix_user')
          AND NEW.is_deleted IS NOT TRUE)
    EXECUTE FUNCTION public.guard_bridge_author_optout();

DROP TRIGGER IF EXISTS a_reactions_bridge_optout_guard ON public.reactions;
DROP TRIGGER IF EXISTS a_reactions_client_write_optout ON public.reactions;
CREATE TRIGGER a_reactions_client_write_optout
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    WHEN (NEW.metadata ? 'discord_user' OR NEW.metadata ? 'matrix_user')
    EXECUTE FUNCTION public.guard_bridge_reaction_optout();

COMMIT;
