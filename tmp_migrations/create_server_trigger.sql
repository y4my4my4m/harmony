-- Function to create default categories and channels for a new server
CREATE OR REPLACE FUNCTION create_default_server_structure()
RETURNS TRIGGER AS $$
DECLARE
    text_category_id UUID;
    voice_category_id UUID;
    general_channel_id UUID;
    voice_channel_id UUID;
BEGIN
    -- Create Text Channels category
    INSERT INTO channel_categories (name, server_id, "order")
    VALUES ('Text Channels', NEW.id, 0)
    RETURNING id INTO text_category_id;
    
    -- Create Voice Channels category
    INSERT INTO channel_categories (name, server_id, "order")
    VALUES ('Voice Channels', NEW.id, 1)
    RETURNING id INTO voice_category_id;
    
    -- Create general text channel (type 0 = text)
    INSERT INTO channels (name, type, server_id, category, "order")
    VALUES ('general', 0, NEW.id, text_category_id, 0)
    RETURNING id INTO general_channel_id;
    
    -- Create voice chat channel (type 1 = voice)
    INSERT INTO channels (name, type, server_id, category, "order")
    VALUES ('voice-chat', 1, NEW.id, voice_category_id, 0)
    RETURNING id INTO voice_channel_id;
    
    -- Return the NEW record to continue the INSERT
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger that fires after server insertion
CREATE TRIGGER trigger_create_default_server_structure
    AFTER INSERT ON servers
    FOR EACH ROW
    EXECUTE FUNCTION create_default_server_structure();