-- Fix federated server join: prevent default channels from being created
-- for remote server references, and add the helper function that the
-- trigger now delegates to.
BEGIN;

-- Helper function (extracted from the old inline trigger logic)
CREATE OR REPLACE FUNCTION public.create_default_server_structure(p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_text_category_id uuid;
    v_voice_category_id uuid;
BEGIN
    INSERT INTO public.channel_categories (server_id, name, "order")
    VALUES (p_server_id, 'Text Channels', 0)
    RETURNING id INTO v_text_category_id;

    INSERT INTO public.channels (server_id, name, type, category, "order")
    VALUES (p_server_id, 'general', 0, v_text_category_id, 0);

    INSERT INTO public.channel_categories (server_id, name, "order")
    VALUES (p_server_id, 'Voice Channels', 1)
    RETURNING id INTO v_voice_category_id;

    INSERT INTO public.channels (server_id, name, type, category, "order")
    VALUES (p_server_id, 'voice chat', 1, v_voice_category_id, 0);
END;
$$;

-- Updated trigger: skip remote server references
CREATE OR REPLACE FUNCTION public.trigger_create_default_server_structure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local_server = true OR NEW.is_local_server IS NULL THEN
        PERFORM public.create_default_server_structure(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

-- Clean up bogus default channels/categories on existing remote servers.
-- Remote servers get their real channels via federation sync; the defaults
-- (created by the old trigger) just clutter the UI.
DELETE FROM public.channels
WHERE server_id IN (SELECT id FROM public.servers WHERE is_local_server = false)
  AND ap_id IS NULL
  AND is_remote IS NOT TRUE;

DELETE FROM public.channel_categories
WHERE server_id IN (SELECT id FROM public.servers WHERE is_local_server = false)
  AND name IN ('Text Channels', 'Voice Channels');

-- Also fix any user_servers rows that are stuck at 'pending' for remote
-- servers where the Accept was never processed (due to the ActivityProcessor
-- bug that only handled Follow accepts, not Join accepts).
UPDATE public.user_servers us
SET status = 'accepted'
WHERE us.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM public.servers s
    WHERE s.id = us.server_id
      AND s.is_local_server = false
  )
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = us.user_id
      AND p.is_local = true
  );

COMMIT;
