-- A deletion that leaves a thread with no message deletes the thread.
--
-- A thread holds a message while one of its replies (messages.thread_id) is live, or its parent
-- is a live message; live is is_deleted and is_system both not true. A standalone thread's
-- parent is its 'started a thread' notice, a system row: its replies alone count. A thread
-- started from a channel message holds its starter while the starter is live.
--
-- delete_emptied_thread runs after a message's soft delete (is_deleted becoming true) or hard
-- delete, by any path: client PATCH, bot hard delete, ban and kick history deletes, report and
-- staff removals, federated Deletes. Each thread the row was a reply in or the parent of is
-- locked, then deleted once it holds no message, by the DELETE a manual thread delete issues:
-- thread_members and discord_bridge_threads cascade, broadcast_thread_change sends
-- thread:delete, trigger_queue_thread_delete_federation queues its Delete. The lock orders two
-- concurrent deletions of a thread's last two messages: the later one sees the earlier commit.
-- A thread of a copy (servers.is_local_server false) is its host's; the host's Delete arrives
-- through federation (ThreadActivityHandler).
--
-- trigger_queue_thread_delete_federation runs after any thread delete in a local server with
-- federation on and queues federate-thread {type: 'delete'} with the row's ids, as the row is
-- gone when the job runs. A thread whose channel is gone queues nothing: the channel's Delete
-- removes it on member instances. enable_federation_triggers and disable_federation_triggers
-- name its trigger.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.delete_emptied_thread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_thread record;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.is_deleted IS NOT TRUE THEN
        RETURN NULL;
    END IF;

    FOR v_thread IN
        SELECT t.id, t.parent_message_id
          FROM public.threads t
          JOIN public.channels c ON c.id = t.channel_id
          JOIN public.servers s ON s.id = c.server_id
         WHERE (t.id = OLD.thread_id OR t.parent_message_id = OLD.id)
           AND s.is_local_server IS TRUE
         ORDER BY t.id
           FOR UPDATE OF t
    LOOP
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.messages m
             WHERE m.thread_id = v_thread.id
               AND m.is_deleted IS NOT TRUE
               AND m.is_system IS NOT TRUE);
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.messages p
             WHERE p.id = v_thread.parent_message_id
               AND p.is_deleted IS NOT TRUE
               AND p.is_system IS NOT TRUE);
        DELETE FROM public.threads WHERE id = v_thread.id;
    END LOOP;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_emptied_thread() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_emptied_thread() TO service_role;

-- WHEN reads OLD only: a trigger on DELETE cannot name NEW.
DROP TRIGGER IF EXISTS z_messages_empty_thread_delete ON public.messages;
CREATE TRIGGER z_messages_empty_thread_delete
    AFTER UPDATE OF is_deleted OR DELETE ON public.messages
    FOR EACH ROW
    WHEN ((OLD.channel_id IS NOT NULL OR OLD.thread_id IS NOT NULL)
          AND OLD.is_deleted IS NOT TRUE AND OLD.is_system IS NOT TRUE)
    EXECUTE FUNCTION public.delete_emptied_thread();

CREATE OR REPLACE FUNCTION public.trigger_queue_thread_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    SELECT s.id INTO v_server_id
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = OLD.channel_id
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-thread',
        jsonb_build_object(
            'type', 'delete', 'thread_id', OLD.id, 'ap_id', OLD.ap_id,
            'channel_id', OLD.channel_id, 'server_id', v_server_id, 'server_is_local', true,
            'created_by', OLD.created_by
        ), 5, 5, 900
    );
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_thread_delete_federation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_queue_thread_delete_federation() TO service_role;

DROP TRIGGER IF EXISTS trigger_federate_thread_delete ON public.threads;
CREATE TRIGGER trigger_federate_thread_delete
    AFTER DELETE ON public.threads
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_thread_delete_federation();

-- As 20261030100001, plus trigger_federate_thread_delete.
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
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

COMMIT;
