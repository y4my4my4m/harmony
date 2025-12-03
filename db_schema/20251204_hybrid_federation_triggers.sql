-- Migration: Hybrid Federation Triggers
-- 
-- This changes the federation approach to support BOTH:
-- 1. DatabaseListener (Supabase Realtime) for immediate delivery
-- 2. pg-boss sweep as a fallback for anything missed
--
-- The key change: triggers NO LONGER insert into pgboss.job directly
-- Instead, they just set federation_status='pending'
-- - DatabaseListener processes immediately and sets 'completed'
-- - pg-boss sweep catches anything still 'pending' after a few seconds

-- =============================================================================
-- OPTION 1: Simple approach - remove immediate pgboss queueing
-- Messages stay 'pending' until either system processes them
-- =============================================================================

-- Update the channel message trigger to NOT queue to pgboss immediately
-- It only marks the message for federation, letting either system handle it
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    -- Only process channel messages (channel_id is set, conversation_id is null)
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        -- Skip if already federated (incoming federated message)
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Check if the author is local
        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;
        
        IF v_author_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Get server info for the channel
        SELECT c.server_id, s.is_local_server 
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;
        
        -- Mark as pending - let DatabaseListener or pg-boss sweep handle it
        -- This allows BOTH systems to work without conflict:
        -- - DatabaseListener processes immediately if Realtime is working
        -- - pg-boss sweep catches anything still 'pending' after a delay
        NEW.federation_status := 'pending';
        
        -- Store metadata for the handler
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
            'federation_server_id', v_server_id,
            'federation_server_is_local', COALESCE(v_server_is_local, true)
        );
    END IF;
    
    RETURN NEW;
END;
$$;

-- Similarly update edit trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN
            RETURN NEW;
        END IF;
        
        IF NEW.metadata ? 'federated' THEN
            RETURN NEW;
        END IF;
        
        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;
        
        IF v_author_is_local IS NOT TRUE THEN
            RETURN NEW;
        END IF;
        
        -- Mark for federation - don't queue directly
        -- Update a separate flag so we don't trigger the updated_at logic
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
            'pending_edit_federation', true
        );
    END IF;
    
    RETURN NEW;
END;
$$;

-- Similarly update delete trigger  
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN
            RETURN NEW;
        END IF;
        
        IF NEW.metadata ? 'federated' THEN
            RETURN NEW;
        END IF;
        
        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;
        
        IF v_author_is_local IS NOT TRUE THEN
            RETURN NEW;
        END IF;
        
        -- Mark for federation
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
            'pending_delete_federation', true
        );
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trigger_queue_channel_message_federation() IS 
'Marks channel messages for federation without immediately queueing. Allows hybrid approach where DatabaseListener handles immediate delivery and pg-boss sweep catches missed items.';

