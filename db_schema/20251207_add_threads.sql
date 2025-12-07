-- =============================================
-- Discord-Style Threads Implementation
-- Threaded conversations within channels
-- Federation-ready with ActivityPub IDs
-- =============================================

-- =============================================
-- 1. Create threads table
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel_id" "uuid" NOT NULL,
    "parent_message_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived" boolean DEFAULT false,
    "archived_at" timestamp with time zone,
    "auto_archive_duration" integer DEFAULT 1440, -- minutes: 60, 1440 (1 day), 4320 (3 days), 10080 (7 days)
    "locked" boolean DEFAULT false,
    "message_count" integer DEFAULT 0,
    "member_count" integer DEFAULT 0,
    "last_message_id" "uuid",
    "last_message_at" timestamp with time zone,
    "ap_id" "text",
    "federation_status" "text" DEFAULT 'local'::text,
    "federation_metadata" "jsonb" DEFAULT '{}'::jsonb,
    CONSTRAINT "threads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "threads_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE,
    CONSTRAINT "threads_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE,
    CONSTRAINT "threads_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
    CONSTRAINT "threads_auto_archive_check" CHECK ("auto_archive_duration" IN (60, 1440, 4320, 10080)),
    CONSTRAINT "threads_federation_status_check" CHECK ("federation_status" IN ('local', 'pending', 'synced', 'failed')),
    CONSTRAINT "threads_name_length" CHECK (char_length("name") >= 1 AND char_length("name") <= 100)
);

ALTER TABLE "public"."threads" OWNER TO "postgres";

COMMENT ON TABLE "public"."threads" IS 'Discord-style threaded conversations within channels';
COMMENT ON COLUMN "public"."threads"."parent_message_id" IS 'The message that started this thread';
COMMENT ON COLUMN "public"."threads"."auto_archive_duration" IS 'Minutes of inactivity before auto-archiving: 60, 1440, 4320, 10080';
COMMENT ON COLUMN "public"."threads"."locked" IS 'Only moderators can unarchive when locked';
COMMENT ON COLUMN "public"."threads"."ap_id" IS 'ActivityPub ID for federation';

-- Indexes for threads
CREATE INDEX IF NOT EXISTS "idx_threads_channel_id" ON "public"."threads"("channel_id");
CREATE INDEX IF NOT EXISTS "idx_threads_parent_message" ON "public"."threads"("parent_message_id");
CREATE INDEX IF NOT EXISTS "idx_threads_created_by" ON "public"."threads"("created_by");
CREATE INDEX IF NOT EXISTS "idx_threads_archived" ON "public"."threads"("archived", "channel_id");
CREATE INDEX IF NOT EXISTS "idx_threads_last_message" ON "public"."threads"("last_message_at" DESC) WHERE NOT "archived";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_threads_ap_id" ON "public"."threads"("ap_id") WHERE "ap_id" IS NOT NULL;

-- =============================================
-- 2. Create thread_members table
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."thread_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_read_message_id" "uuid",
    "last_read_at" timestamp with time zone,
    "muted" boolean DEFAULT false,
    "flags" integer DEFAULT 0,
    CONSTRAINT "thread_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "thread_members_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE CASCADE,
    CONSTRAINT "thread_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    CONSTRAINT "thread_members_unique" UNIQUE ("thread_id", "user_id")
);

ALTER TABLE "public"."thread_members" OWNER TO "postgres";

COMMENT ON TABLE "public"."thread_members" IS 'Track users participating in threads';
COMMENT ON COLUMN "public"."thread_members"."flags" IS 'Bitmask for thread-specific settings';

-- Indexes for thread_members
CREATE INDEX IF NOT EXISTS "idx_thread_members_thread_id" ON "public"."thread_members"("thread_id");
CREATE INDEX IF NOT EXISTS "idx_thread_members_user_id" ON "public"."thread_members"("user_id");

-- =============================================
-- 3. Add thread_id to messages table
-- =============================================
ALTER TABLE "public"."messages" 
ADD COLUMN IF NOT EXISTS "thread_id" "uuid" REFERENCES "public"."threads"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_messages_thread_id" ON "public"."messages"("thread_id") WHERE "thread_id" IS NOT NULL;

COMMENT ON COLUMN "public"."messages"."thread_id" IS 'Thread this message belongs to (null for channel messages)';

