-- Fix missing conversation participants
-- ISSUE: Conversations exist but have no participants linked
-- This means DMs are saved but don't appear in conversation lists

-- STEP 1: Check the problematic conversation
SELECT 
    'Problematic conversation details' as info,
    c.id,
    c.type,
    c.created_by,
    c.created_at,
    c.user1,  -- Legacy columns (should be NULL after migration)
    c.user2   -- Legacy columns (should be NULL after migration)
FROM conversations c
WHERE c.id = '18f369e8-db2c-47c6-967e-149108f52aa0';

-- STEP 2: Check if ANY conversations have participants
SELECT 
    'Conversations with participant counts' as info,
    c.id,
    c.type,
    c.created_at,
    COUNT(cp.user_id) as participant_count
FROM conversations c
LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id AND cp.left_at IS NULL
WHERE c.created_at > NOW() - INTERVAL '1 hour'
GROUP BY c.id, c.type, c.created_at
ORDER BY c.created_at DESC
LIMIT 10;

-- STEP 3: Check what messages exist for the problematic conversation
SELECT 
    'Messages in problematic conversation' as info,
    m.id,
    m.user_id,
    p.username,
    p.is_local,
    m.created_at,
    m.content
FROM messages m
JOIN profiles p ON m.user_id = p.id
WHERE m.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0'
ORDER BY m.created_at DESC;

-- STEP 4: FIX THE ISSUE - Add missing participants based on who sent messages
-- This will retroactively fix conversations that were created without participants

DO $$
DECLARE
    conv_record RECORD;
    msg_user_id UUID;
    participant_count INTEGER;
BEGIN
    -- Find conversations with messages but no participants
    FOR conv_record IN 
        SELECT DISTINCT c.id as conversation_id
        FROM conversations c
        JOIN messages m ON c.id = m.conversation_id
        WHERE NOT EXISTS (
            SELECT 1 FROM conversation_participants cp 
            WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
        )
    LOOP
        RAISE WARNING '🔧 Fixing conversation with missing participants: %', conv_record.conversation_id;
        
        -- Add all users who have sent messages as participants
        INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
        SELECT DISTINCT 
            conv_record.conversation_id,
            m.user_id,
            'member',
            MIN(m.created_at)  -- Use earliest message time as join time
        FROM messages m
        WHERE m.conversation_id = conv_record.conversation_id
        GROUP BY m.user_id
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
        
        -- Count how many participants were added
        SELECT COUNT(*) INTO participant_count
        FROM conversation_participants cp
        WHERE cp.conversation_id = conv_record.conversation_id AND cp.left_at IS NULL;
        
        RAISE WARNING '✅ Added % participants to conversation %', participant_count, conv_record.conversation_id;
    END LOOP;
END;
$$;

-- STEP 5: Verify the fix worked
SELECT 
    'Fixed conversation participants' as info,
    cp.conversation_id,
    cp.user_id,
    p.username,
    p.is_local,
    cp.role,
    cp.joined_at
FROM conversation_participants cp
JOIN profiles p ON cp.user_id = p.id
WHERE cp.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0'
  AND cp.left_at IS NULL
ORDER BY cp.joined_at;