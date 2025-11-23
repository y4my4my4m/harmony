-- RLS Performance Optimization
-- This script fixes RLS policies by wrapping auth.uid() in subqueries
-- to prevent re-evaluation for each row, improving query performance at scale.
-- 
-- Pattern: auth.uid() -> (SELECT auth.uid())
--
-- Date: 2025-11-23

-- ============================================================================
-- REACTIONS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view reactions on messages they can see" ON public.reactions;
DROP POLICY IF EXISTS "Users can create reactions on messages they can see" ON public.reactions;
DROP POLICY IF EXISTS "Users can update their own reactions" ON public.reactions;
DROP POLICY IF EXISTS "Users can delete their own reactions" ON public.reactions;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view reactions on messages they can see" ON public.reactions 
FOR SELECT USING ((message_id IN ( 
  SELECT m.id
  FROM public.messages m
  WHERE ((m.conversation_id IN ( 
    SELECT conversation_participants.conversation_id
    FROM public.conversation_participants
    WHERE ((conversation_participants.user_id = (SELECT auth.uid())) 
      AND (conversation_participants.left_at IS NULL))
  )) OR (m.channel_id IN ( 
    SELECT c.id
    FROM (public.channels c
      JOIN public.user_servers us ON ((c.server_id = us.server_id)))
    WHERE (us.user_id = (SELECT auth.uid()))
  )))
)));

CREATE POLICY "Users can create reactions on messages they can see" ON public.reactions 
FOR INSERT WITH CHECK (((user_id = (SELECT auth.uid())) AND (message_id IN ( 
  SELECT m.id
  FROM public.messages m
  WHERE ((m.conversation_id IN ( 
    SELECT conversation_participants.conversation_id
    FROM public.conversation_participants
    WHERE ((conversation_participants.user_id = (SELECT auth.uid())) 
      AND (conversation_participants.left_at IS NULL))
  )) OR (m.channel_id IN ( 
    SELECT c.id
    FROM (public.channels c
      JOIN public.user_servers us ON ((c.server_id = us.server_id)))
    WHERE (us.user_id = (SELECT auth.uid()))
  )))
))));

CREATE POLICY "Users can update their own reactions" ON public.reactions 
FOR UPDATE USING ((user_id = (SELECT auth.uid())));

CREATE POLICY "Users can delete their own reactions" ON public.reactions 
FOR DELETE USING ((user_id = (SELECT auth.uid())));

-- ============================================================================
-- POST_INTERACTIONS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view post interactions on posts they can see" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can create post interactions on posts they can see" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can create their own interactions" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can update their own interactions" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can update their own post interactions" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can delete their own interactions" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can delete their own post interactions" ON public.post_interactions;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions 
FOR SELECT USING ((post_id IN ( 
  SELECT p.id
  FROM public.posts p
  WHERE ((p.author_id = (SELECT auth.uid())) 
    OR (p.visibility = 'public'::text) 
    OR ((p.visibility = 'followers'::text) AND (EXISTS ( 
      SELECT 1
      FROM public.follows f
      WHERE ((f.follower_id = (SELECT auth.uid())) 
        AND (f.following_id = p.author_id) 
        AND (f.status = 'accepted'::text))
    ))))
)));

CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions 
FOR INSERT WITH CHECK (((user_id = (SELECT auth.uid())) AND (post_id IN ( 
  SELECT p.id
  FROM public.posts p
  WHERE ((p.author_id = (SELECT auth.uid())) 
    OR (p.visibility = 'public'::text) 
    OR ((p.visibility = 'followers'::text) AND (EXISTS ( 
      SELECT 1
      FROM public.follows f
      WHERE ((f.follower_id = (SELECT auth.uid())) 
        AND (f.following_id = p.author_id) 
        AND (f.status = 'accepted'::text))
    ))))
))));

CREATE POLICY "Users can create their own interactions" ON public.post_interactions 
FOR INSERT WITH CHECK (((SELECT auth.uid()) = user_id));

CREATE POLICY "Users can update their own interactions" ON public.post_interactions 
FOR UPDATE USING (((SELECT auth.uid()) = user_id));

CREATE POLICY "Users can update their own post interactions" ON public.post_interactions 
FOR UPDATE USING ((user_id = (SELECT auth.uid())));

CREATE POLICY "Users can delete their own interactions" ON public.post_interactions 
FOR DELETE USING (((SELECT auth.uid()) = user_id));

