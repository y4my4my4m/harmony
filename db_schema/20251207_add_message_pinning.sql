-- =============================================
-- Message Pinning System
-- Discord-style pin functionality for channels and DMs
-- Federation-ready using ActivityPub Add/Remove with featured collection
-- =============================================

-- =============================================
-- 1. Add pinning columns to messages table
-- =============================================
ALTER TABLE "public"."messages"
ADD COLUMN IF NOT EXISTS "is_pinned" boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone,
ADD COLUMN IF NOT EXISTS "pinned_by" "uuid" REFERENCES "auth"."users"("id") ON DELETE SET NULL;

COMMENT ON COLUMN "public"."messages"."is_pinned" IS 'Whether this message is pinned';
COMMENT ON COLUMN "public"."messages"."pinned_at" IS 'When the message was pinned';
COMMENT ON COLUMN "public"."messages"."pinned_by" IS 'User who pinned the message';

-- Index for efficient pinned message queries
CREATE INDEX IF NOT EXISTS "idx_messages_pinned" ON "public"."messages"("channel_id", "is_pinned") WHERE "is_pinned" = true;
CREATE INDEX IF NOT EXISTS "idx_messages_pinned_dm" ON "public"."messages"("conversation_id", "is_pinned") WHERE "is_pinned" = true;
CREATE INDEX IF NOT EXISTS "idx_messages_pinned_at" ON "public"."messages"("pinned_at" DESC) WHERE "is_pinned" = true;

-- =============================================
-- 2. Create pinned_messages view for efficient queries
-- =============================================
CREATE OR REPLACE VIEW "public"."pinned_messages_view" AS
SELECT 
    m.*,
    p.username as author_username,
    p.display_name as author_display_name,
    p.avatar_url as author_avatar_url,
    p.color as author_color,
    pp.username as pinner_username,
    pp.display_name as pinner_display_name,
    c.name as channel_name,
    c.server_id,
    s.name as server_name
FROM "public"."messages" m
LEFT JOIN "public"."profiles" p ON p.id = m.user_id
LEFT JOIN "public"."profiles" pp ON pp.id = m.pinned_by
LEFT JOIN "public"."channels" c ON c.id = m.channel_id
LEFT JOIN "public"."servers" s ON s.id = c.server_id
WHERE m.is_pinned = true AND NOT m.is_deleted
ORDER BY m.pinned_at DESC;

GRANT SELECT ON "public"."pinned_messages_view" TO "authenticated";
GRANT SELECT ON "public"."pinned_messages_view" TO "service_role";

