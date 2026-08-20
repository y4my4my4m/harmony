-- =============================================================================
-- Migration: move message delivery from postgres_changes to Broadcast.
-- =============================================================================
-- postgres_changes routes every row through the walrus replication process and
-- re-evaluates RLS per subscriber per row. Under load it falls behind and drops
-- subscriptions server-side while the client channel still reports SUBSCRIBED,
-- so a conversation stops receiving messages with no error anywhere. Every
-- other realtime feature here already moved to realtime.send(); messages were
-- the last table on CDC.
--
-- Two parts, and the order matters:
--   1. Topic authorization on realtime.messages. The previous policy was
--      USING (true) - every authenticated user could subscribe to every private
--      topic. That leaked reaction events; carrying message bodies over the
--      same transport would leak conversation content, so the policy is
--      replaced before the trigger starts publishing.
--   2. broadcast_message_event(), mirroring broadcast_message_reaction_event
--      onto the same topics the client already subscribes to.
--
-- Clients keep their postgres_changes subscription until every build is
-- updated; the payload mirrors the CDC shape so both feed one handler and
-- duplicates dedupe by message id. Removing CDC is a follow-up:
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Topic authorization
-- -----------------------------------------------------------------------------
-- realtime.messages holds one row per broadcast; SELECT is what a subscriber
-- needs to receive on a topic. Authorization is by topic name because that is
-- all Broadcast carries - there is no per-row check the way CDC had.
--
-- Topics in use:
--   dm-conversation-<conversation_id>  participants only
--   channel-messages-<channel_id>      members of the channel's server
--   server-presence:<server_id>        members of that server
--   server-structure:<server_id>       members of that server
--   user:<profile_id>                  that profile only
-- Anything else is denied. A new topic must be added here or it will not
-- deliver.

CREATE OR REPLACE FUNCTION public.can_subscribe_to_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id uuid;
  v_id         uuid;
  v_server_id  uuid;
BEGIN
  IF p_topic IS NULL THEN
    RETURN false;
  END IF;

  v_profile_id := public.get_current_profile_id();
  IF v_profile_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_topic LIKE 'dm-conversation-%' THEN
    BEGIN
      v_id := substring(p_topic from 17)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.is_conversation_participant(v_id, v_profile_id);
  END IF;

  IF p_topic LIKE 'channel-messages-%' THEN
    BEGIN
      v_id := substring(p_topic from 18)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    SELECT server_id INTO v_server_id FROM public.channels WHERE id = v_id;
    IF v_server_id IS NULL THEN
      RETURN false;
    END IF;
    -- status is checked inline: current_user_is_member_of_server() tests row
    -- existence only, which would admit 'banned'. messages_select_channel_member
    -- requires 'accepted', and this gate replaces it for delivery.
    RETURN EXISTS (
      SELECT 1 FROM public.user_servers
      WHERE server_id = v_server_id
        AND user_id = v_profile_id
        AND status = 'accepted'
    );
  END IF;

  IF p_topic LIKE 'server-presence:%' OR p_topic LIKE 'server-structure:%' THEN
    BEGIN
      v_id := split_part(p_topic, ':', 2)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN EXISTS (
      SELECT 1 FROM public.user_servers
      WHERE server_id = v_id
        AND user_id = v_profile_id
        AND status = 'accepted'
    );
  END IF;

  IF p_topic LIKE 'user:%' THEN
    BEGIN
      v_id := substring(p_topic from 6)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN v_id = v_profile_id;
  END IF;


  -- Feed topics carry only public, non-deleted posts: broadcast_post_event
  -- gates every send on visibility = 'public'. No per-user check applies.
  IF p_topic IN ('feed:public', 'feed:local')
     OR p_topic LIKE 'feed:user:%'
     OR p_topic LIKE 'feed:hashtag:%' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.can_subscribe_to_topic(text) IS
'Authorizes a Broadcast topic for the current user. Broadcast carries no row context, so this is the only gate on realtime.messages SELECT.';

