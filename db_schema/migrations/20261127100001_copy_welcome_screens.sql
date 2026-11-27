-- A server's welcome screen and rules on its copies (federation-backend activitypub/groupWelcome.ts).
--
--   server_welcome_screens  on a copy, the host's screen as the Group's harmony:welcome gives it,
--                           written by the service role. get_server_welcome, accept_server_rules
--                           and enforce_server_rules_acceptance (20261006300001) read a copy's row
--                           as a local server's: a member must accept the rules on their own
--                           instance before their messages to the copy are stored and sent.
--                           set_server_welcome refuses a copy.
--   trigger_queue_server_welcome_federation
--                           a change of a local federated server's screen queues
--                           federate-server-update; the Group's Update carries harmony:welcome.
--                           A copy's screen queues nothing.
--   enable_federation_triggers / disable_federation_triggers
--                           as 20261114200001, with z_server_welcome_screens_federation.
--   get_server_welcome      as 20261006300001, with can_manage false rather than NULL for a server
--                           with no owner, which is a copy whose Group names none: NULL made
--                           must_accept NULL, and the message box offered no Accept rules.
BEGIN;

SET LOCAL lock_timeout = '3s';

-- Members and managers only. message is empty for members while the screen is disabled.
CREATE OR REPLACE FUNCTION public.get_server_welcome(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_srv public.servers%ROWTYPE;
    v_scr public.server_welcome_screens%ROWTYPE;
    v_has_screen boolean;
    v_is_member boolean;
    v_joined timestamptz;
    v_seen timestamptz;
    v_accepted timestamptz;
    v_manager boolean;
    v_enabled boolean;
    v_require boolean;
    v_must_accept boolean;
    v_rules jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_srv FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SERVER_NOT_FOUND: no such server' USING ERRCODE = 'P0002';
    END IF;

    SELECT us.created_at, us.welcome_seen_at, us.rules_accepted_at
      INTO v_joined, v_seen, v_accepted
      FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted';
    v_is_member := FOUND;

    -- has_permission grants the owner every permission.
    v_manager := COALESCE(v_srv.owner = v_me
                          OR (v_is_member AND public.has_permission(v_me, p_server_id, 'MANAGE_SERVER')), false);
    IF NOT v_is_member AND NOT v_manager THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_scr FROM public.server_welcome_screens w WHERE w.server_id = p_server_id;
    v_has_screen := FOUND;
    v_enabled := v_has_screen AND v_scr.enabled;
    v_require := v_has_screen AND v_scr.require_acceptance;

    IF v_has_screen THEN
        v_rules := v_scr.rules;
    ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object('title', e.value #>> '{}', 'description', '')
                                  ORDER BY e.ordinality), '[]'::jsonb)
          INTO v_rules
          FROM jsonb_array_elements(COALESCE(v_srv.rules, '[]'::jsonb)) WITH ORDINALITY AS e(value, ordinality)
         WHERE jsonb_typeof(e.value) = 'string' AND btrim(e.value #>> '{}') <> '';
    END IF;

    v_must_accept := v_is_member AND v_require AND v_accepted IS NULL
                     AND v_joined >= v_scr.acceptance_required_at AND NOT v_manager;

    RETURN jsonb_build_object(
        'server_id', v_srv.id,
        'name', v_srv.name,
        'description', v_srv.description,
        'icon', v_srv.icon,
        'banner', v_srv.banner,
        'is_local', v_srv.is_local_server IS NOT FALSE,
        'configured', v_has_screen,
        'enabled', v_enabled,
        'message', CASE WHEN v_enabled OR v_manager THEN COALESCE(v_scr.message, '') ELSE '' END,
        'rules', v_rules,
        'require_acceptance', v_require,
        'can_manage', v_manager,
        'is_member', v_is_member,
        'joined_at', v_joined,
        'welcome_seen_at', v_seen,
        'rules_accepted_at', v_accepted,
        'must_accept', v_must_accept,
        'should_show', v_is_member AND v_seen IS NULL AND v_srv.owner IS DISTINCT FROM v_me
                       AND (v_must_accept OR (v_enabled AND v_joined >= v_scr.enabled_at)));
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_queue_server_welcome_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.enabled IS NOT DISTINCT FROM NEW.enabled
       AND OLD.message IS NOT DISTINCT FROM NEW.message
       AND OLD.rules IS NOT DISTINCT FROM NEW.rules
       AND OLD.require_acceptance IS NOT DISTINCT FROM NEW.require_acceptance
       AND OLD.enabled_at IS NOT DISTINCT FROM NEW.enabled_at
       AND OLD.acceptance_required_at IS NOT DISTINCT FROM NEW.acceptance_required_at THEN
        RETURN NULL;
    END IF;

    v_server_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.server_id ELSE NEW.server_id END;
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
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_server_welcome_federation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_server_welcome_screens_federation ON public.server_welcome_screens;
CREATE TRIGGER z_server_welcome_screens_federation
    AFTER INSERT OR UPDATE OR DELETE ON public.server_welcome_screens
    FOR EACH ROW EXECUTE FUNCTION public.trigger_queue_server_welcome_federation();

-- As 20261114200001, with z_server_welcome_screens_federation.
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
    ALTER TABLE public.server_welcome_screens ENABLE TRIGGER z_server_welcome_screens_federation;
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
    ALTER TABLE public.server_welcome_screens DISABLE TRIGGER z_server_welcome_screens_federation;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
