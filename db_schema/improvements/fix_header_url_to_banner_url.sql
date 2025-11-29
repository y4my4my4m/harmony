-- ============================================
-- FIX: Update trigger functions that incorrectly reference header_url
-- The correct column name is banner_url
-- ============================================

-- First, let's see what functions reference header_url (for debugging)
DO $$
DECLARE
    func_record RECORD;
BEGIN
    FOR func_record IN 
        SELECT proname, prosrc 
        FROM pg_proc 
        WHERE prosrc LIKE '%header_url%'
    LOOP
        RAISE NOTICE 'Found function with header_url reference: %', func_record.proname;
    END LOOP;
END $$;

-- The handle_unified_profile_federation function is the most likely culprit
-- Let's recreate it with the correct column name

CREATE OR REPLACE FUNCTION public.handle_unified_profile_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    should_federate boolean := false;
BEGIN
    -- Only process UPDATE operations
    IF TG_OP != 'UPDATE' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if federation is enabled for this user
    SELECT is_federation_enabled_for_user(NEW.id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN NEW;
    END IF;

    -- Check if any federable fields changed
    -- FIX: Use banner_url instead of header_url
    should_federate := (
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url
    );

    IF should_federate THEN
        -- Get instance domain
        SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
        FROM public.instance_config 
        WHERE config_key = 'instance_domain';

        IF current_instance_domain IS NULL THEN
            current_instance_domain := 'localhost';
        END IF;

        -- Queue federation job
        INSERT INTO public.federation_outbox (
            activity_type,
            actor_id,
            object_type,
            object_id,
            target_domains,
            priority,
            payload,
            status
        ) VALUES (
            'Update',
            NEW.federated_id,
            'Person',
            NEW.federated_id,
            ARRAY[]::text[],
            5,
            jsonb_build_object(
                'type', 'Update',
                'actor', NEW.federated_id,
                'object', jsonb_build_object(
                    'type', 'Person',
                    'id', NEW.federated_id,
                    'preferredUsername', NEW.username,
                    'name', COALESCE(NEW.display_name, NEW.username),
                    'summary', COALESCE(NEW.bio, ''),
                    'icon', CASE WHEN NEW.avatar_url IS NOT NULL THEN
                        jsonb_build_object('type', 'Image', 'url', NEW.avatar_url) 
                    ELSE NULL END,
                    -- FIX: Use banner_url instead of header_url
                    'image', CASE WHEN NEW.banner_url IS NOT NULL THEN
                        jsonb_build_object('type', 'Image', 'url', NEW.banner_url) 
                    ELSE NULL END,
                    'inbox', NEW.inbox_url,
                    'outbox', NEW.outbox_url,
                    'followers', NEW.followers_url,
                    'following', NEW.following_url,
                    'publicKey', CASE WHEN NEW.public_key IS NOT NULL THEN
                        jsonb_build_object(
                            'id', NEW.federated_id || '#main-key',
                            'owner', NEW.federated_id,
                            'publicKeyPem', NEW.public_key
                        )
                    ELSE NULL END
                ),
                'published', now()
            ),
            'pending'
        );
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_unified_profile_federation() IS 'OUTGOING ONLY: Unified trigger for federating local profile updates to remote instances. Uses banner_url (not header_url).';

-- Also fix the pg-boss queue trigger if it exists
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Only federate local user profile updates
    IF NEW.is_local = true THEN
        PERFORM public.queue_federation_job(
            'federate-profile',
            jsonb_build_object(
                'type', 'update',
                'profile_id', NEW.id,
                'username', NEW.username,
                'display_name', NEW.display_name,
                'bio', NEW.bio,
                'avatar_url', NEW.avatar_url,
                -- FIX: Use banner_url instead of header_url
                'banner_url', NEW.banner_url
            ),
            3, -- Lower priority than posts
            5,
            3600
        );
    END IF;
    
    RETURN NEW;
END;
$$;

-- Verify the fix
DO $$
DECLARE
    func_count integer;
BEGIN
    SELECT COUNT(*) INTO func_count
    FROM pg_proc 
    WHERE prosrc LIKE '%header_url%';
    
    IF func_count > 0 THEN
        RAISE WARNING 'Still found % functions referencing header_url', func_count;
    ELSE
        RAISE NOTICE 'SUCCESS: No functions reference header_url anymore';
    END IF;
END $$;

SELECT 'Fix applied successfully. Try changing your status again.' as message;

