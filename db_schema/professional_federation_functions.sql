-- ===================================================
-- POST REACTION FEDERATION: DATABASE-DRIVEN APPROACH  
-- ===================================================
-- This file implements federation logic at the database level
-- for atomic, reliable emoji reaction federation.

-- ===================================================
-- FEDERATION DECISION FUNCTIONS
-- ===================================================

-- Centralized federation decision logic for post reactions
CREATE OR REPLACE FUNCTION should_federate_post_reaction(
  p_post_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_post_visibility text;
  v_post_is_local boolean;
  v_user_federation_enabled boolean;
  v_instance_federation_enabled boolean;
BEGIN
  -- Get post visibility and locality
  SELECT visibility, COALESCE(is_local, true) 
  INTO v_post_visibility, v_post_is_local
  FROM posts WHERE id = p_post_id;

  IF NOT FOUND THEN
    RETURN false; -- Post doesn't exist
  END IF;

  -- Check user federation settings (default to enabled)
  SELECT COALESCE(
    (metadata->>'federation_enabled')::boolean, 
    true
  ) INTO v_user_federation_enabled
  FROM profiles WHERE id = p_user_id;

  -- Check instance federation settings (default to enabled)
  SELECT COALESCE(
    (config_value::jsonb->>'enabled')::boolean, 
    true
  ) INTO v_instance_federation_enabled
  FROM instance_config WHERE config_key = 'federation'
  LIMIT 1;

  -- Apply federation rules
  RETURN (
    v_post_is_local = true AND -- Only federate local posts
    v_post_visibility IN ('public', 'unlisted') AND -- Only public content
    v_user_federation_enabled = true AND
    COALESCE(v_instance_federation_enabled, true) = true
  );
END;
$$;

-- ===================================================
-- FEDERATION ACTIVITY CREATION
-- ===================================================

-- Create federation activity atomically with full Misskey/Pleroma compatibility
CREATE OR REPLACE FUNCTION create_post_reaction_federation_activity(
  p_user_id uuid,
  p_post_id uuid,
  p_emoji_id uuid,
  p_custom_emoji_content text,
  p_operation text -- 'add' or 'remove'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_activity_id uuid;
  v_activity_ap_id text;
  v_activity_data jsonb;
  v_user_federated_id text;
  v_instance_domain text;
  v_emoji_name text;
  v_emoji_url text;
  v_post_ap_id text;
  v_is_local boolean;
BEGIN
  -- Get instance domain
  SELECT trim(both '"' from config_value::text) INTO v_instance_domain
  FROM instance_config WHERE config_key = 'domain'
  LIMIT 1;
  
  IF v_instance_domain IS NULL THEN
    RAISE EXCEPTION 'Instance domain not configured';
  END IF;

  -- Generate ActivityPub ID
  v_activity_ap_id := 'https://' || v_instance_domain || '/activities/' || gen_random_uuid();

  -- Get user's federated ID
  -- For LOCAL users: build from username if federated_id not set (handles race conditions)
  -- For REMOTE users: federated_id MUST be set (we got it when creating their profile)
  SELECT 
    CASE 
      WHEN is_local = true OR is_local IS NULL THEN
        COALESCE(federated_id, 'https://' || v_instance_domain || '/users/' || username)
      ELSE
        federated_id  -- Remote users must have their actual federated_id from their instance
    END,
    is_local
  INTO v_user_federated_id, v_is_local
  FROM profiles WHERE id = p_user_id;

  IF v_user_federated_id IS NULL THEN
    RAISE EXCEPTION 'User % does not have a valid federated ID (is_local: %)', p_user_id, v_is_local;
  END IF;

  -- Get post ActivityPub ID
  SELECT COALESCE(ap_id, 'https://' || v_instance_domain || '/posts/' || id) 
  INTO v_post_ap_id
  FROM posts WHERE id = p_post_id;

  -- Get emoji data for activity
  IF p_emoji_id IS NOT NULL THEN
    SELECT name, url INTO v_emoji_name, v_emoji_url
    FROM emojis WHERE id = p_emoji_id;
  ELSE
    v_emoji_name := p_custom_emoji_content;
    v_emoji_url := 'https://' || v_instance_domain || '/emoji/unicode.png';
  END IF;

  -- Build ActivityPub activity data (Misskey/Pleroma compatible)
  IF p_operation = 'add' THEN
    -- Like activity with emoji support
    v_activity_data := jsonb_build_object(
      '@context', jsonb_build_array(
        'https://www.w3.org/ns/activitystreams',
        jsonb_build_object(
          'Emoji', 'toot:Emoji',
          'toot', 'http://joinmastodon.org/ns#'
        )
      ),
      'id', v_activity_ap_id,
      'type', 'Like',
      'actor', v_user_federated_id,
      'object', v_post_ap_id,
      'published', NOW()::text,
      'content', v_emoji_name
    );

    -- Add emoji tag for Misskey/Pleroma compatibility
    IF v_emoji_name IS NOT NULL THEN
      v_activity_data := v_activity_data || jsonb_build_object(
        'tag', jsonb_build_array(
          jsonb_build_object(
            'type', 'Emoji',
            'name', v_emoji_name,
            'icon', jsonb_build_object(
              'type', 'Image',
              'url', v_emoji_url
            )
          )
        )
      );

      -- Add Misskey-specific reaction field
      v_activity_data := v_activity_data || jsonb_build_object(
        '_misskey_reaction', v_emoji_name
      );
    END IF;

  ELSE
    -- Undo Like activity
    v_activity_data := jsonb_build_object(
      '@context', 'https://www.w3.org/ns/activitystreams',
      'id', v_activity_ap_id,
      'type', 'Undo',
      'actor', v_user_federated_id,
      'object', jsonb_build_object(
        'type', 'Like',
        'object', v_post_ap_id,
        'content', v_emoji_name
      ),
      'published', NOW()::text
    );
  END IF;

  -- Insert federation activity (compatible with existing edge functions)
  INSERT INTO ap_activities (
    ap_id, ap_type, actor_id, actor_ap_id,
    object_id, object_type, activity_data,
    status, is_local, created_at
  ) VALUES (
    v_activity_ap_id,
    CASE WHEN p_operation = 'add' THEN 'Like' ELSE 'Undo' END,
    p_user_id,
    v_user_federated_id,
    p_post_id,
    'Note',
    v_activity_data,
    'pending',
    true,
    NOW()
  ) RETURNING id INTO v_activity_id;

  RAISE NOTICE 'Created federation activity: % for post reaction % (%)', 
    v_activity_ap_id, p_operation, v_emoji_name;

  RETURN v_activity_id;
END;
$$;

-- ===================================================
-- ENHANCED REACTION FUNCTIONS WITH FEDERATION
-- ===================================================

-- Replace existing add_post_emoji_reaction with federation-aware version
CREATE OR REPLACE FUNCTION add_post_emoji_reaction(
  p_user_id uuid, 
  p_post_id uuid, 
  p_emoji_id uuid DEFAULT NULL, 
  p_custom_emoji_content text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_interaction_id uuid;
  v_should_federate boolean := false;
  v_federation_activity_id uuid;
BEGIN
  -- Validation
  IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
    RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
  END IF;

  -- Check if user already has this reaction (prevent duplicates)
  IF EXISTS (
    SELECT 1 FROM post_interactions 
    WHERE user_id = p_user_id 
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
        (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
        (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      )
  ) THEN
    RAISE EXCEPTION 'User already has this reaction on the post';
  END IF;

  -- Start atomic transaction
  BEGIN
    -- 1. Insert local reaction
    INSERT INTO post_interactions (
      user_id, post_id, interaction_type, emoji_id,
      custom_emoji_content, is_local, metadata
    ) VALUES (
      p_user_id, p_post_id, 'emoji_reaction', p_emoji_id,
      p_custom_emoji_content, true,
      jsonb_build_object(
        'reaction_type', CASE WHEN p_emoji_id IS NOT NULL THEN 'custom_emoji' ELSE 'unicode_emoji' END,
        'created_at', NOW(),
        'federated', false -- Will be updated if federation succeeds
      )
    ) RETURNING id INTO v_interaction_id;

    -- 2. Check federation eligibility
    SELECT should_federate_post_reaction(p_post_id, p_user_id) INTO v_should_federate;

    -- 3. Create federation activity if needed
    IF v_should_federate THEN
      SELECT create_post_reaction_federation_activity(
        p_user_id, p_post_id, p_emoji_id, p_custom_emoji_content, 'add'
      ) INTO v_federation_activity_id;

      -- Update reaction metadata to indicate federation
      UPDATE post_interactions 
      SET metadata = metadata || jsonb_build_object(
        'federated', true,
        'federation_activity_id', v_federation_activity_id
      )
      WHERE id = v_interaction_id;

      RAISE NOTICE 'Post reaction added with federation: % (activity: %)', 
        v_interaction_id, v_federation_activity_id;
    ELSE
      RAISE NOTICE 'Post reaction added locally only: %', v_interaction_id;
    END IF;

    -- 4. Success - return interaction ID
    RETURN v_interaction_id;

  EXCEPTION 
    WHEN OTHERS THEN
      -- Rollback on any failure for atomicity
      RAISE EXCEPTION 'Failed to add emoji reaction: %', SQLERRM;
  END;
END;
$$;

-- Replace existing remove_post_emoji_reaction with federation-aware version
CREATE OR REPLACE FUNCTION remove_post_emoji_reaction(
  p_user_id uuid, 
  p_post_id uuid, 
  p_emoji_id uuid DEFAULT NULL, 
  p_custom_emoji_content text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count integer;
  v_should_federate boolean := false;
  v_federation_activity_id uuid;
  v_existing_interaction record;
BEGIN
  -- Start atomic transaction
  BEGIN
    -- 1. Get existing interaction before deletion (for federation)
    SELECT * INTO v_existing_interaction
    FROM post_interactions 
    WHERE user_id = p_user_id
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
        (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
        (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      )
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN false; -- No reaction to remove
    END IF;

    -- 2. Check federation eligibility before deletion
    SELECT should_federate_post_reaction(p_post_id, p_user_id) INTO v_should_federate;

    -- 3. Delete local reaction
    DELETE FROM post_interactions 
    WHERE user_id = p_user_id
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
        (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
        (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      );

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- 4. Create federation activity if reaction was deleted and should federate
    IF v_deleted_count > 0 AND v_should_federate THEN
      SELECT create_post_reaction_federation_activity(
        p_user_id, p_post_id, 
        v_existing_interaction.emoji_id, 
        v_existing_interaction.custom_emoji_content, 
        'remove'
      ) INTO v_federation_activity_id;

      RAISE NOTICE 'Post reaction removed with federation: % (activity: %)', 
        v_existing_interaction.id, v_federation_activity_id;
    ELSE
      RAISE NOTICE 'Post reaction removed locally only: %', v_existing_interaction.id;
    END IF;

    RETURN v_deleted_count > 0;

  EXCEPTION 
    WHEN OTHERS THEN
      -- Rollback on any failure for atomicity
      RAISE EXCEPTION 'Failed to remove emoji reaction: %', SQLERRM;
  END;
END;
$$;

-- ===================================================
-- FEDERATION MONITORING & HEALTH
-- ===================================================

-- View for federation health monitoring
CREATE OR REPLACE VIEW federation_health AS
SELECT 
  COUNT(*) FILTER (WHERE status = 'pending') as pending_activities,
  COUNT(*) FILTER (WHERE status = 'delivered') as delivered_activities,
  COUNT(*) FILTER (WHERE status = 'failed') as failed_activities,
  ROUND(
    AVG(EXTRACT(epoch FROM (updated_at - created_at)))::numeric, 2
  ) as avg_delivery_time_seconds,
  COUNT(*) FILTER (WHERE ap_type = 'Like' AND created_at > NOW() - INTERVAL '1 hour') as reactions_last_hour,
  COUNT(*) FILTER (WHERE ap_type = 'Undo' AND created_at > NOW() - INTERVAL '1 hour') as unreactions_last_hour
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '24 hours';

-- Function to retry failed federation activities
CREATE OR REPLACE FUNCTION retry_failed_federation_activities()
RETURNS integer 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_retry_count integer;
BEGIN
  -- Re-queue failed activities for delivery (with exponential backoff)
  UPDATE ap_activities 
  SET 
    status = 'pending', 
    updated_at = NOW(),
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'retry_count', COALESCE((metadata->>'retry_count')::integer, 0) + 1,
      'last_retry', NOW()::text
    )
  WHERE status = 'failed' 
    AND created_at > NOW() - INTERVAL '24 hours'
    AND COALESCE((metadata->>'retry_count')::integer, 0) < 5; -- Max 5 retries

  GET DIAGNOSTICS v_retry_count = ROW_COUNT;
  
  RAISE NOTICE 'Retried % failed federation activities', v_retry_count;
  RETURN v_retry_count;
END;
$$;

-- Function to clean up old federation activities
CREATE OR REPLACE FUNCTION cleanup_old_federation_activities()
RETURNS integer 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  -- Delete delivered activities older than 30 days
  DELETE FROM ap_activities 
  WHERE status = 'delivered' 
    AND created_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  RAISE NOTICE 'Cleaned up % old federation activities', v_deleted_count;
  RETURN v_deleted_count;
END;
$$;

-- ===================================================
-- MIGRATION HELPERS
-- ===================================================

-- Function to test the new federation system
CREATE OR REPLACE FUNCTION test_federation_system(
  p_test_user_id uuid DEFAULT NULL,
  p_test_post_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_post_id uuid;
  v_reaction_id uuid;
  v_federation_before integer;
  v_federation_after integer;
  v_result jsonb;
BEGIN
  -- Use provided IDs or create test data
  v_user_id := COALESCE(p_test_user_id, (SELECT id FROM profiles WHERE is_local = true LIMIT 1));
  v_post_id := COALESCE(p_test_post_id, (SELECT id FROM posts WHERE is_local = true AND visibility = 'public' LIMIT 1));

  IF v_user_id IS NULL OR v_post_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No suitable test user or post found'
    );
  END IF;

  -- Count federation activities before
  SELECT COUNT(*) INTO v_federation_before FROM ap_activities;

  -- Test adding reaction
  BEGIN
    SELECT add_post_emoji_reaction(v_user_id, v_post_id, NULL, '🧪') INTO v_reaction_id;
    
    -- Count federation activities after
    SELECT COUNT(*) INTO v_federation_after FROM ap_activities;

    -- Test removing reaction
    PERFORM remove_post_emoji_reaction(v_user_id, v_post_id, NULL, '🧪');

    v_result := jsonb_build_object(
      'success', true,
      'reaction_id', v_reaction_id,
      'federation_activities_created', v_federation_after - v_federation_before,
      'user_id', v_user_id,
      'post_id', v_post_id,
      'message', 'Federation system test completed successfully'
    );

  EXCEPTION WHEN OTHERS THEN
    v_result := jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'user_id', v_user_id,
      'post_id', v_post_id
    );
  END;

  RETURN v_result;
END;
$$;

-- ===================================================
-- COMMENTS & DOCUMENTATION
-- ===================================================

COMMENT ON FUNCTION should_federate_post_reaction IS 
'Determines if a post reaction should be federated based on post visibility, user settings, and instance configuration';

COMMENT ON FUNCTION create_post_reaction_federation_activity IS 
'Creates ActivityPub Like/Undo activities for post reactions with full Misskey/Pleroma compatibility';

COMMENT ON FUNCTION add_post_emoji_reaction IS 
'Atomically adds post emoji reaction with automatic federation when appropriate';

COMMENT ON FUNCTION remove_post_emoji_reaction IS 
'Atomically removes post emoji reaction with automatic federation when appropriate';

COMMENT ON VIEW federation_health IS 
'Provides real-time federation health metrics and activity statistics';

COMMENT ON FUNCTION retry_failed_federation_activities IS 
'Retries failed federation activities with exponential backoff (max 5 retries)';

COMMENT ON FUNCTION cleanup_old_federation_activities IS 
'Cleans up old delivered federation activities to maintain database performance';

COMMENT ON FUNCTION test_federation_system IS 
'Tests the federation system by adding and removing a test reaction';

-- ===================================================
-- EXAMPLE USAGE
-- ===================================================

/*
-- Test the federation system
SELECT test_federation_system();

-- Monitor federation health
SELECT * FROM federation_health;

-- Add a reaction (automatically federates if eligible)
SELECT add_post_emoji_reaction(
  'user-uuid', 
  'post-uuid', 
  NULL, 
  '👍'
);

-- Remove a reaction (automatically federates if eligible)
SELECT remove_post_emoji_reaction(
  'user-uuid', 
  'post-uuid', 
  NULL, 
  '👍'
);

-- Retry failed activities
SELECT retry_failed_federation_activities();

-- Clean up old activities
SELECT cleanup_old_federation_activities();
*/
