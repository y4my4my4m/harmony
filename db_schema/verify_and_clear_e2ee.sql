-- Check if user still has encryption data
DO $$ 
DECLARE
  v_user_id UUID;
  v_key_pairs_count INTEGER;
  v_prekeys_count INTEGER;
BEGIN
  -- Get the user ID for the current auth user
  SELECT id INTO v_user_id
  FROM public.profiles
  WHERE auth_user_id = auth.uid();

  -- Count key pairs
  SELECT COUNT(*) INTO v_key_pairs_count
  FROM public.user_key_pairs
  WHERE user_id = v_user_id;
  
  -- Count prekeys
  SELECT COUNT(*) INTO v_prekeys_count
  FROM public.prekeys
  WHERE user_id = v_user_id;
  
  RAISE NOTICE 'User ID: %', v_user_id;
  RAISE NOTICE 'Key Pairs: %', v_key_pairs_count;
  RAISE NOTICE 'Prekeys: %', v_prekeys_count;
  
  IF v_key_pairs_count = 0 AND v_prekeys_count = 0 THEN
    RAISE NOTICE '✅ User has NO encryption data - ready for fresh setup';
  ELSE
    RAISE NOTICE '⚠️ User still has encryption data - clearing...';
    
    -- Force delete everything
    DELETE FROM public.prekeys WHERE user_id = v_user_id;
    DELETE FROM public.user_key_pairs WHERE user_id = v_user_id;
    DELETE FROM public.encryption_sessions 
    WHERE local_user_id = v_user_id OR remote_user_id = v_user_id;
    
    RAISE NOTICE '✅ Cleared all encryption data';
  END IF;
END $$;