GRANT EXECUTE ON FUNCTION public.can_subscribe_to_topic(text) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_receive" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_receive" ON realtime.messages
      FOR SELECT TO authenticated
      USING (public.can_subscribe_to_topic(topic))';

    -- Client publishes: UserEventChannel.send() on the sender's own user:
    -- topic, and userDataService profile fan-out on server-presence: topics
    -- of servers the sender belongs to. Everything else originates from a
    -- SECURITY DEFINER trigger, which bypasses RLS.
    --
    -- Topic is the only usable predicate. Realtime resolves write access once
    -- per topic against a probe row carrying topic and extension alone, so a
    -- term over event is NULL there and denies every private topic. The real
    -- publish is never re-checked against this policy, so an event term would
    -- not constrain it either way.
    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_send" ON realtime.messages
      FOR INSERT TO authenticated
      WITH CHECK (
        topic = ''user:'' || public.get_current_profile_id()::text
        OR (
          topic LIKE ''server-presence:%''
          AND EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = substring(topic from 17)::uuid
              AND us.user_id = public.get_current_profile_id()
              AND us.status = ''accepted''
          )
        )
      )';
  END IF;

  -- 20260324 granted these; both policies are TO authenticated, so anon reads
  -- nothing through them. Revoked here so migrated instances match a fresh init.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    EXECUTE 'REVOKE SELECT ON realtime.messages FROM anon';
    EXECUTE 'REVOKE USAGE ON SCHEMA realtime FROM anon';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Message broadcast
-- -----------------------------------------------------------------------------
-- Payload mirrors the postgres_changes envelope ({op, new, old}) so one client
-- handler serves both transports during the rollout.
--
-- Columns are listed rather than row_to_json(NEW): the row carries federation
-- bookkeeping and a legacy reactions array that no subscriber reads, and
-- Broadcast payloads are size-capped.

CREATE OR REPLACE FUNCTION public.broadcast_message_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec   record;
  v_topic text;
  v_row   jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  IF v_rec.conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_rec.conversation_id::text;
  ELSIF v_rec.channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_rec.channel_id::text;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_row := jsonb_build_object(
    'id',                  v_rec.id,
    'created_at',          v_rec.created_at,
    'updated_at',          v_rec.updated_at,
    'user_id',             v_rec.user_id,
    'bot_id',              v_rec.bot_id,
    'channel_id',          v_rec.channel_id,
    'conversation_id',     v_rec.conversation_id,
    'thread_id',           v_rec.thread_id,
    'reply_to',            v_rec.reply_to,
    'content',             v_rec.content,
    'is_deleted',          v_rec.is_deleted,
    'is_system',           v_rec.is_system,
    'is_pinned',           v_rec.is_pinned,
    'encrypted',           v_rec.encrypted,
    'encryption_metadata', v_rec.encryption_metadata,
    'megolm_session_id',   v_rec.megolm_session_id,
    'metadata',            COALESCE(v_rec.metadata, '{}'::jsonb)
  );

  PERFORM realtime.send(
    jsonb_build_object(
      'op',  TG_OP,
      'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
      'old', CASE WHEN TG_OP = 'DELETE' THEN v_row ELSE NULL END
    ),
    'message_event',
    v_topic,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Delivery is best-effort; the write must not fail because realtime is
  -- unavailable. Clients reconcile against the table on reconnect.
  RAISE WARNING 'broadcast_message_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.broadcast_message_event() IS
'Publishes message rows to dm-conversation-<id> / channel-messages-<id> via Broadcast. Mirrors the postgres_changes envelope.';

-- AFTER, so the row is committed-visible to anything the client fetches in
-- response. UPDATE is column-scoped: edits, soft deletes and pins are the only
-- changes a subscriber renders, and federation bookkeeping rewrites
-- federation_status on rows that would otherwise rebroadcast unchanged.
DROP TRIGGER IF EXISTS trigger_broadcast_message_insert ON public.messages;
CREATE TRIGGER trigger_broadcast_message_insert
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_message_event();

DROP TRIGGER IF EXISTS trigger_broadcast_message_update ON public.messages;
CREATE TRIGGER trigger_broadcast_message_update
    AFTER UPDATE OF content, is_deleted, is_pinned, encryption_metadata, metadata, thread_id ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_message_event();

DROP TRIGGER IF EXISTS trigger_broadcast_message_delete ON public.messages;
CREATE TRIGGER trigger_broadcast_message_delete
    AFTER DELETE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_message_event();

COMMIT;
