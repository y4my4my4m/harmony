-- ---------------------------------------------------------------------------
-- Move message/DM/thread reactions off postgres_changes (CDC) onto the
-- broadcast architecture, completing the Phase 5 broadcast migration.
--
-- Why:
-- Reactions were the last feature still using filtered CDC. Supabase delivers
-- filtered INSERT events reliably but routinely drops filtered DELETE events,
-- so reaction removals never propagated to other viewers (a refresh was
-- required). CDC also forced a separate channel per chat context and a full
-- get_message_reactions RPC per event per viewer (thundering herd at scale).
--
-- New model: a single AFTER INSERT/DELETE trigger broadcasts a compact
-- reaction_event via realtime.send() to the SAME private topic the client
-- already subscribes to for message delivery:
--   - channel messages -> channel-messages-{channel_id}
--   - DM messages       -> dm-conversation-{conversation_id}
-- This keeps one realtime channel per chat context and lets clients apply the
-- change in place with no refetch. Reactions are removed from the CDC
-- publication so they no longer incur WAL decoding overhead.
-- ---------------------------------------------------------------------------

BEGIN;

-- ===========================================================================
-- 1. Broadcast reaction changes to the message topic (replaces reactions CDC)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.broadcast_message_reaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec             record;
  v_channel_id      uuid;
  v_conversation_id uuid;
  v_topic           text;
  v_actor           record;
  v_emoji           record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  v_channel_id := v_rec.channel_id;
  v_conversation_id := v_rec.conversation_id;

  -- Fall back to the parent message if the denormalized context is absent.
  IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
    SELECT channel_id, conversation_id
      INTO v_channel_id, v_conversation_id
    FROM public.messages WHERE id = v_rec.message_id;
  END IF;

  IF v_conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_conversation_id::text;
  ELSIF v_channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_channel_id::text;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Actor display fields mirror the get_message_reactions RPC shape so
  -- reaction tooltips stay correct without a follow-up fetch.
  SELECT username, display_name, avatar_url
    INTO v_actor
  FROM public.profiles WHERE id = v_rec.user_id;

  -- Custom emoji name/url so a new chip renders correctly even when the
  -- receiver hasn't cached this emoji (e.g. cross-server / federated).
  IF v_rec.emoji_id IS NOT NULL THEN
    SELECT name, url INTO v_emoji FROM public.emojis WHERE id = v_rec.emoji_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',                 'reaction:' || lower(TG_OP),
      'op',                   TG_OP,
      'message_id',           v_rec.message_id,
      'emoji_id',             v_rec.emoji_id,
      'emoji_name',           v_emoji.name,
      'emoji_url',            v_emoji.url,
      'custom_emoji_content', v_rec.custom_emoji_content,
      'user_id',              v_rec.user_id,
      'bot_id',               v_rec.bot_id,
      'username',             v_actor.username,
      'display_name',         v_actor.display_name,
      'avatar_url',           v_actor.avatar_url
    ),
    'reaction_event',
    v_topic,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_message_reaction_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trigger_broadcast_reaction_insert ON public.reactions;
CREATE TRIGGER trigger_broadcast_reaction_insert
    AFTER INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_message_reaction_event();

DROP TRIGGER IF EXISTS trigger_broadcast_reaction_delete ON public.reactions;
CREATE TRIGGER trigger_broadcast_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_message_reaction_event();

-- ===========================================================================
-- 2. Fix DM reaction federation triggers
--    - Guard the DM federation fn to conversation messages only, so it no
--      longer double-queues federation for every channel reaction.
--    - Add an OLD-based delete fn and rebind the AFTER DELETE trigger, which
--      previously reused the INSERT fn and mutated NEW (invalid on DELETE).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_dm BOOLEAN;
BEGIN
    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

    SELECT (conversation_id IS NOT NULL) INTO v_is_dm
    FROM public.messages WHERE id = NEW.message_id;
    IF v_is_dm IS NOT TRUE THEN RETURN NEW; END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-message-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_dm BOOLEAN;
BEGIN
    IF OLD.metadata ? 'federated' THEN RETURN OLD; END IF;

    SELECT (conversation_id IS NOT NULL) INTO v_is_dm
    FROM public.messages WHERE id = OLD.message_id;
    IF v_is_dm IS NOT TRUE THEN RETURN OLD; END IF;

    PERFORM public.queue_federation_job(
        'federate-message-reaction',
        jsonb_build_object(
            'type', 'delete',
            'reaction_id', OLD.id,
            'message_id', OLD.message_id,
            'user_id', OLD.user_id,
            'emoji_id', OLD.emoji_id,
            'custom_emoji_content', OLD.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_federate_message_reaction_delete ON public.reactions;
CREATE TRIGGER trigger_federate_message_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_delete_federation();

-- ===========================================================================
-- 3. Remove reactions from the CDC publication (now broadcast-only)
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'reactions'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.reactions';
    RAISE NOTICE 'Dropped public.reactions from supabase_realtime publication';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
