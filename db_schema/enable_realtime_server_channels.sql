-- Enable Realtime for Servers, Channels, and Channel Categories
-- This allows all server members to receive real-time updates when:
-- - Server name/icon/description is updated
-- - Server is deleted
-- - Channels are created/updated/deleted
-- - Categories are created/updated/deleted

-- =====================================================
-- SERVERS TABLE
-- =====================================================

-- Set REPLICA IDENTITY FULL for servers table to get full row data on DELETE
ALTER TABLE public.servers REPLICA IDENTITY FULL;

-- Add servers table to realtime publication
-- Use DO block to handle case where table is already in publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'servers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.servers;
    RAISE NOTICE 'Added servers table to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'servers table already in supabase_realtime publication';
  END IF;
END $$;

-- =====================================================
-- CHANNELS TABLE
-- =====================================================

-- Set REPLICA IDENTITY FULL for channels table to get full row data on DELETE
ALTER TABLE public.channels REPLICA IDENTITY FULL;

-- Add channels table to realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'channels'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.channels;
    RAISE NOTICE 'Added channels table to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'channels table already in supabase_realtime publication';
  END IF;
END $$;

-- =====================================================
-- CHANNEL_CATEGORIES TABLE
-- =====================================================

-- Set REPLICA IDENTITY FULL for channel_categories table to get full row data on DELETE
ALTER TABLE public.channel_categories REPLICA IDENTITY FULL;

-- Add channel_categories table to realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'channel_categories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.channel_categories;
    RAISE NOTICE 'Added channel_categories table to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'channel_categories table already in supabase_realtime publication';
  END IF;
END $$;

-- =====================================================
-- USER_SERVERS TABLE (ensure it's in publication)
-- =====================================================

-- Set REPLICA IDENTITY FULL for user_servers table
ALTER TABLE public.user_servers REPLICA IDENTITY FULL;

-- Add user_servers table to realtime publication if not already
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'user_servers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.user_servers;
    RAISE NOTICE 'Added user_servers table to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'user_servers table already in supabase_realtime publication';
  END IF;
END $$;

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Show all tables in the realtime publication
DO $$
DECLARE
  tbl record;
BEGIN
  RAISE NOTICE '=== Tables in supabase_realtime publication ===';
  FOR tbl IN 
    SELECT schemaname, tablename 
    FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime'
    ORDER BY schemaname, tablename
  LOOP
    RAISE NOTICE '%s.%s', tbl.schemaname, tbl.tablename;
  END LOOP;
END $$;

