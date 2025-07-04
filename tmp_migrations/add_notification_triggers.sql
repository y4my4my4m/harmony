-- =============================================
-- NOTIFICATION TRIGGERS MIGRATION
-- =============================================
-- This migration adds the missing triggers that call the notification functions
-- when messages and reactions are inserted/updated.

-- Create trigger for message notifications (mentions, DMs, replies)
DROP TRIGGER IF EXISTS trigger_message_notifications ON messages;
CREATE TRIGGER trigger_message_notifications
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_message_notifications();

-- Create trigger for reaction notifications
DROP TRIGGER IF EXISTS trigger_reaction_notifications ON reactions;
CREATE TRIGGER trigger_reaction_notifications
    AFTER INSERT ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION handle_reaction_notifications();

-- Enable realtime for notifications table (if not already enabled)
ALTER publication supabase_realtime ADD TABLE notifications;

-- Test the triggers by checking if they exist
SELECT 
    tgname as trigger_name,
    tgrelid::regclass as table_name,
    proname as function_name
FROM pg_trigger 
JOIN pg_proc ON pg_trigger.tgfoid = pg_proc.oid
WHERE tgname IN ('trigger_message_notifications', 'trigger_reaction_notifications');

COMMENT ON TRIGGER trigger_message_notifications ON messages IS 'Automatically creates notifications for mentions, DMs, and replies when messages are inserted';
COMMENT ON TRIGGER trigger_reaction_notifications ON reactions IS 'Automatically creates notifications when reactions are added to messages';