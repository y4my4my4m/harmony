-- Do not send "You were added to ..." for 1:1 DM creation.
-- Also skip the creator of a group (they know they just created it).
-- Only notify non-creator participants of 'group' conversations.
BEGIN;

CREATE OR REPLACE FUNCTION public.handle_conversation_participant_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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

COMMIT;
