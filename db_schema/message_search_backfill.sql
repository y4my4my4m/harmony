-- Message Search Index Backfill Script
-- Indexes all existing messages that aren't already indexed
-- Safe to run multiple times (idempotent)

DO $$
DECLARE
  batch_size integer := 1000;
  total_messages integer;
  processed_count integer := 0;
  batch_count integer;
  start_time timestamp;
  end_time timestamp;
BEGIN
  start_time := clock_timestamp();
  
  -- Get total count of messages to process
  SELECT COUNT(*) INTO total_messages
  FROM messages
  WHERE is_deleted = false OR is_deleted IS NULL;
  
  RAISE NOTICE 'Starting backfill: % messages to index', total_messages;
  
  -- Process in batches
  LOOP
    -- Insert/update search index for a batch of messages
    WITH message_batch AS (
      SELECT 
        m.id,
        m.content,
        m.channel_id,
        m.conversation_id,
        m.user_id,
        m.created_at,
        m.is_deleted
      FROM messages m
      WHERE (m.is_deleted = false OR m.is_deleted IS NULL)
        -- Only process messages not yet indexed or that need updating
        AND NOT EXISTS (
          SELECT 1
          FROM message_search_index msi
          WHERE msi.message_id = m.id
        )
      ORDER BY m.created_at ASC
      LIMIT batch_size
    )
    INSERT INTO message_search_index (
      message_id,
      content_text,
      content_tsvector,
      channel_id,
      conversation_id,
      user_id,
      server_id,
      has_media,
      has_url,
      created_at
    )
    SELECT 
      mb.id,
      COALESCE(extract_message_text(mb.content), ''),
      to_tsvector('english', COALESCE(extract_message_text(mb.content), '')),
      mb.channel_id,
      mb.conversation_id,
      mb.user_id,
      CASE 
        WHEN mb.channel_id IS NOT NULL THEN get_channel_server_id(mb.channel_id)
        ELSE NULL
      END,
      (detect_message_features(mb.content)->>'has_media')::boolean,
      (detect_message_features(mb.content)->>'has_url')::boolean,
      mb.created_at
    FROM message_batch mb
    ON CONFLICT (message_id) DO UPDATE SET
      content_text = EXCLUDED.content_text,
      content_tsvector = EXCLUDED.content_tsvector,
      channel_id = EXCLUDED.channel_id,
      conversation_id = EXCLUDED.conversation_id,
      user_id = EXCLUDED.user_id,
      server_id = EXCLUDED.server_id,
      has_media = EXCLUDED.has_media,
      has_url = EXCLUDED.has_url,
      updated_at = now();
    
    GET DIAGNOSTICS batch_count = ROW_COUNT;
    processed_count := processed_count + batch_count;
    
    -- Log progress
    IF batch_count > 0 THEN
      RAISE NOTICE 'Processed % / % messages (%.1f%%)', 
        processed_count, 
        total_messages, 
        (processed_count::numeric / NULLIF(total_messages, 0) * 100);
      
      -- Commit this batch
      COMMIT;
    ELSE
      -- No more messages to process
      EXIT;
    END IF;
    
    -- Small delay to avoid locking the table too long
    PERFORM pg_sleep(0.1);
  END LOOP;
  
  end_time := clock_timestamp();
  
  RAISE NOTICE 'Backfill complete!';
  RAISE NOTICE 'Total processed: % messages', processed_count;
  RAISE NOTICE 'Time taken: %', end_time - start_time;
  
  -- Show final stats
  RAISE NOTICE 'Index statistics:';
  RAISE NOTICE '  Total indexed messages: %', (SELECT COUNT(*) FROM message_search_index);
  RAISE NOTICE '  Messages with text: %', (SELECT COUNT(*) FROM message_search_index WHERE content_text != '');
  RAISE NOTICE '  Messages with media: %', (SELECT COUNT(*) FROM message_search_index WHERE has_media = true);
  RAISE NOTICE '  Messages with URLs: %', (SELECT COUNT(*) FROM message_search_index WHERE has_url = true);
END $$;

