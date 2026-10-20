-- Votes on remote polls.
--
-- A remote poll is a post stored from an ActivityPub Question (federation-backend
-- utils/polls.ts): is_local false, ap_type 'Question', and the posts.metadata keys is_poll,
-- poll_options [{name, votes}], poll_multiple_choice, poll_end_time, poll_voters_count and
-- poll_closed. post_poll_votes holds the answers a local account chose, as indexes into
-- poll_options. A vote is final, as on Mastodon: ActivityPub carries no retraction of one.
--
-- vote_remote_poll(p_post_id, p_choices) records the caller's answers on a poll the caller
-- can read (the rules of posts_select_public), not closed and not past its end time, with
-- one answer unless the poll is multiple choice. The stored counts take the vote at once:
-- each chosen answer's votes by one, poll_voters_count by one where the origin reported a
-- count, set to 1 where nobody had voted. The origin's next Update Question replaces them.
-- The vote is queued as the job 'federate-poll-vote', which delivers one
-- Create{Note{name, inReplyTo}} per answer to the poll author's inbox and sets delivered_at;
-- the worker's sweep requeues votes left undelivered.
--
-- A client reads its own votes (post_poll_votes_select_own) and writes none directly.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- user_id carries no foreign key to profiles. With keys to both posts and profiles inside its
-- primary key, PostgREST reads the table as a posts <-> profiles junction, and every posts
-- request embedding profiles fails with PGRST201 (more than one relationship found).
CREATE TABLE IF NOT EXISTS public.post_poll_votes (
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    choice smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    PRIMARY KEY (post_id, user_id, choice),
    CONSTRAINT post_poll_votes_choice_range CHECK (choice BETWEEN 0 AND 99)
);

CREATE INDEX IF NOT EXISTS post_poll_votes_user_idx ON public.post_poll_votes (user_id);
CREATE INDEX IF NOT EXISTS post_poll_votes_undelivered_idx
    ON public.post_poll_votes (created_at) WHERE delivered_at IS NULL;

REVOKE ALL ON public.post_poll_votes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.post_poll_votes TO authenticated;
GRANT ALL ON public.post_poll_votes TO service_role;

ALTER TABLE public.post_poll_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS post_poll_votes_select_own ON public.post_poll_votes;
CREATE POLICY post_poll_votes_select_own ON public.post_poll_votes
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.get_current_profile_id()));

DROP POLICY IF EXISTS post_poll_votes_service_role ON public.post_poll_votes;
CREATE POLICY post_poll_votes_service_role ON public.post_poll_votes
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- The caller's answers on a remote poll; the post's metadata after the vote.
CREATE OR REPLACE FUNCTION public.vote_remote_poll(p_post_id uuid, p_choices integer[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_post record;
    v_options jsonb;
    v_choices integer[];
    v_end timestamp with time zone;
    v_voters integer;
    v_sum integer;
    v_metadata jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'POLL_VOTE_UNAUTHENTICATED: sign in to vote' USING ERRCODE = '42501';
    END IF;

    SELECT p.id, p.author_id, p.visibility, p.content, p.metadata
      INTO v_post
      FROM public.posts p
     WHERE p.id = p_post_id
       AND p.is_local IS FALSE
       AND p.ap_type = 'Question'
       AND p.is_deleted IS NOT TRUE
       AND p.metadata->>'is_poll' = 'true'
     FOR UPDATE;

    -- posts_select_public, for a post the caller did not write.
    IF NOT FOUND
       OR v_post.author_id IN (SELECT public.current_user_block_peer_ids())
       OR NOT (
            v_post.visibility IN ('public', 'unlisted')
            OR (v_post.visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows f
                     WHERE f.follower_id = v_me
                       AND f.following_id = v_post.author_id
                       AND f.status = 'accepted'))
            OR (v_post.visibility IN ('followers', 'direct') AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(v_post.content) part
                     WHERE part->>'type' = 'mention'
                       AND part->>'isLocal' = 'true'
                       AND part->>'username' = (SELECT public.current_profile_username())))) THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: no remote poll %', p_post_id USING ERRCODE = 'P0002';
    END IF;

    v_metadata := v_post.metadata;
    v_end := CASE WHEN v_metadata->>'poll_end_time' ~ '^\d{4}-\d{2}-\d{2}'
                  THEN (v_metadata->>'poll_end_time')::timestamp with time zone END;
    IF v_metadata->>'poll_closed' = 'true' OR v_end <= now() THEN
        RAISE EXCEPTION 'POLL_CLOSED: the poll has ended' USING ERRCODE = '22023';
    END IF;

    v_options := CASE WHEN jsonb_typeof(v_metadata->'poll_options') = 'array'
                      THEN v_metadata->'poll_options' ELSE '[]'::jsonb END;
    SELECT array_agg(DISTINCT c ORDER BY c) INTO v_choices FROM unnest(p_choices) c WHERE c IS NOT NULL;
    IF v_choices IS NULL
       OR EXISTS (SELECT 1 FROM unnest(v_choices) c WHERE c < 0 OR c >= jsonb_array_length(v_options)) THEN
        RAISE EXCEPTION 'POLL_CHOICE_INVALID: answers must name options of the poll' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_choices) > 1 AND v_metadata->>'poll_multiple_choice' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'POLL_SINGLE_CHOICE: the poll takes one answer' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.post_poll_votes v WHERE v.post_id = p_post_id AND v.user_id = v_me) THEN
        RAISE EXCEPTION 'POLL_ALREADY_VOTED: a vote is final' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.post_poll_votes (post_id, user_id, choice)
    SELECT p_post_id, v_me, c FROM unnest(v_choices) c;

    SELECT COALESCE(sum(CASE WHEN (o.value->>'votes') ~ '^\d+$' THEN (o.value->>'votes')::integer ELSE 0 END), 0)
      INTO v_sum
      FROM jsonb_array_elements(v_options) o;

    v_metadata := jsonb_set(v_metadata, '{poll_options}', COALESCE((
        SELECT jsonb_agg(
                   CASE WHEN (o.ord - 1)::integer = ANY (v_choices)
                        THEN o.value || jsonb_build_object('votes',
                                 CASE WHEN (o.value->>'votes') ~ '^\d+$' THEN (o.value->>'votes')::integer ELSE 0 END + 1)
                        ELSE o.value END
                   ORDER BY o.ord)
          FROM jsonb_array_elements(v_options) WITH ORDINALITY o(value, ord)), '[]'::jsonb));

    v_voters := CASE WHEN (v_metadata->>'poll_voters_count') ~ '^\d+$'
                     THEN (v_metadata->>'poll_voters_count')::integer ELSE 0 END;
    IF v_voters > 0 THEN
        v_metadata := jsonb_set(v_metadata, '{poll_voters_count}', to_jsonb(v_voters + 1));
    ELSIF v_sum = 0 THEN
        v_metadata := jsonb_set(v_metadata, '{poll_voters_count}', to_jsonb(1));
    END IF;

    UPDATE public.posts SET metadata = v_metadata WHERE id = p_post_id;

    PERFORM public.queue_federation_job(
        'federate-poll-vote',
        jsonb_build_object('type', 'create', 'post_id', p_post_id, 'user_id', v_me));

    RETURN v_metadata;
END;
$$;

REVOKE ALL ON FUNCTION public.vote_remote_poll(uuid, integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_remote_poll(uuid, integer[]) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
