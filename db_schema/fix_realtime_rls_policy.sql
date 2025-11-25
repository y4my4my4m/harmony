-- FIX: Allow realtime to broadcast channel messages
-- The issue: RLS policies block supabase_realtime_admin from SELECTing messages with channel_id
-- Solution: Bypass RLS for the realtime admin role

-- Check current policies
SELECT policyname, cmd 
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'messages' AND cmd = 'SELECT';

-- The realtime system needs to bypass RLS to read and broadcast messages
-- Add a permissive policy that allows realtime role to SELECT all messages
CREATE POLICY "Realtime can view all messages for broadcasting"
  ON public.messages
  FOR SELECT
  TO supabase_realtime_admin
  USING (true);

-- Verify the policy was created
SELECT policyname, roles::text 
FROM pg_policies 
WHERE schemaname = 'public' 
AND tablename = 'messages' 
AND cmd = 'SELECT'
ORDER BY policyname;

