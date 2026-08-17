BEGIN;

-- Fix 1: Only create default server structure for explicitly local servers.
-- Previously, servers with is_local_server = NULL also got default channels,
-- which could cause duplicate channels on federated server references.
CREATE OR REPLACE FUNCTION public.trigger_create_default_server_structure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local_server = true THEN
        PERFORM public.create_default_server_structure(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

-- Fix 2: Only emit "has joined" system messages for local servers.
-- Remote server references should not generate join messages locally,
-- as those messages are managed by the remote server's own instance.
CREATE OR REPLACE FUNCTION public.handle_member_join_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_channel_id uuid;
    v_is_local boolean;
BEGIN
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = NEW.server_id;

    IF v_is_local IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = NEW.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(NEW.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        NEW.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has joined the server')),
        true,
        jsonb_build_object('type', 'member_join')
    );

    RETURN NEW;
END;
$$;

-- Cleanup: Remove any default channels/categories that were erroneously
-- created for remote server references (from past runs without this fix).
DELETE FROM public.channels
WHERE server_id IN (
    SELECT id FROM public.servers WHERE is_local_server = false
)
AND is_remote IS NOT TRUE
AND ap_id IS NULL;

DELETE FROM public.channel_categories
WHERE server_id IN (
    SELECT id FROM public.servers WHERE is_local_server = false
)
AND id NOT IN (
    SELECT DISTINCT category FROM public.channels
    WHERE category IS NOT NULL
    AND server_id IN (SELECT id FROM public.servers WHERE is_local_server = false)
);

-- Remove orphaned "has joined" system messages from remote server references
DELETE FROM public.messages
WHERE is_system = true
AND metadata->>'type' = 'member_join'
AND channel_id IN (
    SELECT c.id FROM public.channels c
    JOIN public.servers s ON c.server_id = s.id
    WHERE s.is_local_server = false
);

NOTIFY pgrst, 'reload schema';

COMMIT;