CREATE POLICY "Users can delete their own post interactions" ON public.post_interactions 
FOR DELETE USING ((user_id = (SELECT auth.uid())));

-- ============================================================================
-- POSTS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can view posts from users they follow" ON public.posts;
DROP POLICY IF EXISTS "Users can create their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can delete their own posts" ON public.posts;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view their own posts" ON public.posts 
FOR SELECT USING (((SELECT auth.uid()) = author_id));

CREATE POLICY "Users can view posts from users they follow" ON public.posts 
FOR SELECT USING (((visibility = 'followers'::text) 
  AND (is_deleted = false) 
  AND (EXISTS ( 
    SELECT 1
    FROM public.follows
    WHERE ((follows.follower_id = (SELECT auth.uid())) 
      AND (follows.following_id = posts.author_id) 
      AND (follows.status = 'accepted'::text))
  ))
));

CREATE POLICY "Users can create their own posts" ON public.posts 
FOR INSERT WITH CHECK (((SELECT auth.uid()) = author_id));

CREATE POLICY "Users can update their own posts" ON public.posts 
FOR UPDATE USING (((SELECT auth.uid()) = author_id));

CREATE POLICY "Users can delete their own posts" ON public.posts 
FOR DELETE USING (((SELECT auth.uid()) = author_id));

-- ============================================================================
-- FOLLOWS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view follows" ON public.follows;
DROP POLICY IF EXISTS "Users can create follow relationships" ON public.follows;
DROP POLICY IF EXISTS "Users can update their follow relationships" ON public.follows;
DROP POLICY IF EXISTS "Users can delete their follow relationships" ON public.follows;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view follows" ON public.follows 
FOR SELECT USING ((((SELECT auth.uid()) = follower_id) OR ((SELECT auth.uid()) = following_id)));

CREATE POLICY "Users can create follow relationships" ON public.follows 
FOR INSERT WITH CHECK (((SELECT auth.uid()) = follower_id));

CREATE POLICY "Users can update their follow relationships" ON public.follows 
FOR UPDATE USING ((((SELECT auth.uid()) = follower_id) OR ((SELECT auth.uid()) = following_id)));

CREATE POLICY "Users can delete their follow relationships" ON public.follows 
FOR DELETE USING ((((SELECT auth.uid()) = follower_id) OR ((SELECT auth.uid()) = following_id)));

-- ============================================================================
-- CONVERSATIONS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON public.conversations;
DROP POLICY IF EXISTS "Authenticated users can create conversations" ON public.conversations;
DROP POLICY IF EXISTS "Conversation participants can update conversations" ON public.conversations;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view conversations they participate in" ON public.conversations 
FOR SELECT USING ((EXISTS ( 
  SELECT 1
  FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) 
    AND (conversation_participants.user_id = (SELECT auth.uid())) 
    AND (conversation_participants.left_at IS NULL))
)));

CREATE POLICY "Authenticated users can create conversations" ON public.conversations 
FOR INSERT WITH CHECK (((SELECT auth.uid()) IS NOT NULL));

CREATE POLICY "Conversation participants can update conversations" ON public.conversations 
FOR UPDATE USING ((((SELECT auth.uid()) IS NOT NULL) AND (EXISTS ( 
  SELECT 1
  FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) 
    AND (conversation_participants.user_id = (SELECT auth.uid())) 
    AND (conversation_participants.left_at IS NULL))
))));

-- ============================================================================
-- CONVERSATION_PARTICIPANTS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Authenticated users can manage participants" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can update their own participation" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can update their own participations" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can leave conversations" ON public.conversation_participants;
DROP POLICY IF EXISTS "conversation_participants_insert_policy" ON public.conversation_participants;
DROP POLICY IF EXISTS "conversation_participants_delete_policy" ON public.conversation_participants;

-- Recreate with optimized auth.uid()
CREATE POLICY "Authenticated users can manage participants" ON public.conversation_participants 
FOR INSERT WITH CHECK (((SELECT auth.uid()) IS NOT NULL));

CREATE POLICY "Users can update their own participation" ON public.conversation_participants 
FOR UPDATE USING ((((SELECT auth.uid()) IS NOT NULL) AND (user_id = (SELECT auth.uid())))) 
WITH CHECK ((((SELECT auth.uid()) IS NOT NULL) AND (user_id = (SELECT auth.uid()))));

CREATE POLICY "Users can update their own participations" ON public.conversation_participants 
FOR UPDATE USING ((user_id = (SELECT auth.uid())));

