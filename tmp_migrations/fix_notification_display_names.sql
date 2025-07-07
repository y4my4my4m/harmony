-- Fix notification triggers to include display_name for better notification formatting
-- This migration updates the reaction notification trigger to include display_name

-- Function to handle reaction notifications with structured data (updated with display_name)
CREATE OR REPLACE FUNCTION handle_reaction_notifications()
RETURNS TRIGGER AS $$
DECLARE
    message_info messages%ROWTYPE;
    reactor_profile profiles%ROWTYPE;
    emoji_info emojis%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_info conversations%ROWTYPE;
    notification_data JSONB;
BEGIN
    -- Only handle INSERT events (new reactions)
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Get message and reactor info
    SELECT * INTO message_info FROM messages WHERE id = NEW.message_id;
    SELECT * INTO reactor_profile FROM profiles WHERE id = NEW.user_id;
    SELECT * INTO emoji_info FROM emojis WHERE id = NEW.emoji_id;
    
    -- Don't notify if user reacted to their own message
    IF message_info.user_id = NEW.user_id THEN
        RETURN NEW;
    END IF;
    
    -- Build base structured data for reaction notification (now includes display_name)
    notification_data := jsonb_build_object(
        'reactor', jsonb_build_object(
            'user_id', reactor_profile.id,
            'username', reactor_profile.username,
            'display_name', reactor_profile.display_name,
            'avatar_url', reactor_profile.avatar_url
        ),
        'reaction', jsonb_build_object(
            'emoji_id', NEW.emoji_id,
            'emoji_name', COALESCE(emoji_info.name, '👍'),
            'emoji_url', emoji_info.url
        ),
        'message', jsonb_build_object(
            'id', message_info.id,
            'created_at', message_info.created_at
        )
    );
    
    -- Handle DM reaction notifications
    IF message_info.conversation_id IS NOT NULL THEN
        SELECT * INTO conversation_info FROM conversations WHERE id = message_info.conversation_id;
        
        notification_data := notification_data || jsonb_build_object(
            'conversation', jsonb_build_object(
                'id', message_info.conversation_id
            )
        );
        
        PERFORM create_notification_structured(
            message_info.user_id,
            'reaction',
            notification_data,
            NULL,
            NULL,
            message_info.conversation_id
        );
    ELSE
        -- Handle server channel reaction notifications
        SELECT * INTO channel_info FROM channels WHERE id = message_info.channel_id;
        SELECT * INTO server_info FROM servers WHERE id = channel_info.server_id;
        
        notification_data := notification_data || jsonb_build_object(
            'location', jsonb_build_object(
                'server_id', channel_info.server_id,
                'server_name', server_info.name,
                'channel_id', message_info.channel_id,
                'channel_name', channel_info.name
            )
        );
        
        PERFORM create_notification_structured(
            message_info.user_id,
            'reaction',
            notification_data,
            channel_info.server_id,
            message_info.channel_id,
            NULL
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Also update the mention notification trigger to include display_name
CREATE OR REPLACE FUNCTION handle_mention_notifications()
RETURNS TRIGGER AS $$
DECLARE
    mentioned_usernames TEXT[];
    username_item TEXT;
    mentioned_user_id UUID;
    sender_profile profiles%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_info conversations%ROWTYPE;
    notification_data JSONB;
BEGIN
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Extract usernames mentioned in the content (@username@domain format)
    mentioned_usernames := ARRAY(
        SELECT DISTINCT regexp_replace(matches[1], '^@', '') 
        FROM regexp_split_to_table(NEW.content::text, '\s+') AS content_part,
        regexp_matches(content_part, '@([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', 'g') AS matches
    );
    
    IF array_length(mentioned_usernames, 1) > 0 THEN
        -- Handle DM mentions
        IF NEW.conversation_id IS NOT NULL THEN
            SELECT * INTO conversation_info FROM conversations WHERE id = NEW.conversation_id;
            
            -- Build base structured data for DM mention
            notification_data := jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', sender_profile.id,
                    'username', sender_profile.username,
                    'display_name', sender_profile.display_name,
                    'avatar_url', sender_profile.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', left(NEW.content::text, 100),
                    'created_at', NEW.created_at
                ),
                'conversation', jsonb_build_object(
                    'id', NEW.conversation_id
                )
            );
            
            FOREACH username_item IN ARRAY mentioned_usernames
            LOOP
                mentioned_user_id := get_user_id_from_username(username_item);
                
                IF mentioned_user_id IS NOT NULL AND mentioned_user_id != NEW.user_id THEN
                    PERFORM create_notification_structured(
                        mentioned_user_id,
                        'mention',
                        notification_data,
                        NULL,
                        NULL,
                        NEW.conversation_id
                    );
                END IF;
            END LOOP;
        ELSE
            -- Handle server channel mentions
            SELECT * INTO channel_info FROM channels WHERE id = NEW.channel_id;
            SELECT * INTO server_info FROM servers WHERE id = channel_info.server_id;
            
            -- Build base structured data for server mention
            notification_data := jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', sender_profile.id,
                    'username', sender_profile.username,
                    'display_name', sender_profile.display_name,
                    'avatar_url', sender_profile.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', left(NEW.content::text, 100),
                    'created_at', NEW.created_at
                ),
                'location', jsonb_build_object(
                    'server_id', channel_info.server_id,
                    'server_name', server_info.name,
                    'channel_id', NEW.channel_id,
                    'channel_name', channel_info.name
                )
            );
            
            FOREACH username_item IN ARRAY mentioned_usernames
            LOOP
                mentioned_user_id := get_user_id_from_username(username_item);
                
                IF mentioned_user_id IS NOT NULL AND mentioned_user_id != NEW.user_id THEN
                    PERFORM create_notification_structured(
                        mentioned_user_id,
                        'mention',
                        notification_data,
                        channel_info.server_id,
                        NEW.channel_id,
                        NULL
                    );
                END IF;
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
