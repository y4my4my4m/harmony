-- Fix ALL federation trigger functions: the init schema versions only set
-- federation_status = 'queued' but never call queue_federation_job(),
-- so outgoing federation never actually gets enqueued.
-- Covers: DMs, channel messages (send/edit/delete), channel reactions,
-- message reactions, posts, follows, post interactions, and reports.
BEGIN;

-- ==========================================================================
-- 1. DM federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_dm_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.conversation_id IS NOT NULL AND NOT (NEW.metadata ? 'federated') THEN
        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-dm',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'user_id', NEW.user_id,
                'created_at', NEW.created_at
            ),
            5, 5, 3600
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 2. Channel message federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        SELECT is_local INTO v_author_is_local
        FROM public.profiles WHERE id = NEW.user_id;

        IF v_author_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-channel-message',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_at', NEW.created_at
            ),
            5, 5, 900
        );
    END IF;

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 3. Channel message edit federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;
        IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

        SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
        IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 4. Channel message delete federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;
        IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

        SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
        IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id'
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 5. Channel reaction federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
BEGIN
    SELECT is_local INTO v_user_is_local FROM public.profiles WHERE id = NEW.user_id;
    IF v_user_is_local IS NOT TRUE THEN RETURN NEW; END IF;

    SELECT (channel_id IS NOT NULL AND conversation_id IS NULL) INTO v_is_channel_message
    FROM public.messages WHERE id = NEW.message_id;
    IF v_is_channel_message IS NOT TRUE THEN RETURN NEW; END IF;

    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 6. Channel reaction delete federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
BEGIN
    SELECT is_local INTO v_user_is_local FROM public.profiles WHERE id = OLD.user_id;
    IF v_user_is_local IS NOT TRUE THEN RETURN OLD; END IF;

    SELECT (channel_id IS NOT NULL AND conversation_id IS NULL) INTO v_is_channel_message
    FROM public.messages WHERE id = OLD.message_id;
    IF v_is_channel_message IS NOT TRUE THEN RETURN OLD; END IF;

    IF OLD.metadata ? 'federated' THEN RETURN OLD; END IF;

    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'delete',
            'reaction_id', OLD.id,
            'message_id', OLD.message_id,
            'user_id', OLD.user_id,
            'emoji_id', OLD.emoji_id,
            'custom_emoji_content', OLD.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN OLD;
END;
$$;

-- ==========================================================================
-- 7. DM reaction federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-message-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 8. Post federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local = false OR NEW.visibility NOT IN ('public', 'unlisted') THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object(
                'type', 'create',
                'post_id', NEW.id,
                'author_id', NEW.author_id,
                'visibility', NEW.visibility,
                'created_at', NEW.created_at
            ), 5, 5, 3600
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.federation_status IS DISTINCT FROM NEW.federation_status
           AND OLD.content = NEW.content
           AND OLD.is_deleted = NEW.is_deleted
           AND OLD.is_pinned = NEW.is_pinned THEN
            RETURN NEW;
        END IF;

        IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'delete', 'post_id', NEW.id, 'author_id', NEW.author_id),
                10, 5, 3600
            );
        ELSIF NEW.is_pinned IS DISTINCT FROM OLD.is_pinned THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'pin_change', 'post_id', NEW.id, 'author_id', NEW.author_id, 'is_pinned', NEW.is_pinned),
                5, 5, 3600
            );
        ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'update', 'post_id', NEW.id, 'author_id', NEW.author_id, 'visibility', NEW.visibility),
                5, 5, 3600
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 9. Follow federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_follow_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_follower_is_local BOOLEAN;
BEGIN
    SELECT is_local INTO v_follower_is_local FROM public.profiles WHERE id = NEW.follower_id;

    IF v_follower_is_local = true THEN
        IF TG_OP = 'INSERT' THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'create',
                    'follow_id', NEW.id,
                    'follower_id', NEW.follower_id,
                    'following_id', NEW.following_id,
                    'status', NEW.status
                ), 5, 5, 3600
            );
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'delete',
                    'follow_id', OLD.id,
                    'follower_id', OLD.follower_id,
                    'following_id', OLD.following_id
                ), 5, 5, 3600
            );
            RETURN OLD;
        END IF;
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 10. Post interaction federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'create',
                'interaction_id', NEW.id,
                'interaction_type', NEW.interaction_type,
                'post_id', NEW.post_id,
                'user_id', NEW.user_id,
                'emoji_id', NEW.emoji_id,
                'custom_emoji_content', NEW.custom_emoji_content
            ), 5, 3, 1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'delete',
                'interaction_id', OLD.id,
                'interaction_type', OLD.interaction_type,
                'post_id', OLD.post_id,
                'user_id', OLD.user_id
            ), 5, 3, 1800
        );
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 11. Report federation trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.trigger_queue_report_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    NEW.federation_status := 'queued';

    PERFORM public.queue_federation_job(
        'federate-report',
        jsonb_build_object(
            'type', 'create',
            'report_id', NEW.id,
            'reporter_id', NEW.reporter_id,
            'reported_user_id', NEW.reported_user_id,
            'reported_post_id', NEW.reported_post_id,
            'reason', NEW.reason
        ),
        10, 5, 7200
    );

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 12. Also pick up any items stuck with wrong federation_status
-- ==========================================================================
UPDATE public.messages
SET federation_status = 'pending'
WHERE federation_status = 'queued'
  AND created_at > NOW() - INTERVAL '24 hours';

UPDATE public.posts
SET federation_status = 'pending'
WHERE federation_status = 'queued'
  AND is_local = true
  AND created_at > NOW() - INTERVAL '24 hours';

UPDATE public.follows
SET federation_status = 'pending'
WHERE federation_status = 'queued'
  AND created_at > NOW() - INTERVAL '24 hours';

UPDATE public.post_interactions
SET federation_status = 'pending'
WHERE federation_status = 'queued'
  AND created_at > NOW() - INTERVAL '24 hours';

COMMIT;