-- =============================================
-- 4. Function to auto-add member when posting in thread
-- =============================================
CREATE OR REPLACE FUNCTION "public"."thread_message_handler"()
RETURNS TRIGGER AS $$
BEGIN
    -- Only process thread messages
    IF NEW.thread_id IS NOT NULL THEN
        -- Add user to thread members if not already present
        INSERT INTO "public"."thread_members" (thread_id, user_id)
        VALUES (NEW.thread_id, NEW.user_id)
        ON CONFLICT (thread_id, user_id) DO NOTHING;
        
        -- Update thread stats
        UPDATE "public"."threads"
        SET 
            message_count = message_count + 1,
            last_message_id = NEW.id,
            last_message_at = NEW.created_at,
            updated_at = NOW(),
            -- Reset archive timer on activity
            archived = CASE 
                WHEN locked = true THEN archived 
                ELSE false 
            END,
            archived_at = CASE 
                WHEN locked = true THEN archived_at 
                ELSE NULL 
            END
        WHERE id = NEW.thread_id;
        
        -- Update member count
        UPDATE "public"."threads" t
        SET member_count = (
            SELECT COUNT(*) FROM "public"."thread_members" tm 
            WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "trigger_thread_message_insert" ON "public"."messages";
CREATE TRIGGER "trigger_thread_message_insert"
    AFTER INSERT ON "public"."messages"
    FOR EACH ROW
    WHEN (NEW.thread_id IS NOT NULL)
    EXECUTE FUNCTION "public"."thread_message_handler"();

-- =============================================
-- 5. Function to handle message deletion in threads
-- =============================================
CREATE OR REPLACE FUNCTION "public"."thread_message_delete_handler"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.thread_id IS NOT NULL THEN
        -- Decrement message count
        UPDATE "public"."threads"
        SET message_count = GREATEST(0, message_count - 1)
        WHERE id = OLD.thread_id;
        
        -- Update last message if needed
        UPDATE "public"."threads" t
        SET 
            last_message_id = (
                SELECT id FROM "public"."messages" 
                WHERE thread_id = t.id AND NOT is_deleted
                ORDER BY created_at DESC 
                LIMIT 1
            ),
            last_message_at = (
                SELECT created_at FROM "public"."messages" 
                WHERE thread_id = t.id AND NOT is_deleted
                ORDER BY created_at DESC 
                LIMIT 1
            )
        WHERE t.id = OLD.thread_id;
    END IF;
    
    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "trigger_thread_message_delete" ON "public"."messages";
CREATE TRIGGER "trigger_thread_message_delete"
    AFTER DELETE OR UPDATE OF is_deleted ON "public"."messages"
    FOR EACH ROW
    WHEN (OLD.thread_id IS NOT NULL)
    EXECUTE FUNCTION "public"."thread_message_delete_handler"();

-- =============================================
-- 6. Function to auto-archive inactive threads
-- =============================================
CREATE OR REPLACE FUNCTION "public"."auto_archive_threads"()
RETURNS void AS $$
BEGIN
    UPDATE "public"."threads"
    SET 
        archived = true,
        archived_at = NOW()
    WHERE 
        NOT archived
        AND NOT locked
        AND last_message_at < NOW() - (auto_archive_duration || ' minutes')::interval;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION "public"."auto_archive_threads"() IS 'Archive threads that have been inactive longer than their auto_archive_duration';

-- =============================================
-- 7. Function to create a thread from a message
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
        auth.uid(),
        p_auto_archive_duration
    )
    RETURNING id INTO v_thread_id;
    
    -- Add creator as first member
    INSERT INTO "public"."thread_members" (thread_id, user_id)
    VALUES (v_thread_id, auth.uid());
    
    -- Add original message author if different
    IF v_user_id IS NOT NULL AND v_user_id != auth.uid() THEN
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

COMMENT ON FUNCTION "public"."create_thread"(uuid, text, integer) IS 'Create a new thread from a message';

-- =============================================
-- 8. Updated_at trigger for threads
-- =============================================
CREATE OR REPLACE FUNCTION "public"."update_threads_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_threads_updated_at" ON "public"."threads";
CREATE TRIGGER "trigger_threads_updated_at"
    BEFORE UPDATE ON "public"."threads"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_threads_updated_at"();

-- =============================================
-- 9. RLS Policies for threads
-- =============================================
ALTER TABLE "public"."threads" ENABLE ROW LEVEL SECURITY;

-- Users can view threads in channels they have access to
DROP POLICY IF EXISTS "Users can view threads" ON "public"."threads";
CREATE POLICY "Users can view threads" ON "public"."threads"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "public"."channels" c
            JOIN "public"."user_servers" us ON us.server_id = c.server_id
            WHERE c.id = threads.channel_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- Users with CREATE_PUBLIC_THREADS or CREATE_PRIVATE_THREADS can create threads
