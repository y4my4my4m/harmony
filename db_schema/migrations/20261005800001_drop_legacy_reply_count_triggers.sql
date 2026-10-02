-- posts carries one reply-count trigger.
--
-- Production also has update_reply_count_on_post_insert_update (AFTER INSERT OR UPDATE OF
-- is_deleted) and update_reply_count_on_post_delete (AFTER DELETE), both calling
-- update_post_reply_count() beside trg_update_post_reply_count. A local parent's count is
-- recomputed on every firing and stays exact; a remote parent's count moves by a delta, so each
-- reply, deletion or restore moved it by two. Remote counts carry the origin server's figure
-- and are not recomputed here; they are corrected when the post is next refreshed from origin.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS update_reply_count_on_post_insert_update ON public.posts;
DROP TRIGGER IF EXISTS update_reply_count_on_post_delete ON public.posts;

COMMIT;
