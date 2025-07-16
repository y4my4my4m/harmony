-- Fix profiles username constraint for federation
-- The current constraint only prevents duplicate usernames globally,
-- but in a federated system, the same username can exist on different domains.
-- We need to enforce uniqueness on (username, domain) combination instead.

-- First, drop the existing constraint that only checks username
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_key;

-- Create a new constraint that ensures uniqueness on (username, domain) combination
-- This allows the same username to exist on different domains, which is correct for federation
ALTER TABLE public.profiles 
ADD CONSTRAINT profiles_username_domain_key UNIQUE (username, domain);

-- Also ensure that local users (is_local = true) have unique usernames within the local domain
-- This is already covered by the above constraint since local users have domain = 'har.mony.lol'

-- Add an index for performance on common queries
CREATE INDEX IF NOT EXISTS idx_profiles_username_domain ON public.profiles (username, domain);
CREATE INDEX IF NOT EXISTS idx_profiles_is_local_username ON public.profiles (is_local, username) WHERE is_local = true;

-- Add a comment to document the constraint
COMMENT ON CONSTRAINT profiles_username_domain_key ON public.profiles IS 
'Ensures username uniqueness per domain in federated system. Same username can exist on different domains.';
