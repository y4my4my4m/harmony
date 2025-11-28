-- Migration: Cleanup Federation Delivery Queue
-- Fixes column mismatches and removes unused columns
-- Created: 2025-11-28

-- =====================================================
-- FIX 1: Update handle_post_federation to include sender_id
-- The sender_id is required for signing outgoing activities
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_post_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_author RECORD;
    v_activity jsonb;
    v_target_domains text[];
    v_target_domain text;
    v_domain_inbox text;
    v_instance_domain text;
BEGIN
    -- Only federate local posts
    IF NEW.is_local != true THEN
        RETURN NEW;
    END IF;
    
    -- Only federate public and unlisted posts
    IF NEW.visibility NOT IN ('public', 'unlisted') THEN
        RETURN NEW;
    END IF;
    
    -- Skip if already federated (idempotency)
    IF NEW.federation_status = 'federated' THEN
        RETURN NEW;
    END IF;
    
    -- Get author info
    SELECT id, username, domain INTO v_author
    FROM profiles
    WHERE id = NEW.author_id;
    
    IF v_author IS NULL THEN
        RAISE LOG 'Author not found for post: %', NEW.id;
        RETURN NEW;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Build the activity
    v_activity := build_post_create_activity(NEW.id, NEW.author_id);
    
    IF v_activity IS NULL THEN
        RAISE LOG 'Failed to build activity for post: %', NEW.id;
        RETURN NEW;
    END IF;
    
    -- Get target domains (all remote followers of the author)
    SELECT ARRAY_AGG(DISTINCT p.domain)
    INTO v_target_domains
    FROM follows f
    JOIN profiles p ON p.id = f.follower_id
    WHERE f.following_id = NEW.author_id
      AND f.status = 'accepted'
      AND p.is_local = false
      AND p.domain IS NOT NULL
      AND p.domain != '';
    
    -- If no followers, also send to known active instances (for public posts)
    IF v_target_domains IS NULL OR array_length(v_target_domains, 1) IS NULL THEN
        IF NEW.visibility = 'public' THEN
            SELECT ARRAY_AGG(DISTINCT domain)
            INTO v_target_domains
            FROM profiles
            WHERE domain IS NOT NULL
              AND domain != ''
              AND is_local = false
            LIMIT 20;
        END IF;
    END IF;
    
    -- Queue for federation delivery
    IF v_target_domains IS NOT NULL AND array_length(v_target_domains, 1) > 0 THEN
        FOREACH v_target_domain IN ARRAY v_target_domains LOOP
            v_domain_inbox := 'https://' || v_target_domain || '/inbox';
            
            INSERT INTO federation_delivery_queue (
                activity_data,
                target_domain,
                target_inbox_url,
                actor_username,
                actor_domain,
                sender_id,  -- NEW: Include sender_id for request signing
                status,
                priority,
                attempts,
                next_attempt_at
            ) VALUES (
                v_activity,
                v_target_domain,
                v_domain_inbox,
                v_author.username,
                v_instance_domain,
                NEW.author_id,  -- NEW: Set sender_id to author's ID
                'pending',
                5,
                0,
                NOW()
            );
        END LOOP;
        
        RAISE LOG 'Queued post % for federation to % domains', NEW.id, array_length(v_target_domains, 1);
        
        -- Update federation status
        UPDATE posts SET federation_status = 'federated' WHERE id = NEW.id;
    END IF;
    
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'Error in handle_post_federation for post %: % %', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_post_federation() IS 
    'Handles automatic federation of new local posts. Queues Create activities to federation_delivery_queue with sender_id for request signing.';


-- =====================================================
-- FIX 2: Update existing pending items to set sender_id
-- Extract author ID from activity_data for items without sender_id
-- =====================================================

-- For items where sender_id is NULL, try to extract from activity_data->actor
UPDATE federation_delivery_queue
SET sender_id = (
    SELECT p.id 
    FROM profiles p 
    WHERE p.username = actor_username 
      AND p.is_local = true
    LIMIT 1
)
WHERE sender_id IS NULL 
  AND status = 'pending';


-- =====================================================
-- FIX 3: Drop unused columns
-- These columns were never used - the correct columns are:
-- - target_inbox_url (not target_inbox)
-- - next_attempt_at (not next_retry_at)
-- =====================================================

-- Drop unused target_inbox column (target_inbox_url is the correct one)
ALTER TABLE public.federation_delivery_queue 
DROP COLUMN IF EXISTS target_inbox;

-- Drop unused next_retry_at column (next_attempt_at is the correct one)
ALTER TABLE public.federation_delivery_queue 
DROP COLUMN IF EXISTS next_retry_at;


