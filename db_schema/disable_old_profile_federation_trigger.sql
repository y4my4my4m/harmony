-- Disable old profile federation trigger
-- We're now using the realtime listener in the federation backend instead

-- Drop the trigger (keep the function for reference, but disable the trigger)
DROP TRIGGER IF EXISTS trigger_unified_profile_federation ON profiles;

-- Comment for future reference
COMMENT ON FUNCTION handle_unified_profile_federation() IS 
'DEPRECATED: This trigger-based federation is replaced by realtime listener in federation-backend. 
The trigger has been disabled to prevent duplicate federation events.
The new system properly handles URL conversion for local media.';

-- Verify
DO $$
BEGIN
  RAISE NOTICE '✅ Old profile federation trigger disabled';
  RAISE NOTICE '📡 Profile updates now handled by federation-backend realtime listener';
  RAISE NOTICE '';
  RAISE NOTICE 'Benefits:';
  RAISE NOTICE '  - No duplicate update events';
  RAISE NOTICE '  - Proper URL conversion for local media';
  RAISE NOTICE '  - Consistent with other federation events (posts, follows, reactions)';
END $$;

