-- Thread replies over Realtime Broadcast, so no view needs postgres_changes (CDC) on messages.
--
-- broadcast_message_event also sends a thread reply's event to 'thread-messages-<thread id>',
-- with the payload the channel topic gets (ids only for redacted rows). topic_readable_by admits
-- that topic for whoever can view the thread's channel. Clients from 1.8.6 subscribe to the
-- broadcast topics only; messages stays in the supabase_realtime publication while older clients
-- still join with a postgres_changes config.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- As 20261017100001 (broadcast_message_event), plus the thread topic.
CREATE OR REPLACE FUNCTION public.broadcast_message_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec      record;
  v_topic    text;
  v_row      jsonb;
  v_server   uuid;
  v_redact   boolean := false;
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
    -- A row created in this transaction postdates every subscriber's view start.
    IF v_rec.created_at < now() THEN
      SELECT c.server_id INTO v_server
        FROM public.channels c
        JOIN public.servers s ON s.id = c.server_id
       WHERE c.id = v_rec.channel_id
         AND s.is_local_server IS NOT FALSE;
      v_redact := v_server IS NOT NULL
                  AND NOT public.channel_grants_everyone(v_rec.channel_id, 4194304);
    END IF;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_redact THEN
    v_row := jsonb_build_object(
      'id',         v_rec.id,
      'created_at', v_rec.created_at,
      'updated_at', v_rec.updated_at,
      'channel_id', v_rec.channel_id,
      'thread_id',  v_rec.thread_id,
      'is_deleted', v_rec.is_deleted,
      'restricted', true
    );
  ELSE
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
  END IF;

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

  IF v_rec.thread_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'op',  TG_OP,
        'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
        'old', CASE WHEN TG_OP = 'DELETE' THEN v_row ELSE NULL END
      ),
      'message_event',
      'thread-messages-' || v_rec.thread_id::text,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Delivery is best-effort; the write must not fail because realtime is
  -- unavailable. Clients reconcile against the table on reconnect.
  RAISE WARNING 'broadcast_message_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- As 20261017100002 (topic_readable_by), plus 'thread-messages-<thread id>'.
CREATE OR REPLACE FUNCTION public.topic_readable_by(p_profile_id uuid, p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile_id uuid;
  v_id         uuid;
  v_room       text;
  v_match      text[];
BEGIN
  IF p_topic IS NULL THEN
    RETURN false;
  END IF;

  v_profile_id := p_profile_id;
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

  -- Replaces messages_select_channel_member for delivery: accepted membership and
  -- VIEW_CHANNEL.
  IF p_topic LIKE 'channel-messages-%' THEN
    BEGIN
      v_id := substring(p_topic from 18)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.can_view_channel(v_profile_id, v_id);
  END IF;

  -- A thread's replies: everyone who can view its channel (every thread is public).
  IF p_topic LIKE 'thread-messages-%' THEN
    BEGIN
      v_id := substring(p_topic from 17)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN COALESCE((SELECT public.can_view_channel(v_profile_id, t.channel_id)
                       FROM public.threads t WHERE t.id = v_id), false);
  END IF;

  IF p_topic LIKE 'server-presence:%' OR p_topic LIKE 'server-structure:%'
     OR p_topic LIKE 'voice-channels:%' THEN
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

  IF p_topic LIKE 'dm-call:%' THEN
    BEGIN
      v_id := substring(p_topic from 9)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.is_conversation_participant(v_id, v_profile_id);
  END IF;

  IF p_topic LIKE 'voice-channel:%' THEN
    BEGIN
      v_id := substring(p_topic from 15)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.can_view_channel(v_profile_id, v_id);
  END IF;

  IF p_topic LIKE 'dm-calls:%' THEN
    BEGIN
      v_id := substring(p_topic from 10)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN v_id = v_profile_id;
  END IF;

  IF p_topic LIKE 'typing:%' THEN
    BEGIN
      v_id := split_part(p_topic, ':', 3)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    CASE split_part(p_topic, ':', 2)
      WHEN 'conversation' THEN
        RETURN public.is_conversation_participant(v_id, v_profile_id);
      WHEN 'channel' THEN
        RETURN public.can_view_channel(v_profile_id, v_id);
      WHEN 'thread' THEN
        RETURN COALESCE((SELECT public.can_view_channel(v_profile_id, t.channel_id)
                           FROM public.threads t WHERE t.id = v_id), false);
      ELSE
        RETURN false;
    END CASE;
  END IF;

  IF p_topic LIKE 'harmony-voice-%' OR p_topic LIKE 'easter-egg:%' THEN
    v_room := CASE WHEN p_topic LIKE 'harmony-voice-%'
                   THEN substring(p_topic from 15)
                   ELSE substring(p_topic from 12) END;

    v_match := regexp_match(v_room,
      '^(?:dm-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      '|federated-dm-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9]{1,16})$', 'i');
    IF v_match IS NOT NULL THEN
      RETURN public.is_conversation_participant(COALESCE(v_match[1], v_match[2])::uuid, v_profile_id);
    END IF;

    BEGIN
      v_id := v_room::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.voice_channel_admits(v_profile_id, v_id);
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
$function$;

REVOKE ALL ON FUNCTION public.topic_readable_by(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topic_readable_by(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.broadcast_message_event() FROM PUBLIC, anon, authenticated;

COMMIT;
