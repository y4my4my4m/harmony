-- =====================================================
-- FIX: Prekey is_one_time default value bug
-- 
-- Problem: is_one_time defaults to TRUE, so when signed prekeys
-- are inserted without explicitly setting is_one_time=false,
-- they get treated as one-time prekeys!
-- =====================================================

-- Step 1: Fix the default value (change from TRUE to FALSE)
ALTER TABLE public.prekeys 
ALTER COLUMN is_one_time SET DEFAULT false;

-- Step 2: Fix any existing corrupted data
-- All signed prekeys should have is_one_time = false
UPDATE public.prekeys 
SET is_one_time = false 
WHERE is_signed = true AND (is_one_time = true OR is_one_time IS NULL);

-- Step 3: Add a constraint to prevent this bug in the future
-- A prekey cannot be both signed AND one-time
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'prekeys_signed_onetime_exclusive'
    ) THEN
        ALTER TABLE public.prekeys 
        ADD CONSTRAINT prekeys_signed_onetime_exclusive 
        CHECK (NOT (is_signed = true AND is_one_time = true));
    END IF;
END $$;

-- Verify the fix
DO $$
DECLARE
    v_bad_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_bad_count
    FROM public.prekeys
    WHERE is_signed = true AND is_one_time = true;
    
    IF v_bad_count > 0 THEN
        RAISE EXCEPTION 'Still have % signed prekeys incorrectly marked as one-time!', v_bad_count;
    ELSE
        RAISE NOTICE '✅ All signed prekeys correctly marked with is_one_time = false';
    END IF;
END $$;

