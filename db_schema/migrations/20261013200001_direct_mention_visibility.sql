-- "Mentioned people only" posts readable by the local accounts they mention.
--
-- posts_select_public let only the author read a post with visibility 'direct'. A local
-- account mentioned in one received the mention notification and could not open the post or
-- reply to it. Inbound remote direct posts go to `messages` (ActivityProcessor
-- handleDirectMessage); local ones stay in `posts`.
--
-- The mention test is the one followers-only posts use (20261011900001): a mention part with
-- isLocal true naming the reader's username. A remote mention sharing the username does not
-- match.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER POLICY "posts_select_public" ON public.posts
    USING (
        author_id = ( SELECT public.get_current_profile_id() )
        OR (
            author_id NOT IN ( SELECT public.current_user_block_peer_ids() )
            AND (
                visibility IN ('public', 'unlisted')
                OR (visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows
                    WHERE follows.follower_id = ( SELECT public.get_current_profile_id() )
                      AND follows.following_id = posts.author_id
                      AND follows.status = 'accepted'
                ))
                OR (visibility IN ('followers', 'direct') AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(posts.content) part
                    WHERE part->>'type' = 'mention'
                      AND part->>'isLocal' = 'true'
                      AND part->>'username' = ( SELECT public.current_profile_username() )
                ))
            )
        )
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
