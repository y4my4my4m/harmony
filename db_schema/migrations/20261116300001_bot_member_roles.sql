-- Bot API: member roles.
--
-- bot-gateway's PUT and DELETE /servers/:id/members/:user/roles/:role write user_roles with the
-- service role and log member_role_added / member_role_removed in bot_audit_log, metadata
-- { server_id, user_id, role_id }. server_audit_user_roles writes those changes as
-- member.role_add / member.role_remove with target_id the member and details.role_id the role,
-- source 'system' and no actor; server_audit_attribute_bot now credits them to the bot, matching
-- the member and the role. The other actions are unchanged from 20261112300001.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.server_audit_attribute_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meta jsonb := COALESCE(NEW.metadata, '{}'::jsonb);
    v_actions text[];
    v_target text;
    v_server text;
    v_role text;
BEGIN
    v_actions := CASE NEW.action_type
        WHEN 'channel_created' THEN ARRAY['channel.create']
        WHEN 'category_created' THEN ARRAY['category.create']
        WHEN 'role_created' THEN ARRAY['role.create']
        WHEN 'role_updated' THEN ARRAY['role.update']
        WHEN 'role_deleted' THEN ARRAY['role.delete']
        WHEN 'emoji_imported' THEN ARRAY['emoji.create']
        WHEN 'emoji_updated' THEN ARRAY['emoji.update', 'emoji.create']
        WHEN 'emoji_removed' THEN ARRAY['emoji.delete']
        WHEN 'sticker_imported' THEN ARRAY['sticker.create']
        WHEN 'sticker_updated' THEN ARRAY['sticker.update', 'sticker.create']
        WHEN 'sticker_removed' THEN ARRAY['sticker.delete']
        WHEN 'member_role_added' THEN ARRAY['member.role_add']
        WHEN 'member_role_removed' THEN ARRAY['member.role_remove']
    END;
    IF NEW.action_type IN ('member_role_added', 'member_role_removed') THEN
        v_target := v_meta ->> 'user_id';
        v_role := v_meta ->> 'role_id';
        IF v_role IS NULL THEN
            RETURN NULL;
        END IF;
    ELSE
        v_target := COALESCE(v_meta ->> 'channel_id', v_meta ->> 'category_id', v_meta ->> 'role_id',
                             v_meta ->> 'emojiId', v_meta ->> 'stickerId');
    END IF;
    v_server := COALESCE(NEW.server_id::text, v_meta ->> 'server_id', v_meta ->> 'serverId');
    IF v_actions IS NULL OR v_target IS NULL OR v_server IS NULL
       OR v_server !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;

    UPDATE public.server_audit_log l
       SET source = 'bot', actor_bot_id = NEW.bot_id
     WHERE l.server_id = v_server::uuid
       AND l.action = ANY (v_actions)
       AND l.target_id = v_target
       AND (v_role IS NULL OR l.details ->> 'role_id' = v_role)
       AND l.source = 'system'
       AND l.actor_id IS NULL
       AND l.created_at > clock_timestamp() - interval '5 minutes';
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_bot_audit_log_server_audit ON public.bot_audit_log;
CREATE TRIGGER z_bot_audit_log_server_audit
    AFTER INSERT ON public.bot_audit_log
    FOR EACH ROW
    WHEN (NEW.success IS NOT FALSE AND NEW.bot_id IS NOT NULL
          AND NEW.action_type IN ('channel_created', 'category_created', 'role_created',
                                  'role_updated', 'role_deleted', 'emoji_imported',
                                  'emoji_updated', 'emoji_removed', 'sticker_imported',
                                  'sticker_updated', 'sticker_removed', 'member_role_added',
                                  'member_role_removed'))
    EXECUTE FUNCTION public.server_audit_attribute_bot();

COMMIT;

NOTIFY pgrst, 'reload schema';
