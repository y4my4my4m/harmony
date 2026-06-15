BEGIN;

-- Instance-admin policy for bridged attachment handling (Discord, Slack, etc.).
-- NOT exposed via public_instance_config_keys — only admins + bot-gateway (service role).
-- Values: link | mirror
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES (
  'bridge_attachment_mode',
  '"link"'::jsonb,
  'How bridged external attachments are stored: link (external CDN URLs may expire), mirror (copy into user_media — uses disk).'
)
ON CONFLICT (config_key) DO NOTHING;

-- Allow URL-only content patches without bumping updated_at / "(edited)".
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.updated_at := COALESCE(NEW.created_at, NOW());
        RETURN NEW;
    END IF;

    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        NEW.updated_at := OLD.updated_at;
        RETURN NEW;
    END IF;

    IF OLD.content IS DISTINCT FROM NEW.content THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.update_message_content_silent(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.update_message_content_silent(
  p_message_id uuid,
  p_old_content jsonb,
  p_content jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev text;
  v_count integer;
BEGIN
  v_prev := current_setting('harmony.silent_content_update', true);
  PERFORM set_config('harmony.silent_content_update', 'true', true);

  UPDATE public.messages
  SET content = p_content
  WHERE id = p_message_id
    AND content = p_old_content;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM set_config(
    'harmony.silent_content_update',
    COALESCE(v_prev, 'false'),
    true
  );

  RETURN v_count = 1;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'harmony.silent_content_update',
    COALESCE(v_prev, 'false'),
    true
  );
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.update_message_content_silent(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_message_content_silent(uuid, jsonb, jsonb) TO service_role;

-- Silent URL refresh must not queue federation edit jobs or spam remote instances.
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
