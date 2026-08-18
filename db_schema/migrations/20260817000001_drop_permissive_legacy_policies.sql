-- Removes ten legacy RLS policies that widen access past what the schema intends.
--
-- Permissive policies for the same command are OR'd, so an extra policy can only
-- ever grant more. Each of these sits alongside a stricter policy that already
-- covers the legitimate case, and each was verified present in production before
-- its weaker twin is removed here. None exists in db_schema/init/, so this file
-- is a no-op against a fresh build and the drift gate stays green.
--
-- Ordered by severity. The first two are reachable by any authenticated user.

BEGIN;

-- 1. Any authenticated user could post into any channel of any server.
--
-- WITH CHECK was
--   (user_id = get_current_profile_id())
--   AND ((channel_id IS NOT NULL) OR (conversation_id IS NULL) OR NOT EXISTS(...))
-- The second conjunct carries no membership test at all: `channel_id IS NOT NULL`
-- satisfies it outright, and the conversation branch only asks that no OTHER
-- participant has blocked the caller - never that the caller is a participant. So
-- the only real constraint was "claim to be yourself".
--
-- messages_insert_member covers every legitimate insert and does check
-- membership: accepted user_servers row for a channel, or a conversation_participants
-- row with left_at IS NULL.
DROP POLICY IF EXISTS messages_insert_own ON public.messages;

-- 2. Any authenticated user could rewrite or delete any remote profile.
--
-- USING ((is_local = false) OR (auth_user_id = auth.uid())) with no FOR (so ALL
-- commands), no TO (so PUBLIC), and no WITH CHECK - which means USING is reused as
-- the write check and is evaluated against the NEW row. The first disjunct carries
-- no identity test, so every federated profile was writable by anyone holding the
-- table grant, which `authenticated` does. A single UPDATE setting
-- is_local = true, auth_user_id = <attacker> claims the row outright, and a DELETE
-- cascades through the 62 ON DELETE CASCADE foreign keys pointing at profiles(id).
--
-- Nothing needs it: remote profiles are written through the SECURITY DEFINER RPCs
-- create_federated_profile and safe_upsert_remote_profile, and federation-backend
-- connects with the service role, which bypasses RLS entirely
-- (federation-backend/src/config/supabase.ts).
DROP POLICY IF EXISTS "System can manage federated profiles" ON public.profiles;

-- 3. A user could rewrite their own auth_user_id, which is identity takeover.
--
-- profiles_update_own is USING (auth_user_id = auth.uid()) with no WITH CHECK, so
-- the USING doubles as the write check and pins auth_user_id on the resulting row.
-- This policy supplied a second, weaker check - WITH CHECK (id = get_current_profile_id())
-- constrains only id - and permissive checks are OR'd, so the weak one admits the write.
--
-- Production cannot reject the resulting duplicate: idx_profiles_auth_user_id_unique
-- is a plain btree despite its name and there is no UNIQUE constraint on the column.
-- get_current_profile_id() is `SELECT id FROM profiles WHERE auth_user_id = auth.uid()
-- LIMIT 1` with no ORDER BY, so once two rows share an auth_user_id either may win.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- 4. A profile could be inserted carrying somebody else's auth_user_id.
--
-- WITH CHECK ((SELECT auth.uid()) = id) compares the auth user id against
-- profiles.id, which are different keyspaces - profiles.id is the profile key and
-- auth_user_id is the auth user. The check therefore says nothing at all about
-- auth_user_id, so a row could be inserted claiming any auth user, which given the
-- missing UNIQUE constraint on that column is the same takeover as 3 by another
-- route.
--
-- profiles_insert_own requires auth_user_id = auth.uid(), and both client paths
-- already satisfy it: CoreProfileService.ts sets auth_user_id explicitly, and
-- ProfileService.createProfile takes it as a required argument.
DROP POLICY IF EXISTS "Users can insert their own profile." ON public.profiles;

-- 5. Any authenticated user could forge a notification for any user.
--
-- FOR INSERT TO authenticated WITH CHECK (true) - no constraint whatsoever, so the
-- recipient user_id, the type and the rendered `data` payload were all
-- attacker-chosen. notifications_insert_system restricts INSERT to service_role,
-- which is correct: notifications are produced by SECURITY DEFINER triggers, and no
-- client code inserts into this table.
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.notifications;

-- 6. A room key could be shared with someone who is not in the room.
--
-- WITH CHECK only established that the sender is the caller.
-- megolm_session_shares_insert additionally requires is_room_member() for BOTH the
-- sender and the recipient, which is the membership boundary the E2EE design rests
-- on. The legitimate share path shares to actual room members and satisfies it.
DROP POLICY IF EXISTS "Senders can create session shares" ON public.megolm_session_shares;

-- 7. Anyone, including anonymous callers, could read the WebRTC settings row.
--
-- FOR SELECT USING (true) while anon holds SELECT. Today the row carries only
-- webrtc_mode and livekit_url, so the exposure is modest - but init/ adds
-- livekit_api_key, livekit_api_secret and turn_servers to this table, and
-- init/30_rls_policies.sql states "This table contains livekit_api_secret which MUST
-- NOT be exposed". Left in place, converging the table shape would publish the
-- LiveKit secret to anonymous callers, who could then mint arbitrary room tokens.
--
-- webrtc_settings_select_admin_only is the intended reader, and the admin client
-- already tolerates the row being hidden.
DROP POLICY IF EXISTS "Anyone can read webrtc settings" ON public.instance_webrtc_settings;

-- 8-10. Blocking was not enforced when reading posts.
--
-- posts_select_public gates each visibility branch behind
-- (NOT is_blocked_by(author_id)) AND (NOT has_blocked(author_id)); these three
-- re-permit exactly the rows it denies, so at the RLS layer the block feature was
-- inert for authenticated readers. The follower branch is the material one: a
-- blocked viewer keeps an accepted follow row - follows_delete_own only lets the
-- follower remove it, so the blocker cannot - and so kept reading follower-only
-- posts. The other two concern public and own posts and are visibility-preserving.
DROP POLICY IF EXISTS "Users can view posts from users they follow" ON public.posts;
DROP POLICY IF EXISTS "Users can view public posts" ON public.posts;
DROP POLICY IF EXISTS "Users can view their own posts" ON public.posts;

COMMIT;

NOTIFY pgrst, 'reload schema';
