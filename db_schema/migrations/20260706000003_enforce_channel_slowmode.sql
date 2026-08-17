BEGIN;

-- channels.slowmode_seconds existed but nothing enforced it. Enforce at
-- insert time so every client (web, native, bots via user tokens) obeys.
-- Exemptions: system messages, bots, federated (remote) authors, and
-- moderators with MANAGE_MESSAGES on the channel.

CREATE OR REPLACE FUNCTION public.enforce_channel_slowmode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_slowmode integer;
    v_server_id uuid;
    v_is_local boolean;
    v_last_at timestamptz;
    v_wait integer;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.user_id IS NULL OR COALESCE(NEW.is_system, false) THEN
        RETURN NEW;
    END IF;

    SELECT c.slowmode_seconds, c.server_id
    INTO v_slowmode, v_server_id
    FROM public.channels c
    WHERE c.id = NEW.channel_id;

    IF COALESCE(v_slowmode, 0) <= 0 THEN
        RETURN NEW;
    END IF;

    -- Slowmode is a local moderation rule; never reject federated traffic.
    SELECT p.is_local INTO v_is_local FROM public.profiles p WHERE p.id = NEW.user_id;
    IF v_is_local IS DISTINCT FROM true THEN
        RETURN NEW;
    END IF;

    IF public.has_permission(NEW.user_id, v_server_id, 'MANAGE_MESSAGES', NEW.channel_id) THEN
        RETURN NEW;
    END IF;

    SELECT max(m.created_at) INTO v_last_at
    FROM public.messages m
    WHERE m.channel_id = NEW.channel_id
      AND m.user_id = NEW.user_id
      AND m.created_at > now() - make_interval(secs => v_slowmode);

    IF v_last_at IS NOT NULL THEN
        v_wait := GREATEST(1, CEIL(v_slowmode - EXTRACT(EPOCH FROM (now() - v_last_at)))::integer);
        RAISE EXCEPTION 'SLOWMODE_ACTIVE:%', v_wait
            USING ERRCODE = 'P0001',
                  HINT = format('Slowmode is enabled - wait %s more second(s)', v_wait);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_enforce_channel_slowmode ON public.messages;
CREATE TRIGGER trigger_enforce_channel_slowmode
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_channel_slowmode();

-- Supports the "author's last message in channel" lookup above.
CREATE INDEX IF NOT EXISTS idx_messages_channel_user_created
    ON public.messages (channel_id, user_id, created_at DESC)
    WHERE channel_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
