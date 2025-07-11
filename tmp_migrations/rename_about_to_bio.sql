-- Migration: Rename 'about' column to 'bio' in profiles table
-- This aligns with ActivityPub standard field naming

BEGIN;

-- Rename the column from 'about' to 'bio'
ALTER TABLE public.profiles 
RENAME COLUMN about TO bio;

-- Update any indexes if they reference the old column name
-- (Check if there are any indexes on the about column first)

COMMIT;

-- After running this migration:
-- 1. All code should reference 'bio' consistently
-- 2. Database will use 'bio' field name
-- 3. ActivityPub federation will work correctly 