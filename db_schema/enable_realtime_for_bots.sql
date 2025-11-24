-- Enable Real-time for Bot Gateway
-- This allows the bot gateway to receive real-time updates from the messages table

-- Enable realtime on messages table
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- Grant service_role access to real-time
GRANT USAGE ON SCHEMA realtime TO service_role;

-- Verify realtime is enabled
SELECT schemaname, tablename 
FROM pg_publication_tables 
WHERE pubname = 'supabase_realtime'
AND tablename = 'messages';

-- If the above returns nothing, create the publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime FOR ALL TABLES;
    RAISE NOTICE 'Created supabase_realtime publication';
  END IF;
END $$;

-- Verify again
SELECT schemaname, tablename 
FROM pg_publication_tables 
WHERE pubname = 'supabase_realtime';

