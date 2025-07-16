-- Fix the existing simple follow notification function to include handle field
-- This prevents the "unknown" notification issue by providing proper data structure
-- SAFE APPROACH: Only updates the notification function, keeps federation trigger intact

-- Update the notification function to include the missing handle and is_local fields
CREATE OR REPLACE FUNCTION public.handle_simple_follow_notifications() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    follower_profile RECORD;
BEGIN
    -- Only handle new follows
    IF TG_OP = 'INSERT' AND NEW.status = 'accepted' THEN
        -- Get follower profile (now including is_local)
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles 
        WHERE id = NEW.follower_id;
        
        IF FOUND THEN
            PERFORM create_simple_activitypub_notification(
                NEW.following_id,
                'activitypub_follow',
                jsonb_build_object(
                    'follower', jsonb_build_object(
                        'id', follower_profile.id,
                        'username', follower_profile.username,
                        'display_name', follower_profile.display_name,
                        'avatar_url', follower_profile.avatar_url,
                        'domain', follower_profile.domain,
                        'is_local', follower_profile.is_local,
                        'handle', CASE 
                            WHEN follower_profile.is_local THEN '@' || follower_profile.username
                            ELSE '@' || follower_profile.username || '@' || follower_profile.domain
                        END
                    ),
                    'follow_id', NEW.id,
                    'follow_status', NEW.status,
                    'timestamp', NEW.created_at
                )
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Update the comment to reflect the fix
COMMENT ON FUNCTION public.handle_simple_follow_notifications() IS 'Creates ActivityPub follow notifications with proper handle/domain display';
