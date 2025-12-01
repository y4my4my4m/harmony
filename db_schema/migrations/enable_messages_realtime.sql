-- Enable Supabase Realtime for messages table
-- This is required for the bot-gateway to receive MESSAGE_UPDATE and MESSAGE_DELETE events

-- Set REPLICA IDENTITY FULL so DELETE events include the old row data
-- This is required for Supabase Realtime to send the deleted message info
ALTER TABLE public.messages REPLICA IDENTITY FULL;

-- Add messages table to supabase_realtime publication if not already added
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
        RAISE LOG 'Added messages to supabase_realtime publication';
    ELSE
        RAISE LOG 'messages already in supabase_realtime publication';
    END IF;
END $$;

-- Also enable for reactions table (for reaction syncing)
ALTER TABLE public.reactions REPLICA IDENTITY FULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'reactions'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.reactions;
        RAISE LOG 'Added reactions to supabase_realtime publication';
    ELSE
        RAISE LOG 'reactions already in supabase_realtime publication';
    END IF;
END $$;

-- Reload schema cache to pick up changes
NOTIFY pgrst, 'reload schema';

