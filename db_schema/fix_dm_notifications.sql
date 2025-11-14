-- Fix DM Notification Issues
-- 1. Convert MessagePart[] to readable text in notification previews
-- 2. Prevent double notifications

-- Helper function to convert MessagePart[] to plain text
CREATE OR REPLACE FUNCTION messageparts_to_text(content JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    result TEXT := '';
    part JSONB;
BEGIN
    IF jsonb_typeof(content) != 'array' THEN
        RETURN content::text;
    END IF;
    
    FOR part IN SELECT * FROM jsonb_array_elements(content)
    LOOP
        CASE part->>'type'
            WHEN 'text' THEN
                result := result || (part->>'text');
            WHEN 'mention' THEN
                result := result || '@' || (part->>'username') || 
                    CASE WHEN part->>'domain' IS NOT NULL AND part->>'domain' != 'har.mony.lol'
                        THEN '@' || (part->>'domain')
                        ELSE ''
                    END;
            WHEN 'emoji' THEN
                result := result || ':' || (part->'emoji'->>'name') || ':';
            WHEN 'hashtag' THEN
                result := result || '#' || (part->>'name');
            WHEN 'url' THEN
                result := result || (part->>'url');
            ELSE
                -- Unknown type, skip
        END CASE;
    END LOOP;
    
    RETURN TRIM(result);
END;
$$;

COMMENT ON FUNCTION messageparts_to_text IS
'Converts MessagePart[] JSONB array to plain text for notification previews';

-- Now let's check which trigger is firing for federated DMs
-- The issue is that handle_message_federation fires for ALL messages
-- But handle_outgoing_messages also fires for outgoing messages
-- We need to make sure incoming federated DMs only trigger ONE notification

-- Show current triggers on messages table
SELECT 
    tgname,
    pg_get_triggerdef(oid) as definition
FROM pg_trigger
WHERE tgrelid = 'messages'::regclass
  AND tgname LIKE '%handle%';


