-- Complete E2EE Reset for Current User
-- Run this in Supabase SQL Editor to fully reset your encryption

DO $$ 
DECLARE
  v_user_id UUID;
BEGIN
  -- Get the user ID for the current auth user
  SELECT id INTO v_user_id
  FROM public.profiles
  WHERE auth_user_id = auth.uid();

  -- Delete prekeys
  DELETE FROM public.prekeys WHERE user_id = v_user_id;
  
  -- Delete user key pairs
  DELETE FROM public.user_key_pairs WHERE user_id = v_user_id;
  
  -- Delete encryption sessions (uses local_user_id and remote_user_id)
  DELETE FROM public.encryption_sessions 
  WHERE local_user_id = v_user_id OR remote_user_id = v_user_id;
  
  -- Delete conversation encryption settings where user is involved
  DELETE FROM public.conversation_encryption_settings 
  WHERE conversation_id IN (
    SELECT conversation_id FROM public.conversation_participants WHERE user_id = v_user_id
  );
  
  -- Clear encryption audit log
  DELETE FROM public.encryption_audit_log WHERE user_id = v_user_id;
  
  RAISE NOTICE 'Encryption data cleared for user %', v_user_id;
END $$;