-- =====================================================
-- FIX 4: Update handle_post_interaction_federation trigger
-- to include sender_id for emoji reactions
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_post_interaction_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_activity jsonb;
    v_target_post RECORD;
    v_target_domains text[];
    v_is_undo boolean := false;
    v_interaction_record RECORD;
BEGIN
    -- Only process emoji reactions
    IF COALESCE(NEW.interaction_type, OLD.interaction_type) != 'emoji_reaction' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Determine if this is an undo (DELETE) or create (INSERT)
    IF TG_OP = 'DELETE' THEN
        v_is_undo := true;
        v_interaction_record := OLD;
    ELSE
        v_interaction_record := NEW;
    END IF;
    
    -- Get target post info
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = v_interaction_record.post_id;
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for reaction federation: %', v_interaction_record.post_id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Only federate reactions on local posts or when we're the actor
    -- (Don't relay reactions on remote posts to avoid loops)
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Skipping federation for reaction on remote post: %', v_target_post.id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Build ActivityPub activity
    BEGIN
        -- Get sender profile details for federation
        DECLARE
            v_sender_profile RECORD;
            v_instance_domain text;
        BEGIN
            -- Get sender profile
            SELECT * INTO v_sender_profile 
            FROM profiles 
            WHERE id = v_interaction_record.user_id AND is_local = true;
            
            IF NOT FOUND THEN
                RAISE LOG 'Sender profile not found for reaction federation: %', v_interaction_record.user_id;
                RETURN COALESCE(NEW, OLD);
            END IF;
            
            -- Get instance domain
            SELECT config_value::text INTO v_instance_domain
            FROM instance_config 
            WHERE config_key = 'domain';
            
            -- Remove JSON quotes if present
            v_instance_domain := trim(both '"' from v_instance_domain);
            
            v_activity := build_emoji_reaction_activity(
                v_interaction_record.id,
                v_interaction_record.user_id,
                v_interaction_record.post_id,
                v_interaction_record.emoji_id,
                v_interaction_record.custom_emoji_content,
                v_is_undo
            );
            
            -- Determine target domains for federation
            SELECT ARRAY(
                SELECT DISTINCT domain
                FROM profiles 
                WHERE domain IS NOT NULL 
                AND domain != ''
                AND is_local = false
                LIMIT 20
            ) INTO v_target_domains;
            
            IF v_target_domains IS NULL OR array_length(v_target_domains, 1) IS NULL THEN
                RAISE LOG 'No target domains for reaction federation';
                RETURN COALESCE(NEW, OLD);
            END IF;
            
            -- Queue for federation delivery
            DECLARE
                v_domain_inbox text;
                v_target_domain text;
            BEGIN
                FOREACH v_target_domain IN ARRAY v_target_domains LOOP
                    v_domain_inbox := 'https://' || v_target_domain || '/inbox';
                    
                    INSERT INTO federation_delivery_queue (
                        activity_data,
                        target_domain,
                        target_inbox_url,
                        actor_username,
                        actor_domain,
                        sender_id,  -- NEW: Include sender_id for request signing
                        status,
                        priority,
                        attempts,
                        next_attempt_at
                    ) VALUES (
                        v_activity,
                        v_target_domain,
                        v_domain_inbox,
                        v_sender_profile.username,
                        v_instance_domain,
                        v_interaction_record.user_id,  -- NEW: Set sender_id
                        'pending',
                        5,
                        0,
                        NOW()
                    );
                END LOOP;
                
                RAISE LOG 'Queued emoji reaction federation to % domains', 
                    array_length(v_target_domains, 1);
            END;
        END;
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'Error building emoji reaction activity: % %', SQLSTATE, SQLERRM;
    END;
    
    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_post_interaction_federation() IS 
    'Handles automatic federation of emoji reactions. Triggers on post_interactions INSERT/DELETE for emoji_reaction type. Includes sender_id for request signing.';


-- =====================================================
-- Add comment documenting the schema
-- =====================================================

COMMENT ON TABLE public.federation_delivery_queue IS 
    'Queue for federated activity delivery with retry logic. Key columns: target_inbox_url (delivery URL), next_attempt_at (retry timing), sender_id (for request signing), activity_data (ActivityPub payload).';


-- =====================================================
-- VERIFICATION: Log that migration was applied
-- =====================================================

DO $$
BEGIN
    RAISE LOG 'Migration 19_cleanup_delivery_queue.sql applied successfully';
    RAISE LOG 'Fixed: handle_post_federation now includes sender_id';
    RAISE LOG 'Fixed: Updated existing pending items with sender_id';
    RAISE LOG 'Fixed: Dropped unused columns (target_inbox, next_retry_at)';
END $$;

