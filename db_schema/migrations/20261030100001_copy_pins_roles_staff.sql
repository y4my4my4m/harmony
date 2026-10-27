-- What a member instance shows of a server hosted elsewhere: its pins, its roles and the
-- instance staff of its members (federation-backend activitypub/copyMirror.ts).
--
--   messages.is_pinned            a change in a local server's channel queues
--                                 federate-channel-pin: the Group's Add or Remove of the Note in
--                                 <channel>/pins, to the instances whose members view the channel.
--                                 Encrypted channels, deleted rows, notices that never federate and
--                                 copies queue nothing.
--   server_roles                  a change of a local server's role that a copy shows (name,
--                                 colour, position, hoist, mentionable, emoji) queues
--                                 federate-server-update; the Group's Update carries harmony:roles.
--                                 The default role is not on the wire.
--   user_roles                    an assignment of a local server queues federate-member-roles: the
--                                 Group's Update(harmony:MemberRoles) naming all the member's
--                                 roles. A role's own deletion cascading here queues nothing.
--   prevent_protected_role_deletion
--                                 a copy's Admin role may go: a copy's roles are the host's.
--   federation_server_recipients  the member instances of a server with the shared inbox their
--                                 accounts name, for the Group's server-wide activities.
--   profiles.instance_role        'admin' or 'moderator': the staff role a remote account holds on
--                                 its own instance, from its actor's harmony:instanceRole. NULL on
--                                 local accounts (is_admin and is_moderator are theirs); written by
--                                 the service role only.
--   trigger_queue_profile_federation
--                                 is_admin and is_moderator federate: a local account's actor carries
--                                 harmony:instanceRole.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Pins
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_pin_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.is_deleted IS TRUE
       OR NEW.is_pinned IS NOT DISTINCT FROM OLD.is_pinned THEN
        RETURN NULL;
    END IF;

    -- Notices other than member events have no Note (LIVE_SYSTEM_NOTE_TYPES, systemNotes.ts).
    IF NEW.is_system IS TRUE
       AND COALESCE(NEW.metadata ->> 'type', '') NOT IN ('member_join', 'member_leave', 'member_kick', 'member_ban') THEN
        RETURN NULL;
    END IF;

    IF NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id) THEN
        RETURN NULL;
    END IF;

    SELECT c.server_id INTO v_server_id
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = NEW.channel_id
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-channel-pin',
        jsonb_build_object(
            'type', 'update',
            'message_id', NEW.id,
            'channel_id', NEW.channel_id,
            'server_id', v_server_id,
            'pinned', NEW.is_pinned IS TRUE
        ),
        5, 5, 900
    );
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_channel_pin_federation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_messages_pin_federation ON public.messages;
CREATE TRIGGER z_messages_pin_federation
    AFTER UPDATE OF is_pinned ON public.messages
    FOR EACH ROW
    WHEN (OLD.is_pinned IS DISTINCT FROM NEW.is_pinned)
    EXECUTE FUNCTION public.trigger_queue_channel_pin_federation();

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_queue_server_roles_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.name IS NOT DISTINCT FROM NEW.name
           AND OLD.color IS NOT DISTINCT FROM NEW.color
           AND OLD.position IS NOT DISTINCT FROM NEW.position
           AND OLD.hoist IS NOT DISTINCT FROM NEW.hoist
           AND OLD.mentionable IS NOT DISTINCT FROM NEW.mentionable
           AND OLD.unicode_emoji IS NOT DISTINCT FROM NEW.unicode_emoji
           AND OLD.is_default IS NOT DISTINCT FROM NEW.is_default THEN
            RETURN NULL;
        END IF;
        IF OLD.is_default IS TRUE AND NEW.is_default IS TRUE THEN
            RETURN NULL;
        END IF;
        v_server_id := NEW.server_id;
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.is_default IS TRUE THEN
            RETURN NULL;
        END IF;
        v_server_id := NEW.server_id;
    ELSE
        IF OLD.is_default IS TRUE THEN
            RETURN NULL;
        END IF;
        v_server_id := OLD.server_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.servers s
         WHERE s.id = v_server_id AND s.is_local_server IS TRUE AND s.federation_enabled IS TRUE
    ) THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-server-update',
        jsonb_build_object('type', 'update', 'server_id', v_server_id),
        5, 5, 900
    );
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_server_roles_federation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_server_roles_federation ON public.server_roles;
CREATE TRIGGER z_server_roles_federation
    AFTER INSERT OR UPDATE OR DELETE ON public.server_roles
    FOR EACH ROW EXECUTE FUNCTION public.trigger_queue_server_roles_federation();

CREATE OR REPLACE FUNCTION public.trigger_queue_member_roles_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_user_id uuid;
    v_role_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_server_id := OLD.server_id;
        v_user_id := OLD.user_id;
        v_role_id := OLD.role_id;
    ELSE
        v_server_id := NEW.server_id;
        v_user_id := NEW.user_id;
        v_role_id := NEW.role_id;
    END IF;

    -- Absent: the role's own deletion cascades here, and the Group's Update drops it.
    IF NOT EXISTS (SELECT 1 FROM public.server_roles r WHERE r.id = v_role_id AND r.is_default IS NOT TRUE) THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.servers s
         WHERE s.id = v_server_id AND s.is_local_server IS TRUE AND s.federation_enabled IS TRUE
    ) THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-member-roles',
        jsonb_build_object('type', 'update', 'server_id', v_server_id, 'user_id', v_user_id),
        5, 5, 900
    );
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_member_roles_federation() FROM PUBLIC, anon, authenticated;

