-- Fix Search Permissions for message_search_index
-- 
-- This script grants the necessary permissions for the search functionality
-- to work correctly in production. The search_messages function uses 
-- SECURITY DEFINER but explicit grants ensure fallback access works.

-- =====================================================
-- GRANT TABLE PERMISSIONS
-- =====================================================

-- Grant SELECT permission on message_search_index to authenticated users
-- This allows the RLS policies to be evaluated
GRANT SELECT ON public.message_search_index TO authenticated;
GRANT SELECT ON public.message_search_index TO anon;

-- Ensure the messages table has proper grants (for loadMessagesByIds in SearchService)
GRANT SELECT ON public.messages TO authenticated;

-- Ensure profiles table has proper grants (for user lookup in search results)
GRANT SELECT ON public.profiles TO authenticated;

-- Ensure channels table has proper grants (for access checks)
GRANT SELECT ON public.channels TO authenticated;

-- Ensure user_servers table has proper grants (for server membership checks)
GRANT SELECT ON public.user_servers TO authenticated;

-- Ensure conversation_participants table has proper grants (for DM access checks)
GRANT SELECT ON public.conversation_participants TO authenticated;

-- =====================================================
-- GRANT FUNCTION PERMISSIONS
-- =====================================================

-- Grant EXECUTE on search_messages function to authenticated users
GRANT EXECUTE ON FUNCTION public.search_messages(
  text, 
  uuid, 
  uuid[], 
  uuid, 
  uuid, 
  uuid, 
  boolean, 
  boolean, 
  timestamptz, 
  timestamptz, 
  integer, 
  integer
) TO authenticated;

-- Grant EXECUTE on helper functions used by search
GRANT EXECUTE ON FUNCTION public.get_current_user_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.extract_message_text(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.detect_message_features(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_channel_server_id(uuid) TO authenticated;

-- =====================================================
-- ENSURE RLS IS ENABLED
-- =====================================================

-- Make sure RLS is enabled on the search index table
ALTER TABLE public.message_search_index ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- VERIFY/RECREATE RLS POLICY
-- =====================================================

-- Drop and recreate the RLS policy to ensure it's correctly configured
DROP POLICY IF EXISTS "Users can search messages they have access to" ON public.message_search_index;

CREATE POLICY "Users can search messages they have access to" ON public.message_search_index
  FOR SELECT
  TO authenticated
  USING (
    -- For conversations: user must be a participant
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM conversation_participants cp
      JOIN profiles p ON p.id = cp.user_id
      WHERE cp.conversation_id = message_search_index.conversation_id
        AND cp.left_at IS NULL
        AND p.auth_user_id = auth.uid()
    ))
    OR
    -- For channels: user must be a member of the server
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM channels c
      JOIN user_servers us ON c.server_id = us.server_id
      JOIN profiles p ON p.id = us.user_id
      WHERE c.id = message_search_index.channel_id
        AND p.auth_user_id = auth.uid()
    ))
  );

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Check that grants are in place
DO $$
DECLARE
  has_select boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 
    FROM information_schema.role_table_grants 
    WHERE table_name = 'message_search_index' 
    AND privilege_type = 'SELECT'
    AND grantee = 'authenticated'
  ) INTO has_select;
  
  IF has_select THEN
    RAISE NOTICE '✅ authenticated role has SELECT on message_search_index';
  ELSE
    RAISE WARNING '❌ authenticated role does NOT have SELECT on message_search_index';
  END IF;
END $$;

-- Check RLS is enabled
DO $$
DECLARE
  rls_enabled boolean;
BEGIN
  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public.message_search_index'::regclass;
  
  IF rls_enabled THEN
    RAISE NOTICE '✅ RLS is enabled on message_search_index';
  ELSE
    RAISE WARNING '❌ RLS is NOT enabled on message_search_index';
  END IF;
END $$;

-- List policies on the table
DO $$
DECLARE
  pol record;
BEGIN
  RAISE NOTICE '=== Policies on message_search_index ===';
  FOR pol IN
    SELECT policyname, permissive, cmd
    FROM pg_policies
    WHERE tablename = 'message_search_index'
  LOOP
    RAISE NOTICE 'Policy: % (% for %)', pol.policyname, pol.permissive, pol.cmd;
  END LOOP;
END $$;

