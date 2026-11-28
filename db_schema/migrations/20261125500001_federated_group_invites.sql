-- A group invite from another instance adds the people it names.
--
-- The invite is a Create of a Note with metadata.type 'group_invite', sent to each person added
-- (groupInviteHandler.ts). The first one to reach this instance makes its copy of the group, with
-- the inviter and the people named in it. get_or_create_federated_group_conversation, which a
-- plain message goes through too, returns a copy it finds as it is.
--
-- apply_federated_group_invite(actor, recipients, remote conversation id), service role only:
--   * takes the local recipients whose dm_policy admits the actor and who hold no block with it
--     (dm_recipients_allowing), the rules dm_start_guard holds a local add to;
--   * finds or makes the copy, and answers null, nothing written, for one the actor is not an
--     active participant of (add_user_to_conversation's rule);
--   * adds the recipients that are not active participants, those who left included;
--   * answers {conversation_id, added}: added are the recipients this call made participants.
-- Messages join nobody to a copy that exists. Invites of one group take turns: a group made with two
-- people of this instance sends one to each at once, and both find one copy.
--
-- A person added reads the group's earlier messages, as one add_user_to_conversation adds does:
-- reading a conversation asks for active participation, not for when it began.
--
-- b_group_conversation_limit (20261116100001) lets the service role add to a group whose creator
-- is remote whatever its size, and holds a group made here to 10 (GROUP_CONVERSATION_FULL:10).
--
-- handle_conversation_participant_added: a local participant added under harmony.group_invite = '1'
-- gets no notice from the trigger; ActivityProcessor sends the invite's, which carries the group's
-- name as its host knows it. The copy holds no name until its host sends one.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.handle_conversation_participant_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_conversation conversations%ROWTYPE;
    v_inviter profiles%ROWTYPE;
    v_added_profile profiles%ROWTYPE;
    v_conversation_name TEXT;
BEGIN
    IF NEW.left_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_conversation FROM conversations WHERE id = NEW.conversation_id;

    -- Only notify for group conversations; 1:1 DMs (type='direct') need no invite notification.
    IF v_conversation.type != 'group' THEN
        RETURN NEW;
    END IF;

    -- Don't notify the creator of the group - they already know they created it.
    IF NEW.user_id = v_conversation.created_by THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_added_profile FROM profiles WHERE id = NEW.user_id;

    IF v_added_profile.is_local THEN
        IF current_setting('harmony.group_invite', true) = '1' THEN
            RETURN NEW;
        END IF;

        v_conversation_name := COALESCE(NULLIF(TRIM(v_conversation.name), ''), 'a group conversation');

        SELECT p.* INTO v_inviter
        FROM conversation_participants cp
        JOIN profiles p ON p.id = cp.user_id
        WHERE cp.conversation_id = NEW.conversation_id AND cp.user_id != NEW.user_id AND cp.role = 'admin'
        ORDER BY cp.joined_at ASC LIMIT 1;

        PERFORM send_notification_to_user('dm', NEW.user_id,
            jsonb_build_object(
                'sender', jsonb_build_object('user_id', COALESCE(v_inviter.id, '00000000-0000-0000-0000-000000000000'),
                    'username', COALESCE(v_inviter.username, 'system'),
                    'display_name', COALESCE(v_inviter.display_name, v_inviter.username, 'System'),
                    'avatar_url', v_inviter.avatar_url),
                'conversation', jsonb_build_object('id', NEW.conversation_id, 'name', v_conversation_name),
                'conversation_id', NEW.conversation_id, 'preview', 'You were added to ' || v_conversation_name, 'is_invite', true),
            NULL, NULL, NEW.conversation_id, v_inviter.id, 'normal');
    ELSIF v_added_profile.inbox_url IS NOT NULL AND v_added_profile.inbox_url != '' THEN
        SELECT p.* INTO v_inviter
        FROM conversation_participants cp JOIN profiles p ON p.id = cp.user_id
        WHERE cp.conversation_id = NEW.conversation_id AND cp.user_id != NEW.user_id AND cp.role = 'admin'
        ORDER BY cp.joined_at ASC LIMIT 1;

        PERFORM public.queue_federation_job('federate-group-invite',
            jsonb_build_object('conversation_id', NEW.conversation_id,
                'inviter_id', COALESCE(v_inviter.id, (SELECT created_by FROM conversations WHERE id = NEW.conversation_id)),
                'invited_user_id', NEW.user_id),
            5, 5, 3600);
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Conversation participant notification failed: %', SQLERRM;
        RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_federated_group_invite(
    p_actor_id uuid,
    p_recipient_ids uuid[],
    p_remote_conversation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ids uuid[];
    v_before uuid[];
    v_conversation_id uuid;
    v_prev text := current_setting('harmony.group_invite', true);
BEGIN
    SELECT array_agg(p.id) INTO v_ids
      FROM public.profiles p
     WHERE p.id = ANY (public.dm_recipients_allowing(p_actor_id, p_recipient_ids))
       AND p.is_local
       AND p.id <> p_actor_id;
    IF v_ids IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(array_agg(cp.id), '{}') INTO v_before
      FROM public.conversation_participants cp
     WHERE cp.user_id = ANY (v_ids) AND cp.left_at IS NULL;

    IF p_remote_conversation_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('federated_group:' || p_remote_conversation_id, 0));
    END IF;

    PERFORM set_config('harmony.group_invite', '1', true);

    v_conversation_id := public.get_or_create_federated_group_conversation(p_actor_id, v_ids, p_remote_conversation_id);

    IF NOT EXISTS (SELECT 1 FROM public.conversation_participants cp
                    WHERE cp.conversation_id = v_conversation_id
                      AND cp.user_id = p_actor_id
                      AND cp.left_at IS NULL) THEN
        PERFORM set_config('harmony.group_invite', COALESCE(v_prev, ''), true);
        RETURN NULL;
    END IF;

    INSERT INTO public.conversation_participants (conversation_id, user_id, role)
    SELECT v_conversation_id, r, 'member'
      FROM unnest(v_ids) r
     WHERE NOT EXISTS (SELECT 1 FROM public.conversation_participants cp
                        WHERE cp.conversation_id = v_conversation_id
                          AND cp.user_id = r
                          AND cp.left_at IS NULL)
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL;

    PERFORM set_config('harmony.group_invite', COALESCE(v_prev, ''), true);

    RETURN jsonb_build_object(
        'conversation_id', v_conversation_id,
        'added', (SELECT COALESCE(jsonb_agg(cp.user_id), '[]'::jsonb)
                    FROM public.conversation_participants cp
                   WHERE cp.conversation_id = v_conversation_id
                     AND cp.user_id = ANY (v_ids)
                     AND cp.left_at IS NULL
                     AND NOT (cp.id = ANY (v_before))));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_federated_group_invite(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_federated_group_invite(uuid, uuid[], text) TO service_role;

COMMIT;
