-- A member from another instance is told when a local server removes them. Federation off
-- (20261025100002) refuses their instance's reads, and a kick or ban deletes the row here only;
-- without the Group's Remove their instance keeps a server that has gone silent.
--
--   federation_member_removals   one row per remote member removed from a local server: reason
--                                'federation_closed', 'kick' or 'ban', and delivered_at once the
--                                federation backend has handed the Group's Remove to delivery.
--                                Its insert trigger queues job 'federate-member-removal', and is
--                                one of the federation triggers a maintenance window disables;
--                                the backend's 60 s sweep requeues rows undelivered after 5 min.
--   remove_members_from_other_instances(server)
--                                for a local server with federation off: every accepted or pending
--                                member whose profile is not local gets a removal row and loses
--                                the membership, without a "has left" system message.
--   servers trigger              federation_enabled true -> not true runs it.
--   server_membership_events     a kick or ban of a remote member on a local server records one.
--   user_servers.join_activity_id
--                                on the member's instance: the id of the Join that /servers/join
--                                sent. processReject removes only the membership its Reject names.
--
-- Servers already off with remote members at upgrade get the removal once, below.

BEGIN;

CREATE TABLE IF NOT EXISTS public.federation_member_removals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason text NOT NULL CONSTRAINT federation_member_removals_reason_check
        CHECK (reason IN ('federation_closed', 'kick', 'ban')),
    summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_federation_member_removals_undelivered
    ON public.federation_member_removals (created_at) WHERE delivered_at IS NULL;
ALTER TABLE public.federation_member_removals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS federation_member_removals_service_role ON public.federation_member_removals;
CREATE POLICY federation_member_removals_service_role ON public.federation_member_removals
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.federation_member_removals FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.federation_member_removals TO service_role;
COMMENT ON TABLE public.federation_member_removals IS
    'Remote members removed from a local server (federation off, kick, ban); the Group''s Remove to their instance is delivered from here.';

ALTER TABLE public.user_servers ADD COLUMN IF NOT EXISTS join_activity_id text;
COMMENT ON COLUMN public.user_servers.join_activity_id IS
    'Membership of a remote server: id of the Join this instance sent. A Reject removes the membership only when its object is this Join.';

CREATE OR REPLACE FUNCTION public.remove_members_from_other_instances(p_server_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_member record;
    v_count integer := 0;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.servers s
         WHERE s.id = p_server_id
           AND s.is_local_server IS NOT FALSE
           AND s.federation_enabled IS NOT TRUE
    ) THEN
        RETURN 0;
    END IF;

    -- Kick and ban post their own system message; a mass removal posts none.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    FOR v_member IN
        SELECT us.id AS membership_id, us.user_id
          FROM public.user_servers us
          JOIN public.profiles p ON p.id = us.user_id
         WHERE us.server_id = p_server_id
           AND us.status IN ('accepted', 'pending')
           AND p.is_local IS FALSE
           AND p.federated_id IS NOT NULL
    LOOP
        INSERT INTO public.federation_member_removals (server_id, profile_id, reason)
        VALUES (p_server_id, v_member.user_id, 'federation_closed');

        DELETE FROM public.user_servers WHERE id = v_member.membership_id;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_members_from_other_instances(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_members_from_other_instances(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_federation_closed_removals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.federation_enabled IS TRUE AND NEW.federation_enabled IS NOT TRUE
       AND NEW.is_local_server IS NOT FALSE THEN
        PERFORM public.remove_members_from_other_instances(NEW.id);
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_federation_closed_removals() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_servers_federation_closed_removals ON public.servers;
CREATE TRIGGER z_servers_federation_closed_removals
    AFTER UPDATE OF federation_enabled ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_federation_closed_removals();

CREATE OR REPLACE FUNCTION public.trigger_remote_member_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.user_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = NEW.server_id AND s.is_local_server IS NOT FALSE)
       OR NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.id = NEW.user_id AND p.is_local IS FALSE AND p.federated_id IS NOT NULL)
    THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.federation_member_removals (server_id, profile_id, reason, summary)
    VALUES (NEW.server_id, NEW.user_id, NEW.event_type,
            left(nullif(btrim(NEW.payload->>'reason'), ''), 300));
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_remote_member_removal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_membership_events_remote_removal ON public.server_membership_events;
CREATE TRIGGER z_membership_events_remote_removal
    AFTER INSERT ON public.server_membership_events
    FOR EACH ROW
    WHEN (NEW.event_type IN ('kick', 'ban'))
    EXECUTE FUNCTION public.trigger_remote_member_removal();

CREATE OR REPLACE FUNCTION public.trigger_queue_member_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.queue_federation_job(
        'federate-member-removal',
        jsonb_build_object('type', 'delete', 'removal_id', NEW.id));
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_member_removal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_federate_member_removal ON public.federation_member_removals;
CREATE TRIGGER trigger_federate_member_removal
    AFTER INSERT ON public.federation_member_removals
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_member_removal();

-- As 20261017100005_voice_moderation_followups.sql, with trigger_federate_member_removal.
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
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
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
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
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
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

-- Upgrade: servers already closed while members from other instances remained.
DO $$
BEGIN
    PERFORM public.remove_members_from_other_instances(s.id)
       FROM public.servers s
      WHERE s.is_local_server IS NOT FALSE
        AND s.federation_enabled IS NOT TRUE
        AND EXISTS (
             SELECT 1 FROM public.user_servers us
               JOIN public.profiles p ON p.id = us.user_id
              WHERE us.server_id = s.id
                AND us.status IN ('accepted', 'pending')
                AND p.is_local IS FALSE
        );
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