CREATE POLICY "Users can leave conversations" ON public.conversation_participants 
FOR DELETE USING ((((SELECT auth.uid()) IS NOT NULL) AND (user_id = (SELECT auth.uid()))));

CREATE POLICY "conversation_participants_insert_policy" ON public.conversation_participants 
FOR INSERT WITH CHECK (((user_id = (SELECT auth.uid())) OR ((SELECT auth.uid()) IN ( 
  SELECT cp.user_id
  FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = conversation_participants.conversation_id) 
    AND (cp.left_at IS NULL))
))));

CREATE POLICY "conversation_participants_delete_policy" ON public.conversation_participants 
FOR DELETE USING ((user_id = (SELECT auth.uid())));

-- ============================================================================
-- MESSAGES TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view messages in conversations they participate in" ON public.messages;
DROP POLICY IF EXISTS "Users can create messages in conversations they participate in" ON public.messages;
DROP POLICY IF EXISTS "Message owner or server owner can update" ON public.messages;
DROP POLICY IF EXISTS "messages_delete_policy" ON public.messages;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view messages in conversations they participate in" ON public.messages 
FOR SELECT USING ((((conversation_id IS NOT NULL) AND (EXISTS ( 
  SELECT 1
  FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = messages.conversation_id) 
    AND (conversation_participants.user_id = (SELECT auth.uid())) 
    AND (conversation_participants.left_at IS NULL))
))) OR ((channel_id IS NOT NULL) AND (EXISTS ( 
  SELECT 1
  FROM (public.channels c
    JOIN public.user_servers us ON ((c.server_id = us.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = (SELECT auth.uid())))
)))));

CREATE POLICY "Users can create messages in conversations they participate in" ON public.messages 
FOR INSERT WITH CHECK (((user_id = (SELECT auth.uid())) AND (((conversation_id IS NOT NULL) AND (EXISTS ( 
  SELECT 1
  FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = messages.conversation_id) 
    AND (conversation_participants.user_id = (SELECT auth.uid())) 
    AND (conversation_participants.left_at IS NULL))
))) OR ((channel_id IS NOT NULL) AND (EXISTS ( 
  SELECT 1
  FROM (public.channels c
    JOIN public.user_servers us ON ((c.server_id = us.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = (SELECT auth.uid())))
))))));

CREATE POLICY "Message owner or server owner can update" ON public.messages 
FOR UPDATE USING ((((SELECT auth.uid()) = user_id) OR ((SELECT auth.uid()) = ( 
  SELECT servers.owner
  FROM (public.channels
    JOIN public.servers ON ((channels.server_id = servers.id)))
  WHERE (channels.id = messages.channel_id)
))));

CREATE POLICY "messages_delete_policy" ON public.messages 
FOR DELETE USING (((user_id = (SELECT auth.uid())) OR ((channel_id IS NOT NULL) AND (EXISTS ( 
  SELECT 1
  FROM (public.channels c
    JOIN public.servers s ON ((c.server_id = s.id)))
  WHERE ((c.id = messages.channel_id) AND (s.owner = (SELECT auth.uid())))
)))));

-- ============================================================================
-- PROFILES TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can insert their own profile." ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;
DROP POLICY IF EXISTS "System can manage federated profiles" ON public.profiles;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can insert their own profile." ON public.profiles 
FOR INSERT WITH CHECK (((SELECT auth.uid()) = id));

CREATE POLICY "Users can update own profile." ON public.profiles 
FOR UPDATE USING (((SELECT auth.uid()) = id));

CREATE POLICY "System can manage federated profiles" ON public.profiles 
USING (((is_local = false) OR (auth_user_id = (SELECT auth.uid()))));

-- ============================================================================
-- TIMELINE_ENTRIES TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own timeline entries" ON public.timeline_entries;
DROP POLICY IF EXISTS "Users can insert their own timeline entries" ON public.timeline_entries;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view their own timeline entries" ON public.timeline_entries 
FOR SELECT USING (((SELECT auth.uid()) = user_id));

CREATE POLICY "Users can insert their own timeline entries" ON public.timeline_entries 
FOR INSERT WITH CHECK (((SELECT auth.uid()) = user_id));

-- ============================================================================
-- UNREAD_COUNTS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own unread counts" ON public.unread_counts;
DROP POLICY IF EXISTS "Users can update their own unread counts" ON public.unread_counts;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view their own unread counts" ON public.unread_counts 
FOR SELECT USING (((SELECT auth.uid()) = user_id));

