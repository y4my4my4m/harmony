-- Ten legacy policies that widen access. Permissive policies for one command are OR'd,
-- so each can only grant more than the stricter policy beside it. None exists in init/.

BEGIN;

-- WITH CHECK carried no membership test: `channel_id IS NOT NULL` satisfied it outright,
-- and the conversation branch never asked that the caller be a participant.
DROP POLICY IF EXISTS messages_insert_own ON public.messages;

-- USING ((is_local = false) OR ...) with no FOR, no TO and no WITH CHECK, so USING is the
-- write check against the NEW row. Any caller could claim or delete any remote profile,
-- and a delete cascades through 62 foreign keys onto profiles(id).
DROP POLICY IF EXISTS "System can manage federated profiles" ON public.profiles;

-- WITH CHECK constrained id only, leaving auth_user_id writable.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- WITH CHECK compares auth.uid() against profiles.id. Different keyspaces, so it
-- constrains auth_user_id not at all.
DROP POLICY IF EXISTS "Users can insert their own profile." ON public.profiles;

-- FOR INSERT WITH CHECK (true): recipient, type and payload all caller-chosen.
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.notifications;

-- Established that the sender is the caller, not that either party is in the room.
DROP POLICY IF EXISTS "Senders can create session shares" ON public.megolm_session_shares;

-- FOR SELECT USING (true) while anon holds SELECT. init/ adds livekit_api_secret to this
-- table, which would publish it.
DROP POLICY IF EXISTS "Anyone can read webrtc settings" ON public.instance_webrtc_settings;

-- These re-permit exactly the rows posts_select_public denies for a block, leaving
-- blocking inert at the RLS layer. A blocked viewer keeps an accepted follow row, so the
-- follower branch kept serving follower-only posts.
DROP POLICY IF EXISTS "Users can view posts from users they follow" ON public.posts;
DROP POLICY IF EXISTS "Users can view public posts" ON public.posts;
DROP POLICY IF EXISTS "Users can view their own posts" ON public.posts;

COMMIT;

NOTIFY pgrst, 'reload schema';