-- As 20260101000000_baseline.sql, except on a copy: its roles are the host's, and the Admin role
-- create_default_server_role gave it goes when the host's roles arrive. Clients delete no role of
-- a copy (RLS, 20261027200001).
CREATE OR REPLACE FUNCTION public.prevent_protected_role_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id) THEN
        RETURN OLD;
    END IF;

    IF OLD.is_admin = true
       AND NOT EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id AND is_local_server IS FALSE) THEN
        RAISE EXCEPTION 'Cannot delete the Admin role. This role is protected.';
    END IF;

    IF OLD.is_default = true THEN
        RAISE EXCEPTION 'Cannot delete the @everyone role. This role is protected.';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS z_user_roles_federation ON public.user_roles;
CREATE TRIGGER z_user_roles_federation
    AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.trigger_queue_member_roles_federation();

-- Instances to tell about a server, as federation_channel_recipients names those of a channel:
-- accepted, unbanned, unsuspended remote members grouped by instance, with the shared inbox their
-- profiles name. get_server_members_by_instance names no inbox; a Group's Update went to
-- https://<account domain>/inbox, which a split-domain account's instance does not serve.
CREATE OR REPLACE FUNCTION public.federation_server_recipients(p_server_id uuid)
RETURNS TABLE(instance text, member_ap_ids text[], member_count integer, shared_inbox text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT lower(p.domain) AS instance,
           array_agg(p.federated_id ORDER BY p.federated_id) AS member_ap_ids,
           count(*)::integer AS member_count,
           (array_agg(p.shared_inbox_url ORDER BY p.shared_inbox_url)
                FILTER (WHERE p.shared_inbox_url IS NOT NULL))[1] AS shared_inbox
      FROM public.servers s
      JOIN public.user_servers us ON us.server_id = s.id AND us.status = 'accepted'
      JOIN public.profiles p ON p.id = us.user_id
     WHERE s.id = p_server_id
       AND s.federation_enabled IS TRUE
       AND p.is_local IS FALSE
       AND p.is_suspended IS NOT TRUE
       AND p.federated_id IS NOT NULL
       AND p.domain IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM public.server_bans b
             WHERE b.server_id = s.id AND b.user_id = p.id
       )
     GROUP BY lower(p.domain);
$$;

REVOKE ALL ON FUNCTION public.federation_server_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_server_recipients(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Instance staff of remote accounts
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS instance_role text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'profiles_instance_role_check' AND conrelid = 'public.profiles'::regclass
    ) THEN
        ALTER TABLE public.profiles ADD CONSTRAINT profiles_instance_role_check
            CHECK (instance_role IS NULL OR (instance_role IN ('admin', 'moderator') AND is_local IS FALSE));
    END IF;
END;
$$;

COMMENT ON COLUMN public.profiles.instance_role IS
    'Staff role (admin, moderator) a remote account holds on its own instance, from its actor''s harmony:instanceRole. NULL on local accounts.';

-- A client cannot name itself or anyone staff of an instance.
CREATE OR REPLACE FUNCTION public.guard_profile_instance_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated') THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.instance_role := NULL;
    ELSIF NEW.instance_role IS DISTINCT FROM OLD.instance_role THEN
        RAISE EXCEPTION 'instance_role is set from the account''s own instance' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_instance_role() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_profiles_instance_role_guard ON public.profiles;
CREATE TRIGGER a_profiles_instance_role_guard
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_profile_instance_role();

-- As 20261021200001_ap_conformance.sql, with is_admin and is_moderator.
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local != true OR NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status AND
            OLD.also_known_as IS NOT DISTINCT FROM NEW.also_known_as AND
            OLD.moved_to_uri IS NOT DISTINCT FROM NEW.moved_to_uri AND
            OLD.manually_approves_followers IS NOT DISTINCT FROM NEW.manually_approves_followers AND
            OLD.profile_fields IS NOT DISTINCT FROM NEW.profile_fields AND
            OLD.federation_discoverable IS NOT DISTINCT FROM NEW.federation_discoverable AND
            OLD.color IS NOT DISTINCT FROM NEW.color AND
            OLD.federation_metadata IS NOT DISTINCT FROM NEW.federation_metadata AND
            OLD.is_admin IS NOT DISTINCT FROM NEW.is_admin AND
            OLD.is_moderator IS NOT DISTINCT FROM NEW.is_moderator
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-profile',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'profile_id', NEW.id,
            'username', NEW.username,
            'display_name', NEW.display_name,
            'bio', NEW.bio,
            'avatar_url', NEW.avatar_url,
            'banner_url', NEW.banner_url,
            'custom_status', NEW.custom_status
        ),
        3, 5, 3600
    );

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trigger_queue_profile_federation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trigger switches
-- ---------------------------------------------------------------------------

-- As 20261027400001_report_routing.sql, with the pin, role and assignment triggers.
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