CREATE POLICY "Users can update their own unread counts" ON public.unread_counts 
FOR UPDATE USING (((SELECT auth.uid()) = user_id));

-- ============================================================================
-- USER_BLOCKS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own blocks" ON public.user_blocks;
DROP POLICY IF EXISTS "Check if blocked by user" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can block other users" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can remove their own blocks" ON public.user_blocks;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view their own blocks" ON public.user_blocks 
FOR SELECT USING ((blocker_id = (SELECT auth.uid())));

CREATE POLICY "Check if blocked by user" ON public.user_blocks 
FOR SELECT USING ((blocked_user_id = (SELECT auth.uid())));

CREATE POLICY "Users can block other users" ON public.user_blocks 
FOR INSERT WITH CHECK ((blocker_id = (SELECT auth.uid())));

CREATE POLICY "Users can remove their own blocks" ON public.user_blocks 
FOR DELETE USING ((blocker_id = (SELECT auth.uid())));

-- ============================================================================
-- AP_ACTIVITIES TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own activities" ON public.ap_activities;
DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities;
DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view their own activities" ON public.ap_activities 
FOR SELECT USING ((actor_id = (SELECT auth.uid())));

CREATE POLICY "Users can create their own activities" ON public.ap_activities 
FOR INSERT WITH CHECK ((actor_id = (SELECT auth.uid())));

CREATE POLICY "Users can update their own activities" ON public.ap_activities 
FOR UPDATE USING ((actor_id = (SELECT auth.uid())));

-- ============================================================================
-- SERVER_FEDERATION_EVENTS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view server events they're involved in" ON public.server_federation_events;
DROP POLICY IF EXISTS "Users can create their own server events" ON public.server_federation_events;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view server events they're involved in" ON public.server_federation_events 
FOR SELECT USING ((user_id = (SELECT auth.uid())));

CREATE POLICY "Users can create their own server events" ON public.server_federation_events 
FOR INSERT WITH CHECK ((user_id = (SELECT auth.uid())));

-- ============================================================================
-- VOICE_FEDERATION_EVENTS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view voice events they're involved in" ON public.voice_federation_events;
DROP POLICY IF EXISTS "Users can create their own voice events" ON public.voice_federation_events;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events 
FOR SELECT USING ((user_id = (SELECT auth.uid())));

CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events 
FOR INSERT WITH CHECK ((user_id = (SELECT auth.uid())));

-- ============================================================================
-- USER_TIMELINE_CACHE TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can access own timeline cache" ON public.user_timeline_cache;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache 
USING (((SELECT auth.uid()) = user_id));

-- ============================================================================
-- FEDERATED_INSTANCES TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Only authenticated users can manage instances" ON public.federated_instances;

-- Recreate with optimized auth.uid()
CREATE POLICY "Only authenticated users can manage instances" ON public.federated_instances 
USING (((SELECT auth.uid()) IS NOT NULL));

-- ============================================================================
-- NOTIFICATION_CHANNELS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can manage their own notification channels" ON public.notification_channels;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can manage their own notification channels" ON public.notification_channels 
USING (((SELECT auth.uid()) = user_id));

-- ============================================================================
-- NOTIFICATION_PREFERENCES TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can manage their own notification preferences" ON public.notification_preferences;

-- Recreate with optimized auth.uid()
CREATE POLICY "Users can manage their own notification preferences" ON public.notification_preferences 
USING (((SELECT auth.uid()) = user_id));

-- ============================================================================
-- NOTIFICATIONS TABLE POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Enable insert for users based on user_id" ON public.notifications;
DROP POLICY IF EXISTS "notifications_realtime_delete" ON public.notifications;

-- Recreate with optimized auth.uid()
CREATE POLICY "Enable insert for users based on user_id" ON public.notifications 
FOR UPDATE USING ((( SELECT (SELECT auth.uid()) AS uid) = user_id)) 
WITH CHECK ((( SELECT (SELECT auth.uid()) AS uid) = user_id));

CREATE POLICY "notifications_realtime_delete" ON public.notifications 
FOR DELETE USING (((SELECT auth.uid()) = user_id));

-- ============================================================================
-- COMPLETION
-- ============================================================================

-- All RLS policies have been optimized with (SELECT auth.uid()) pattern
-- This ensures auth.uid() is evaluated once per query instead of once per row
-- Significantly improving query performance at scale