-- =============================================
-- 3. Function to pin a message
-- =============================================
CREATE OR REPLACE FUNCTION "public"."pin_message"(
    p_message_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
    v_pin_count integer;
    v_max_pins integer := 50; -- Discord-style limit
BEGIN
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id AND NOT is_deleted;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or already deleted';
    END IF;
    
    -- Check if already pinned
    IF EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already pinned
    END IF;
    
    -- For channel messages, check permission and pin limit
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check pin count
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE channel_id = v_channel_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this channel', v_max_pins;
        END IF;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot pin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
        
        -- Check pin count for DM
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE conversation_id = v_conversation_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this conversation', v_max_pins;
        END IF;
    END IF;
    
    -- Pin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = true,
        pinned_at = NOW(),
        pinned_by = p_user_id
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION "public"."pin_message"(uuid, uuid) IS 'Pin a message with permission and limit checks';

-- =============================================
-- 4. Function to unpin a message
-- =============================================
CREATE OR REPLACE FUNCTION "public"."unpin_message"(
    p_message_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
BEGIN
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found';
    END IF;
    
    -- Check if not pinned
    IF NOT EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already unpinned
    END IF;
    
    -- For channel messages, check permission
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot unpin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
    END IF;
    
    -- Unpin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = false,
        pinned_at = NULL,
        pinned_by = NULL
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION "public"."unpin_message"(uuid, uuid) IS 'Unpin a message with permission checks';

-- =============================================
-- 5. Function to get pinned messages
-- =============================================
CREATE OR REPLACE FUNCTION "public"."get_pinned_messages"(
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    channel_id uuid,
    conversation_id uuid,
    user_id uuid,
    content jsonb,
    reply_to uuid,
    is_pinned boolean,
    pinned_at timestamptz,
    pinned_by uuid,
    metadata jsonb,
    author_username text,
    author_display_name text,
    author_avatar_url text,
    author_color text,
    pinner_username text,
    pinner_display_name text
) AS $$
BEGIN
    IF p_channel_id IS NOT NULL THEN
        RETURN QUERY
        SELECT 
            m.id,
            m.created_at,
            m.channel_id,
            m.conversation_id,
            m.user_id,
            m.content,
            m.reply_to,
            m.is_pinned,
            m.pinned_at,
            m.pinned_by,
            m.metadata,
            p.username as author_username,
            p.display_name as author_display_name,
            p.avatar_url as author_avatar_url,
            p.color as author_color,
            pp.username as pinner_username,
            pp.display_name as pinner_display_name
        FROM "public"."messages" m
        LEFT JOIN "public"."profiles" p ON p.id = m.user_id
        LEFT JOIN "public"."profiles" pp ON pp.id = m.pinned_by
        WHERE m.channel_id = p_channel_id
        AND m.is_pinned = true
        AND NOT m.is_deleted
        ORDER BY m.pinned_at DESC;
    ELSIF p_conversation_id IS NOT NULL THEN
        RETURN QUERY
        SELECT 
            m.id,
            m.created_at,
            m.channel_id,
            m.conversation_id,
            m.user_id,
            m.content,
            m.reply_to,
            m.is_pinned,
            m.pinned_at,
            m.pinned_by,
            m.metadata,
            p.username as author_username,
            p.display_name as author_display_name,
            p.avatar_url as author_avatar_url,
            p.color as author_color,
            pp.username as pinner_username,
            pp.display_name as pinner_display_name
        FROM "public"."messages" m
        LEFT JOIN "public"."profiles" p ON p.id = m.user_id
        LEFT JOIN "public"."profiles" pp ON pp.id = m.pinned_by
        WHERE m.conversation_id = p_conversation_id
        AND m.is_pinned = true
        AND NOT m.is_deleted
        ORDER BY m.pinned_at DESC;
    ELSE
        RAISE EXCEPTION 'Either channel_id or conversation_id must be provided';
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION "public"."get_pinned_messages"(uuid, uuid) IS 'Get pinned messages for a channel or conversation';

-- =============================================
-- 6. Function to count pinned messages
-- =============================================
CREATE OR REPLACE FUNCTION "public"."count_pinned_messages"(
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS integer AS $$
DECLARE
    v_count integer;
BEGIN
    IF p_channel_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_count
        FROM "public"."messages"
        WHERE channel_id = p_channel_id AND is_pinned = true AND NOT is_deleted;
    ELSIF p_conversation_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_count
        FROM "public"."messages"
        WHERE conversation_id = p_conversation_id AND is_pinned = true AND NOT is_deleted;
    ELSE
        v_count := 0;
    END IF;
    
    RETURN v_count;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================
-- 7. Trigger to handle message deletion (unpin on delete)
-- =============================================
CREATE OR REPLACE FUNCTION "public"."handle_pinned_message_delete"()
RETURNS TRIGGER AS $$
BEGIN
    -- If message is being deleted, unpin it
    IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
        NEW.is_pinned := false;
        NEW.pinned_at := NULL;
        NEW.pinned_by := NULL;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_unpin_on_delete" ON "public"."messages";
CREATE TRIGGER "trigger_unpin_on_delete"
    BEFORE UPDATE OF is_deleted ON "public"."messages"
    FOR EACH ROW
    WHEN (NEW.is_deleted = true AND OLD.is_deleted = false AND OLD.is_pinned = true)
    EXECUTE FUNCTION "public"."handle_pinned_message_delete"();

-- =============================================
-- 8. RLS policy updates (no new policies needed, 
--    uses existing message RLS + function permissions)
-- =============================================

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION "public"."pin_message"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."unpin_message"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_pinned_messages"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."count_pinned_messages"(uuid, uuid) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."pin_message"(uuid, uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."unpin_message"(uuid, uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_pinned_messages"(uuid, uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."count_pinned_messages"(uuid, uuid) TO "service_role";

