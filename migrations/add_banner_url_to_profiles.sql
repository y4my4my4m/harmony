-- Migration: Add banner_url field to profiles table
-- Description: Adds banner/header image support to user profiles

BEGIN;

-- Add banner_url column to profiles table
ALTER TABLE public.profiles 
ADD COLUMN banner_url text NULL;

-- Add comment for the new column
COMMENT ON COLUMN public.profiles.banner_url IS 'URL to user banner/header image stored in Supabase storage';

COMMIT;
