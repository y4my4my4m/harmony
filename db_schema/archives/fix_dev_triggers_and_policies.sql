-- Migration: fix_dev_triggers_and_policies.sql
-- Target: DEV environment
-- Purpose: Apply 3 fixes from local integration test audit
-- Safe to run multiple times (all statements are idempotent)

BEGIN;

-- =========================================================================
-- FIX 1: route_server_leave() - prevent FK error during cascading deletes
-- =========================================================================
-- When a user profile is deleted, user_servers rows cascade-delete, firing
-- this trigger. If the server was also cascade-deleted (e.g. the user was
-- the owner), the INSERT into server_membership_events fails with a FK
-- violation. Adding an existence check fixes this.

CREATE OR REPLACE FUNCTION public.route_server_leave()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
BEGIN
  -- Guard: skip if the server no longer exists (cascade delete)
  SELECT * INTO v_server
  FROM servers
  WHERE id = OLD.server_id;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_user
  FROM profiles
  WHERE id = OLD.user_id;

  IF v_server.is_local_server = false THEN
    PERFORM pg_notify('user_leave_remote_server',
      json_build_object(
        'user_id', OLD.user_id,
        'server_id', OLD.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
  END IF;

  IF v_server.is_local_server = true AND v_user IS NOT NULL AND v_user.is_local = false THEN
    PERFORM pg_notify('remote_user_left_server',
      json_build_object(
        'user_id', OLD.user_id,
        'user_ap_id', v_user.ap_id,
        'server_id', OLD.server_id
      )::text
    );
  END IF;

  -- Log membership event only if server still exists
  IF EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id) THEN
    INSERT INTO server_membership_events (server_id, user_id, event_type, payload)
    VALUES (OLD.server_id, OLD.user_id, 'leave', '{}'::jsonb);
  END IF;

  RETURN OLD;
END;
$$;


-- =========================================================================
-- FIX 2: posts_select_public - hide posts from users you've blocked
-- =========================================================================
-- The existing policy only hides posts from users who blocked YOU
-- (is_blocked_by), but doesn't hide posts from users YOU'VE blocked
-- (has_blocked). This fix adds the has_blocked check.

DROP POLICY IF EXISTS "posts_select_public" ON public.posts;

CREATE POLICY "posts_select_public" ON public.posts
    FOR SELECT USING (
        author_id = public.get_current_profile_id()
        OR (
            NOT public.is_blocked_by(author_id)
            AND NOT public.has_blocked(author_id)
            AND (
                visibility IN ('public', 'unlisted')
                OR (visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows
                    WHERE follower_id = public.get_current_profile_id()
                    AND following_id = posts.author_id
                    AND status = 'accepted'
                ))
                OR (visibility = 'direct' AND EXISTS (
                    SELECT 1 WHERE author_id = public.get_current_profile_id()
                ))
            )
        )
    );


-- =========================================================================
-- FIX 3: queue_federation_job - handle permission errors gracefully
-- =========================================================================
-- The pgboss.job table may have restrictive permissions in some setups.
-- Adding insufficient_privilege to the EXCEPTION handler prevents hard
-- failures when the function owner can't write to the pgboss schema.

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text,
    p_job_data jsonb,
    p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5,
    p_expire_in_seconds integer DEFAULT 3600
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_job_id uuid;
    v_target_domain text;
BEGIN
    INSERT INTO pgboss.job (
        id, name, data, priority, retry_limit,
        expire_in, created_on, state
    ) VALUES (
        gen_random_uuid(), p_job_name, p_job_data, p_priority, p_retry_limit,
        make_interval(secs => p_expire_in_seconds), now(), 'created'
    )
    RETURNING id INTO v_job_id;
    RETURN v_job_id;
EXCEPTION
    WHEN undefined_table OR insufficient_privilege THEN
        v_target_domain := p_job_data->>'target_domain';
        IF v_target_domain IS NOT NULL AND v_target_domain != '' THEN
            RAISE LOG 'pg-boss not available, using fallback for job % to %', p_job_name, v_target_domain;
            INSERT INTO public.federation_delivery_queue (
                activity_data, target_inbox_url, target_domain,
                sender_id, status, priority, next_attempt_at
            ) VALUES (
                p_job_data, p_job_data->>'target_inbox', v_target_domain,
                (p_job_data->>'sender_id')::UUID, 'pending', p_priority, NOW()
            )
            RETURNING id INTO v_job_id;
            RETURN v_job_id;
        ELSE
            RAISE LOG 'pg-boss not available, skipping job %', p_job_name;
            RETURN NULL;
        END IF;
END;
$$;


NOTIFY pgrst, 'reload schema';

COMMIT;