DROP POLICY IF EXISTS "Users can create threads" ON "public"."threads";
CREATE POLICY "Users can create threads" ON "public"."threads"
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "public"."channels" c
            JOIN "public"."user_servers" us ON us.server_id = c.server_id
            WHERE c.id = threads.channel_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
        AND (
            "public"."has_permission"(auth.uid(), (
                SELECT server_id FROM "public"."channels" WHERE id = threads.channel_id
            ), 'CREATE_PUBLIC_THREADS', threads.channel_id)
            OR
            "public"."has_permission"(auth.uid(), (
                SELECT server_id FROM "public"."channels" WHERE id = threads.channel_id
            ), 'CREATE_PRIVATE_THREADS', threads.channel_id)
        )
    );

-- Thread creators and moderators can update threads
DROP POLICY IF EXISTS "Users can update threads" ON "public"."threads";
CREATE POLICY "Users can update threads" ON "public"."threads"
    FOR UPDATE
    USING (
        created_by = auth.uid()
        OR
        "public"."has_permission"(auth.uid(), (
            SELECT server_id FROM "public"."channels" WHERE id = threads.channel_id
        ), 'MANAGE_CHANNELS', threads.channel_id)
    );

-- Only moderators can delete threads
DROP POLICY IF EXISTS "Moderators can delete threads" ON "public"."threads";
CREATE POLICY "Moderators can delete threads" ON "public"."threads"
    FOR DELETE
    USING (
        "public"."has_permission"(auth.uid(), (
            SELECT server_id FROM "public"."channels" WHERE id = threads.channel_id
        ), 'MANAGE_CHANNELS', threads.channel_id)
    );

-- =============================================
-- 10. RLS Policies for thread_members
-- =============================================
ALTER TABLE "public"."thread_members" ENABLE ROW LEVEL SECURITY;

-- Users can view members of threads they can access
DROP POLICY IF EXISTS "Users can view thread members" ON "public"."thread_members";
CREATE POLICY "Users can view thread members" ON "public"."thread_members"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "public"."threads" t
            JOIN "public"."channels" c ON c.id = t.channel_id
            JOIN "public"."user_servers" us ON us.server_id = c.server_id
            WHERE t.id = thread_members.thread_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- Users can join threads (insert themselves)
DROP POLICY IF EXISTS "Users can join threads" ON "public"."thread_members";
CREATE POLICY "Users can join threads" ON "public"."thread_members"
    FOR INSERT
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM "public"."threads" t
            JOIN "public"."channels" c ON c.id = t.channel_id
            JOIN "public"."user_servers" us ON us.server_id = c.server_id
            WHERE t.id = thread_members.thread_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
            AND NOT t.archived
        )
    );

-- Users can update their own membership (e.g., mute)
DROP POLICY IF EXISTS "Users can update own thread membership" ON "public"."thread_members";
CREATE POLICY "Users can update own thread membership" ON "public"."thread_members"
    FOR UPDATE
    USING (user_id = auth.uid());

-- Users can leave threads (delete their membership)
DROP POLICY IF EXISTS "Users can leave threads" ON "public"."thread_members";
CREATE POLICY "Users can leave threads" ON "public"."thread_members"
    FOR DELETE
    USING (user_id = auth.uid());

-- =============================================
-- 11. Grant permissions
-- =============================================
GRANT ALL ON "public"."threads" TO "authenticated";
GRANT ALL ON "public"."threads" TO "service_role";
GRANT ALL ON "public"."thread_members" TO "authenticated";
GRANT ALL ON "public"."thread_members" TO "service_role";

-- =============================================
-- 12. Realtime subscriptions
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE "public"."threads";
ALTER PUBLICATION supabase_realtime ADD TABLE "public"."thread_members";

-- =============================================
-- 13. View for active threads with stats
-- =============================================
CREATE OR REPLACE VIEW "public"."active_threads_view" AS
SELECT 
    t.*,
    c.name as channel_name,
    c.server_id,
    p.username as creator_username,
    p.display_name as creator_display_name,
    p.avatar_url as creator_avatar_url,
    (
        SELECT COUNT(*) FROM "public"."messages" m 
        WHERE m.thread_id = t.id 
        AND m.created_at > NOW() - INTERVAL '24 hours'
        AND NOT m.is_deleted
    ) as recent_message_count
FROM "public"."threads" t
JOIN "public"."channels" c ON c.id = t.channel_id
LEFT JOIN "public"."profiles" p ON p.id = t.created_by
WHERE NOT t.archived
ORDER BY t.last_message_at DESC NULLS LAST;

GRANT SELECT ON "public"."active_threads_view" TO "authenticated";
GRANT SELECT ON "public"."active_threads_view" TO "service_role";

