-- A server's custom emojis on its copies (federation-backend activitypub/copyMirror.ts,
-- services/CopyMirrorService.ts).
--
--   emojis.ap_id           on a copy, the id the host's Group gives the emoji:
--                          <group>/emojis/<host emoji uuid>. NULL on every other row. One row per
--                          id per server (emojis_server_ap_id_key). Written by the service role
--                          from the Group's harmony:emojis; the row's url is the host's image,
--                          domain the host.
--   trigger_queue_server_emojis_federation
--                          a change of a local federated server's emoji that a copy shows (added,
--                          removed, restored, renamed, image) queues federate-server-update; the
--                          Group's Update carries harmony:emojis. Copies, personal and instance
--                          emojis queue nothing.
--   enable_federation_triggers / disable_federation_triggers
--                          as 20261109900001, with z_emojis_federation.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS ap_id text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emojis_ap_id_check') THEN
        ALTER TABLE public.emojis ADD CONSTRAINT emojis_ap_id_check
            CHECK (ap_id IS NULL OR (char_length(ap_id) <= 2048 AND ap_id ~ '^https?://'));
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS emojis_server_ap_id_key
    ON public.emojis (server_id, ap_id) WHERE ap_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trigger_queue_server_emojis_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_old uuid;
    v_new uuid;
    v_server_id uuid;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.name IS NOT DISTINCT FROM NEW.name
       AND OLD.url IS NOT DISTINCT FROM NEW.url
       AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at
       AND OLD.server_id IS NOT DISTINCT FROM NEW.server_id
       AND OLD.scope IS NOT DISTINCT FROM NEW.scope THEN
        RETURN NULL;
    END IF;

    IF TG_OP <> 'INSERT' AND OLD.scope = 'server' THEN
        v_old := OLD.server_id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.scope = 'server' THEN
        v_new := NEW.server_id;
    END IF;
    IF v_new IS NOT DISTINCT FROM v_old THEN
        v_new := NULL;
    END IF;

    -- A row moving between servers changes both lists.
    FOREACH v_server_id IN ARRAY ARRAY[v_old, v_new] LOOP
        CONTINUE WHEN v_server_id IS NULL;
        IF EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = v_server_id AND s.is_local_server IS TRUE AND s.federation_enabled IS TRUE
        ) THEN
            PERFORM public.queue_federation_job(
                'federate-server-update',
                jsonb_build_object('type', 'update', 'server_id', v_server_id),
                5, 5, 900
            );
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_server_emojis_federation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_emojis_federation ON public.emojis;
CREATE TRIGGER z_emojis_federation
    AFTER INSERT OR UPDATE OR DELETE ON public.emojis
    FOR EACH ROW EXECUTE FUNCTION public.trigger_queue_server_emojis_federation();

-- As 20261109900001, with z_emojis_federation.
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report_resolution;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread_delete;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers ENABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation ENABLE TRIGGER z_server_voice_moderation_federate;
    ALTER TABLE public.federation_member_removals ENABLE TRIGGER trigger_federate_member_removal;
    ALTER TABLE public.messages ENABLE TRIGGER z_messages_pin_federation;
    ALTER TABLE public.server_roles ENABLE TRIGGER z_server_roles_federation;
    ALTER TABLE public.user_roles ENABLE TRIGGER z_user_roles_federation;
    ALTER TABLE public.channel_encryption_settings ENABLE TRIGGER trigger_federate_channel_encryption;
    ALTER TABLE public.server_encryption_settings ENABLE TRIGGER trigger_federate_server_encryption;
    ALTER TABLE public.channel_permission_overrides ENABLE TRIGGER trigger_federate_channel_private;
    ALTER TABLE public.channel_category_permission_overrides ENABLE TRIGGER trigger_federate_category_private;
    ALTER TABLE public.emojis ENABLE TRIGGER z_emojis_federation;
    RAISE NOTICE 'All federation triggers enabled';
END;
$$;

REVOKE ALL ON FUNCTION public.enable_federation_triggers() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report_resolution;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread_delete;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers DISABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation DISABLE TRIGGER z_server_voice_moderation_federate;
    ALTER TABLE public.federation_member_removals DISABLE TRIGGER trigger_federate_member_removal;
    ALTER TABLE public.messages DISABLE TRIGGER z_messages_pin_federation;
    ALTER TABLE public.server_roles DISABLE TRIGGER z_server_roles_federation;
    ALTER TABLE public.user_roles DISABLE TRIGGER z_user_roles_federation;
    ALTER TABLE public.channel_encryption_settings DISABLE TRIGGER trigger_federate_channel_encryption;
    ALTER TABLE public.server_encryption_settings DISABLE TRIGGER trigger_federate_server_encryption;
    ALTER TABLE public.channel_permission_overrides DISABLE TRIGGER trigger_federate_channel_private;
    ALTER TABLE public.channel_category_permission_overrides DISABLE TRIGGER trigger_federate_category_private;
    ALTER TABLE public.emojis DISABLE TRIGGER z_emojis_federation;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
