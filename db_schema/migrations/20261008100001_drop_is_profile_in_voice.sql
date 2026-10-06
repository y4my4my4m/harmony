-- is_profile_in_voice(uuid) has no caller: a DM call callee decides busy on its own client
-- since 1.6.10. The function told any signed-in user whether a given profile was in a voice
-- channel. Clients up to 1.6.9 call it for busy and read an error as not busy.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.is_profile_in_voice(uuid);

COMMIT;
