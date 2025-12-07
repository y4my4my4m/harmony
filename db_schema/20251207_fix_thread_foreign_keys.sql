-- =============================================
-- Fix Thread Foreign Keys
-- Change thread foreign keys from auth.users to profiles
-- to match messages.user_id and federation handlers
-- =============================================

-- Drop existing foreign key constraints
ALTER TABLE "public"."threads" 
  DROP CONSTRAINT IF EXISTS "threads_created_by_fkey";

ALTER TABLE "public"."thread_members" 
  DROP CONSTRAINT IF EXISTS "thread_members_user_id_fkey";

-- Recreate foreign keys pointing to profiles instead of auth.users
ALTER TABLE "public"."threads"
  ADD CONSTRAINT "threads_created_by_fkey" 
  FOREIGN KEY ("created_by") 
  REFERENCES "public"."profiles"("id") 
  ON DELETE SET NULL;

ALTER TABLE "public"."thread_members"
  ADD CONSTRAINT "thread_members_user_id_fkey" 
  FOREIGN KEY ("user_id") 
  REFERENCES "public"."profiles"("id") 
  ON DELETE CASCADE;

COMMENT ON CONSTRAINT "threads_created_by_fkey" ON "public"."threads" IS 'References profiles.id to match messages.user_id and federation handlers';
COMMENT ON CONSTRAINT "thread_members_user_id_fkey" ON "public"."thread_members" IS 'References profiles.id to match messages.user_id and allow trigger to insert message authors';

-- =============================================
-- Fix create_thread function to use profile IDs
-- =============================================

CREATE OR REPLACE FUNCTION "public"."create_thread"(
    p_message_id uuid,
    p_name text,
    p_auto_archive_duration integer DEFAULT 1440
)
RETURNS uuid AS $$
DECLARE
    v_thread_id uuid;
    v_channel_id uuid;
    v_user_id uuid;
    v_creator_profile_id uuid;
BEGIN
    -- Get message details
    SELECT channel_id, user_id INTO v_channel_id, v_user_id
    FROM "public"."messages"
    WHERE id = p_message_id;
    
    IF v_channel_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or not in a channel';
    END IF;
    
    -- Check if thread already exists for this message
    SELECT id INTO v_thread_id
    FROM "public"."threads"
    WHERE parent_message_id = p_message_id;
    
    IF v_thread_id IS NOT NULL THEN
        RAISE EXCEPTION 'Thread already exists for this message';
    END IF;
    
    -- Get current user's profile ID (not auth.uid())
    SELECT id INTO v_creator_profile_id
    FROM "public"."profiles"
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
    
    IF v_creator_profile_id IS NULL THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;
    
    -- Create the thread
    INSERT INTO "public"."threads" (
        channel_id,
        parent_message_id,
        name,
        created_by,
        auto_archive_duration
    ) VALUES (
        v_channel_id,
        p_message_id,
        p_name,
        v_creator_profile_id,
        p_auto_archive_duration
    )
    RETURNING id INTO v_thread_id;
    
    -- Add creator as first member
    INSERT INTO "public"."thread_members" (thread_id, user_id)
    VALUES (v_thread_id, v_creator_profile_id);
    
    -- Add original message author if different
    IF v_user_id IS NOT NULL AND v_user_id != v_creator_profile_id THEN
        INSERT INTO "public"."thread_members" (thread_id, user_id)
        VALUES (v_thread_id, v_user_id)
        ON CONFLICT DO NOTHING;
    END IF;
    
    -- Update member count
    UPDATE "public"."threads"
    SET member_count = (
        SELECT COUNT(*) FROM "public"."thread_members" 
        WHERE thread_id = v_thread_id
    )
    WHERE id = v_thread_id;
    
    RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION "public"."create_thread"(uuid, text, integer) IS 'Create a new thread from a message. Uses profile IDs instead of auth.uid() to match foreign key constraints.';

