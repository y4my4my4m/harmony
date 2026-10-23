-- Reports reach whoever can act: a report about a message in a server hosted on another instance
-- also goes to that server's moderators, and their resolution comes back.
--
-- Reporting instance (the message is in a copy, servers.is_local_server false):
--   reports.forward_to_server      create_report sets it for a message in a copy; p_forward_to_server
--                                  NULL means true. The insert trigger queues job 'federate-report'
--                                  {type 'create', target 'server'}: a Flag signed by the instance
--                                  actor to the Group's inbox naming the author and the message,
--                                  with the reporter's comment and never the reporter.
--   reports.server_forward_status  queued, processing, completed, failed or skipped.
--   reports.server_forwarded_at    when the Group's inbox took the Flag.
--   reports.server_resolution      'resolved' (action taken) or 'dismissed', from the Group's Resolve
--   reports.server_resolved_at     (apply_server_report_resolution). An open report takes that status
--                                  with resolved_by NULL and the reporter is notified.
--   p_forward (the reported account's instance) is dropped when that instance hosts the server and
--   the Flag goes to the Group: the Group's report reaches the same staff.
--
-- Host (the server is local):
--   create_federated_server_report  one report per Flag at a Group inbox naming a message of that
--                                  server: source 'federation', scope_server_id the server,
--                                  reporter_id NULL, metadata.flag_target 'group'. Server moderators
--                                  (get_reports_with_details with p_server_id) and instance staff
--                                  list it with the origin domain.
--   trigger_queue_report_resolution  such a report moving to resolved or dismissed queues
--                                  'federate-report' {type 'update', target 'resolution'}: the
--                                  Group's Resolve of the Flag to the reporting instance. Resolve is
--                                  Lemmy's type for a resolved report (lemmy 1.0); harmony:outcome
--                                  carries resolved or dismissed. enable_federation_triggers and
--                                  disable_federation_triggers switch its trigger with the others.
--
-- Domains: federated_instances.reject_reports (Mastodon DomainBlock#reject_reports) makes
-- create_federated_report and create_federated_server_report ignore the domain's Flags;
-- set_domain_reject_reports is its instance-admin writer.
--
-- get_reports_with_details gains server_forward: the copy's id, name and host with the forward
-- and resolution state, for a report with forward_to_server.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS forward_to_server boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS server_forward_status text,
    ADD COLUMN IF NOT EXISTS server_forwarded_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS server_resolution text,
    ADD COLUMN IF NOT EXISTS server_resolved_at timestamp with time zone;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_server_forward_status_check') THEN
        ALTER TABLE public.reports ADD CONSTRAINT reports_server_forward_status_check
            CHECK (server_forward_status IN ('queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_server_resolution_check') THEN
        ALTER TABLE public.reports ADD CONSTRAINT reports_server_resolution_check
            CHECK (server_resolution IN ('resolved', 'dismissed'));
    END IF;
END;
$$;

COMMENT ON COLUMN public.reports.forward_to_server IS
    'A report about a message in a server hosted elsewhere is also sent to that server''s moderators.';
COMMENT ON COLUMN public.reports.server_resolution IS
    'resolved (action taken) or dismissed, as the server''s moderators settled the forwarded report.';

CREATE UNIQUE INDEX IF NOT EXISTS reports_group_flag_key ON public.reports (ap_id)
    WHERE source = 'federation' AND metadata->>'flag_target' = 'group';

ALTER TABLE public.federated_instances
    ADD COLUMN IF NOT EXISTS reject_reports boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.federated_instances.reject_reports IS
    'Flags from the domain are ignored (Mastodon reject_reports).';

-- Reporters read their own forward choice and the server's outcome.
GRANT SELECT (forward_to_server, server_resolution, server_resolved_at) ON TABLE public.reports TO authenticated;

-- NOT VALID here, VALIDATE after COMMIT: the scan then holds SHARE UPDATE EXCLUSIVE, which lets
-- inbox writes through, instead of this transaction's ACCESS EXCLUSIVE.
ALTER TABLE public.ap_activities DROP CONSTRAINT IF EXISTS ap_activities_valid_type;
ALTER TABLE public.ap_activities ADD CONSTRAINT ap_activities_valid_type CHECK (ap_type IN (
    'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo',
    'Like', 'EmojiReaction', 'Announce', 'Add', 'Remove', 'Invite',
    'Join', 'Leave', 'Block', 'Flag', 'Move', 'Tombstone', 'QuoteRequest', 'Resolve',
    'VoiceJoin', 'VoiceLeave', 'VoiceUpdate',
    'harmony:VoiceCallInvite', 'harmony:VoiceCallAccept',
    'harmony:VoiceCallReject', 'harmony:VoiceCallEnd',
    'harmony:VoiceChannelJoin', 'harmony:VoiceChannelLeave',
    'harmony:VoiceChannelJoinAccept', 'harmony:VoiceChannelJoinReject',
    'harmony:VoiceMemberMove', 'harmony:VoiceMemberDisconnect', 'harmony:VoiceMemberState'
)) NOT VALID;

-- ---------------------------------------------------------------------------
-- Host of a copy
-- ---------------------------------------------------------------------------

-- Lower-case host of a server's Group: federation_domain, host_domain, else the ap_id authority.
CREATE OR REPLACE FUNCTION public.server_host_domain(p_server public.servers)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT lower(COALESCE(NULLIF(btrim(p_server.federation_domain), ''),
                          NULLIF(btrim(p_server.host_domain), ''),
                          substring(p_server.ap_id from '^https?://([^/?#]+)')));
$$;

REVOKE ALL ON FUNCTION public.server_host_domain(public.servers) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_host_domain(public.servers) TO service_role;

-- ---------------------------------------------------------------------------
-- Forwarding trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_queue_report_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.source = 'local'
       AND NEW.forward
       AND EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = NEW.reported_user_id AND NOT COALESCE(p.is_local, true)) THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-report',
            jsonb_build_object('type', 'create', 'report_id', NEW.id),
            10, 5, 7200
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    IF NEW.source = 'local' AND NEW.forward_to_server THEN
        NEW.server_forward_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-report',
            jsonb_build_object('type', 'create', 'target', 'server', 'report_id', NEW.id),
            10, 5, 7200
        );
    ELSE
        NEW.forward_to_server := false;
        NEW.server_forward_status := NULL;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_report_federation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client: create_report
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text);
DROP FUNCTION IF EXISTS public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean);

-- p_category defaults from p_reason. p_forward applies when the reported account is remote.
-- p_forward_to_server applies to a message in a server hosted elsewhere; NULL is true.
-- p_evidence_text is kept only for an encrypted message, as the reporter's plaintext.
-- Returns the new report, or the caller's open report on the same target.
CREATE FUNCTION public.create_report(
    p_report_type text,
    p_reported_user_id uuid DEFAULT NULL,
    p_reported_post_id uuid DEFAULT NULL,
    p_reported_message_id uuid DEFAULT NULL,
    p_reported_server_id uuid DEFAULT NULL,
    p_reason text DEFAULT 'other',
    p_category text DEFAULT NULL,
    p_comment text DEFAULT NULL,
    p_forward boolean DEFAULT false,
    p_evidence_text text DEFAULT NULL,
    p_forward_to_server boolean DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_caller_name text;
    v_target uuid := p_reported_user_id;
    v_target_local boolean;
    v_target_domain text;
    v_post_id uuid;
    v_message_id uuid;
    v_server_id uuid;
    v_author uuid;
    v_visibility text;
    v_content jsonb;
    v_channel uuid;
    v_conversation uuid;
    v_encrypted boolean := false;
    v_scope uuid;
    v_copy public.servers%ROWTYPE;
    v_to_server boolean := false;
    v_forward boolean;
    v_category text;
    v_snapshot jsonb;
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT p.username INTO v_caller_name
      FROM public.profiles p
     WHERE p.id = v_caller AND NOT COALESCE(p.is_suspended, false);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Suspended accounts cannot report' USING ERRCODE = '42501';
    END IF;

    v_category := COALESCE(p_category,
        CASE p_reason
            WHEN 'spam' THEN 'spam'
            WHEN 'illegal_content' THEN 'legal'
            WHEN 'harassment' THEN 'violation'
            WHEN 'impersonation' THEN 'violation'
            WHEN 'nsfw' THEN 'violation'
            ELSE 'other'
        END);
    IF v_category NOT IN ('spam', 'legal', 'violation', 'other') THEN
        RAISE EXCEPTION 'Invalid report category: %', v_category USING ERRCODE = '22023';
    END IF;

    IF p_report_type = 'post' THEN
        IF p_reported_post_id IS NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A post report names one post' USING ERRCODE = '22023';
        END IF;
        SELECT po.author_id, po.visibility, po.content
          INTO v_author, v_visibility, v_content
          FROM public.posts po
         WHERE po.id = p_reported_post_id
           AND NOT COALESCE(po.is_deleted, false);
        IF NOT FOUND OR (
            v_author <> v_caller
            AND NOT (
                v_visibility IN ('public', 'unlisted')
                OR (v_visibility = 'followers' AND EXISTS (
                        SELECT 1 FROM public.follows f
                         WHERE f.follower_id = v_caller AND f.following_id = v_author
                           AND f.status = 'accepted'))
                OR EXISTS (SELECT 1 FROM public.timeline_entries te
                            WHERE te.user_id = v_caller AND te.post_id = p_reported_post_id)
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_content) part
                            WHERE part->>'type' = 'mention'
                              AND (part->>'userId' = v_caller::text
                                   OR part->>'user_id' = v_caller::text
                                   OR lower(part->>'username') = lower(v_caller_name)))
            )
        ) THEN
            RAISE EXCEPTION 'Post not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target <> v_author THEN
            RAISE EXCEPTION 'Reported account is not the post author' USING ERRCODE = '22023';
        END IF;
        v_target := v_author;
        v_post_id := p_reported_post_id;

    ELSIF p_report_type = 'message' THEN
        IF p_reported_message_id IS NULL OR p_reported_post_id IS NOT NULL THEN
            RAISE EXCEPTION 'A message report names one message' USING ERRCODE = '22023';
        END IF;
        SELECT m.user_id, m.channel_id, m.conversation_id, COALESCE(m.encrypted, false)
          INTO v_author, v_channel, v_conversation, v_encrypted
          FROM public.messages m
         WHERE m.id = p_reported_message_id
           AND NOT COALESCE(m.is_deleted, false);
        IF NOT FOUND OR NOT (
            (v_channel IS NOT NULL AND public.can_view_channel(v_caller, v_channel))
            OR (v_conversation IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = v_conversation AND cp.user_id = v_caller))
        ) THEN
            RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target IS DISTINCT FROM v_author THEN
            RAISE EXCEPTION 'Reported account is not the message author' USING ERRCODE = '22023';
        END IF;
        v_target := v_author;
        v_message_id := p_reported_message_id;
        IF v_channel IS NOT NULL THEN
            SELECT s.id INTO v_scope
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_channel AND COALESCE(s.is_local_server, true);
            SELECT s.* INTO v_copy
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_channel AND s.is_local_server IS FALSE AND s.ap_id IS NOT NULL;
            v_to_server := v_copy.id IS NOT NULL AND COALESCE(p_forward_to_server, true);
        END IF;

    ELSIF p_report_type = 'user' THEN
        IF v_target IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A user report names one account' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_target) THEN
            RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002';
        END IF;

    ELSIF p_report_type = 'server' THEN
        IF p_reported_server_id IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A server report names one server' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_reported_server_id) THEN
            RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
        END IF;
        v_server_id := p_reported_server_id;
        v_target := NULL;

    ELSE
        RAISE EXCEPTION 'Invalid report type: %', p_report_type USING ERRCODE = '22023';
    END IF;

    IF v_target = v_caller THEN
        RAISE EXCEPTION 'Cannot report yourself' USING ERRCODE = '22023';
    END IF;

    SELECT r.id INTO v_id
      FROM public.reports r
     WHERE r.reporter_id = v_caller
       AND r.status IN ('pending', 'investigating')
       AND r.report_type = p_report_type
       AND r.reported_user_id IS NOT DISTINCT FROM v_target
       AND r.reported_post_id IS NOT DISTINCT FROM v_post_id
       AND r.reported_message_id IS NOT DISTINCT FROM v_message_id
       AND r.reported_server_id IS NOT DISTINCT FROM v_server_id
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    IF (SELECT count(*) FROM public.reports r
         WHERE r.reporter_id = v_caller AND r.created_at > now() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Report rate limit exceeded' USING ERRCODE = 'PT429';
    END IF;

    SELECT COALESCE(p.is_local, true), lower(p.domain) INTO v_target_local, v_target_domain
      FROM public.profiles p WHERE p.id = v_target;

    v_forward := COALESCE(p_forward, false) AND v_target_local IS FALSE
                 AND NOT (v_to_server AND v_target_domain IS NOT DISTINCT FROM public.server_host_domain(v_copy));

    v_snapshot := public.report_content_snapshot(
        v_target,
        CASE WHEN v_post_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_post_id] END,
        v_message_id,
        v_server_id);
    IF v_encrypted AND NULLIF(btrim(COALESCE(p_evidence_text, '')), '') IS NOT NULL THEN
        v_snapshot := jsonb_set(v_snapshot, '{message}',
            (v_snapshot->'message') || jsonb_build_object(
                'evidence_text', left(p_evidence_text, 4000),
                'evidence_source', 'reporter'));
    END IF;

    INSERT INTO public.reports (
        reporter_id, reported_user_id, reported_post_id, reported_message_id, reported_server_id,
        report_type, reason, category, comment, status, source, forward, content_snapshot,
        scope_server_id, forward_to_server)
    VALUES (
        v_caller, v_target, v_post_id, v_message_id, v_server_id,
        p_report_type, left(COALESCE(NULLIF(btrim(p_reason), ''), 'other'), 200), v_category,
        NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''), 'pending', 'local',
        v_forward, v_snapshot, v_scope, v_to_server)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Federation: create_federated_report (account Flags)
-- ---------------------------------------------------------------------------

-- One report per local account named by an inbound Flag. p_post_ids not authored by the
-- account, or not local, are dropped. Result status: created, duplicate, rate_limited,
-- blocked, ignored, not_local.
CREATE OR REPLACE FUNCTION public.create_federated_report(
    p_ap_id text,
    p_actor text,
    p_source_domain text,
    p_reported_user_id uuid,
    p_post_ids uuid[] DEFAULT '{}'::uuid[],
    p_comment text DEFAULT NULL,
    p_object_uris text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(COALESCE(p_source_domain, '')));
    v_posts uuid[];
    v_id uuid;
BEGIN
    IF p_ap_id IS NULL OR v_domain = '' OR p_reported_user_id IS NULL THEN
        RAISE EXCEPTION 'ap_id, source domain and account are required' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = v_domain AND fi.is_blocked) THEN
        RETURN jsonb_build_object('status', 'blocked');
    END IF;
    IF EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = v_domain AND fi.reject_reports) THEN
        RETURN jsonb_build_object('status', 'ignored');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = p_reported_user_id AND COALESCE(p.is_local, true)) THEN
        RETURN jsonb_build_object('status', 'not_local');
    END IF;

    SELECT r.id INTO v_id
      FROM public.reports r
     WHERE r.ap_id = p_ap_id AND r.reported_user_id = p_reported_user_id;
    IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'duplicate', 'report_id', v_id);
    END IF;

    IF (SELECT count(*) FROM public.reports r
         WHERE r.source = 'federation'
           AND r.source_instance = v_domain
           AND r.created_at > now() - interval '1 hour') >= 30 THEN
        RETURN jsonb_build_object('status', 'rate_limited');
    END IF;

    SELECT array_agg(po.id ORDER BY po.created_at) INTO v_posts
      FROM (SELECT po.id, po.created_at
              FROM public.posts po
             WHERE po.id = ANY (COALESCE(p_post_ids, '{}'::uuid[]))
               AND po.author_id = p_reported_user_id
               AND COALESCE(po.is_local, true)
             ORDER BY po.created_at
             LIMIT 20) po;

    INSERT INTO public.reports (
        reporter_id, reported_user_id, reported_post_id, report_type, reason, category, comment,
        status, source, source_instance, ap_id, metadata, forward, content_snapshot)
    VALUES (
        NULL, p_reported_user_id, v_posts[1],
        CASE WHEN v_posts IS NULL THEN 'user' ELSE 'post' END,
        'other', 'other', NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''),
        'pending', 'federation', v_domain, p_ap_id,
        jsonb_build_object('actor', p_actor,
                           'object_uris', to_jsonb(COALESCE(p_object_uris[1:50], '{}'::text[]))),
        false,
        public.report_content_snapshot(p_reported_user_id, COALESCE(v_posts, '{}'::uuid[]), NULL, NULL))
    ON CONFLICT (ap_id, reported_user_id) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT r.id INTO v_id
          FROM public.reports r
         WHERE r.ap_id = p_ap_id AND r.reported_user_id = p_reported_user_id;
        RETURN jsonb_build_object('status', 'duplicate', 'report_id', v_id);
    END IF;

    RETURN jsonb_build_object('status', 'created', 'report_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_federated_report(text, text, text, uuid, uuid[], text, text[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_federated_report(text, text, text, uuid, uuid[], text, text[])
    TO service_role;

-- ---------------------------------------------------------------------------
-- Federation: create_federated_server_report (Flags at a Group inbox)
-- ---------------------------------------------------------------------------

-- One report per Flag naming a message of p_server_id, a local server. The report is scoped to
-- the server and names the message's author; the sending instance's reporter stays unknown.
-- p_reason is a create_report reason; anything else is 'other'. Result status: created,
-- duplicate, rate_limited, blocked, ignored, not_local, not_found.
CREATE OR REPLACE FUNCTION public.create_federated_server_report(
    p_ap_id text,
    p_actor text,
    p_source_domain text,
    p_server_id uuid,
    p_message_id uuid,
    p_comment text DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_object_uris text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(COALESCE(p_source_domain, '')));
    v_reason text := CASE WHEN p_reason IN ('spam', 'harassment', 'illegal_content', 'impersonation', 'nsfw', 'other')
                          THEN p_reason ELSE 'other' END;
    v_author uuid;
    v_id uuid;
BEGIN
    IF p_ap_id IS NULL OR v_domain = '' OR p_server_id IS NULL OR p_message_id IS NULL THEN
        RAISE EXCEPTION 'ap_id, source domain, server and message are required' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = v_domain AND fi.is_blocked) THEN
        RETURN jsonb_build_object('status', 'blocked');
    END IF;
    IF EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = v_domain AND fi.reject_reports) THEN
        RETURN jsonb_build_object('status', 'ignored');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND COALESCE(s.is_local_server, true)) THEN
        RETURN jsonb_build_object('status', 'not_local');
    END IF;

    SELECT m.user_id INTO v_author
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
     WHERE m.id = p_message_id
       AND c.server_id = p_server_id
       AND NOT COALESCE(m.is_deleted, false);
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'not_found');
    END IF;

    SELECT r.id INTO v_id
      FROM public.reports r
     WHERE r.ap_id = p_ap_id AND r.source = 'federation' AND r.metadata->>'flag_target' = 'group';
    IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'duplicate', 'report_id', v_id);
    END IF;

    IF (SELECT count(*) FROM public.reports r
         WHERE r.source = 'federation'
           AND r.source_instance = v_domain
           AND r.created_at > now() - interval '1 hour') >= 30 THEN
        RETURN jsonb_build_object('status', 'rate_limited');
    END IF;

    INSERT INTO public.reports (
        reporter_id, reported_user_id, reported_message_id, report_type, reason, category, comment,
        status, source, source_instance, ap_id, metadata, forward, content_snapshot, scope_server_id)
    VALUES (
        NULL, v_author, p_message_id, 'message', v_reason,
        CASE v_reason
            WHEN 'spam' THEN 'spam'
            WHEN 'illegal_content' THEN 'legal'
            WHEN 'harassment' THEN 'violation'
            WHEN 'impersonation' THEN 'violation'
            WHEN 'nsfw' THEN 'violation'
            ELSE 'other'
        END,
        NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''),
        'pending', 'federation', v_domain, p_ap_id,
        jsonb_build_object('actor', p_actor,
                           'flag_target', 'group',
                           'object_uris', to_jsonb(COALESCE(p_object_uris[1:50], '{}'::text[]))),
        false,
        public.report_content_snapshot(v_author, '{}'::uuid[], p_message_id, NULL),
        p_server_id)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT r.id INTO v_id
          FROM public.reports r
         WHERE r.ap_id = p_ap_id AND r.source = 'federation' AND r.metadata->>'flag_target' = 'group';
        RETURN jsonb_build_object('status', 'duplicate', 'report_id', v_id);
    END IF;

    RETURN jsonb_build_object('status', 'created', 'report_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_federated_server_report(text, text, text, uuid, uuid, text, text, text[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_federated_server_report(text, text, text, uuid, uuid, text, text, text[])
    TO service_role;

-- ---------------------------------------------------------------------------
-- Host: the Group's Resolve when a forwarded report is settled
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_queue_report_resolution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.status IN ('resolved', 'dismissed')
       AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.source = 'federation'
       AND NEW.scope_server_id IS NOT NULL
       AND NEW.metadata->>'flag_target' = 'group' THEN
        PERFORM public.queue_federation_job(
            'federate-report',
            jsonb_build_object('type', 'update', 'target', 'resolution', 'report_id', NEW.id),
            10, 5, 7200
        );
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_report_resolution() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_federate_report_resolution ON public.reports;
CREATE TRIGGER trigger_federate_report_resolution
    AFTER UPDATE OF status ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_report_resolution();

-- The maintenance switches name every trigger that queues federation work.
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report_resolution;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers ENABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation ENABLE TRIGGER z_server_voice_moderation_federate;
    ALTER TABLE public.federation_member_removals ENABLE TRIGGER trigger_federate_member_removal;
    RAISE NOTICE 'All federation triggers enabled';
END;
$$;

REVOKE ALL ON FUNCTION public.enable_federation_triggers() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report_resolution;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers DISABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation DISABLE TRIGGER z_server_voice_moderation_federate;
    ALTER TABLE public.federation_member_removals DISABLE TRIGGER trigger_federate_member_removal;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reporting instance: the server's resolution
-- ---------------------------------------------------------------------------

-- The Resolve of p_group for a report this instance forwarded to it. p_group must be the
-- ap_id of the server holding the reported message. An open report takes p_outcome as its
-- status, with resolved_by NULL, and its reporter is notified. Result status: applied,
-- not_forwarded, wrong_group.
CREATE OR REPLACE FUNCTION public.apply_server_report_resolution(
    p_report_id uuid,
    p_group text,
    p_outcome text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r public.reports%ROWTYPE;
    v_server public.servers%ROWTYPE;
    v_server_id uuid;
    v_open boolean;
    v_status text;
BEGIN
    IF p_outcome NOT IN ('resolved', 'dismissed') THEN
        RAISE EXCEPTION 'Invalid outcome: %', p_outcome USING ERRCODE = '22023';
    END IF;

    SELECT * INTO r FROM public.reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND OR r.source <> 'local' OR NOT r.forward_to_server THEN
        RETURN jsonb_build_object('status', 'not_forwarded');
    END IF;

    SELECT c.server_id INTO v_server_id
      FROM public.messages m JOIN public.channels c ON c.id = m.channel_id
     WHERE m.id = r.reported_message_id;
    IF v_server_id IS NULL
       AND r.content_snapshot->'message'->>'server_id'
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_server_id := (r.content_snapshot->'message'->>'server_id')::uuid;
    END IF;
    SELECT * INTO v_server FROM public.servers s WHERE s.id = v_server_id;
    IF v_server.id IS NULL OR v_server.is_local_server IS NOT FALSE
       OR rtrim(v_server.ap_id, '/') IS DISTINCT FROM rtrim(p_group, '/') THEN
        RETURN jsonb_build_object('status', 'wrong_group');
    END IF;

    -- The server's outcome is information for local staff and the reporter; the local report's
    -- status stays with local staff (another instance's moderators cannot close it).
    v_open := r.server_resolution IS NULL;
    v_status := r.status;

    UPDATE public.reports
       SET server_resolution = p_outcome,
           server_resolved_at = now(),
           updated_at = now()
     WHERE id = r.id;

    IF v_open AND r.reporter_id IS NOT NULL THEN
        PERFORM public.send_notification_to_user(
            'report_update', r.reporter_id,
            jsonb_build_object(
                'report_id', r.id,
                'status', p_outcome,
                'report_type', r.report_type,
                'category', r.category,
                'resolved_by_server', v_server.name,
                'server_host', public.server_host_domain(v_server),
                'show_resolver', false),
            NULL, NULL, NULL, NULL, 'normal');
    END IF;

    RETURN jsonb_build_object('status', 'applied', 'report_status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_server_report_resolution(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_server_report_resolution(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Domains: ignore reports
-- ---------------------------------------------------------------------------

-- Instance admins only, as set_domain_moderation.
CREATE OR REPLACE FUNCTION public.set_domain_reject_reports(
    p_domain text,
    p_reject boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_domain text := lower(btrim(COALESCE(p_domain, '')));
BEGIN
    IF v_caller IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Permission denied: instance admin required' USING ERRCODE = '42501';
    END IF;
    IF v_domain = '' OR v_domain !~ '^[a-z0-9.:-]+$' THEN
        RAISE EXCEPTION 'Invalid domain' USING ERRCODE = '22023';
    END IF;
    IF p_reject IS NULL THEN
        RAISE EXCEPTION 'p_reject is required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.federated_instances (domain) VALUES (v_domain)
    ON CONFLICT (domain) DO NOTHING;

    UPDATE public.federated_instances
       SET reject_reports = p_reject,
           updated_at = now()
     WHERE domain = v_domain;

    PERFORM public.log_admin_action(
        v_caller, CASE WHEN p_reject THEN 'domain_reject_reports' ELSE 'domain_accept_reports' END,
        'domain', v_domain, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.set_domain_reject_reports(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_domain_reject_reports(text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Moderator queue
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_reports_with_details(text, integer, integer, uuid);

-- Instance admins and moderators list every report, or one server's with p_server_id. A server
-- moderator lists only the reports of p_server_id it moderates and receives no reporter identity.
-- server_forward: {server_id, server_name, host, status, forwarded_at, resolution, resolved_at}
-- for a report also sent to the moderators of a server hosted elsewhere, else NULL.
CREATE FUNCTION public.get_reports_with_details(
    p_status text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_server_id uuid DEFAULT NULL
)
RETURNS TABLE(
    id uuid,
    created_at timestamptz,
    updated_at timestamptz,
    status text,
    report_type text,
    category text,
    reason text,
    comment text,
    source text,
    source_instance text,
    source_actor text,
    reporter_id uuid,
    reporter_username text,
    reporter_display_name text,
    reporter_avatar_url text,
    reporter_domain text,
    reporter_is_local boolean,
    reported_user_id uuid,
    reported_user_username text,
    reported_user_display_name text,
    reported_user_avatar_url text,
    reported_user_domain text,
    reported_user_is_local boolean,
    reported_user_is_suspended boolean,
    reported_user_is_silenced boolean,
    reported_domain_blocked boolean,
    reported_domain_limited boolean,
    reported_post_id uuid,
    reported_message_id uuid,
    reported_server_id uuid,
    scope_server_id uuid,
    reported_post_preview text,
    reported_post_ap_id text,
    reported_post_url text,
    reported_post_is_sensitive boolean,
    reported_post_content_warning text,
    reported_post_is_deleted boolean,
    reported_message_preview text,
    reported_message_is_deleted boolean,
    content_snapshot jsonb,
    forward boolean,
    forwarded_at timestamptz,
    federation_status text,
    server_forward jsonb,
    assigned_to uuid,
    assigned_username text,
    resolved_at timestamptz,
    resolver_username text,
    resolution_note text,
    open_reports_on_target bigint,
    total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_instance boolean := public.is_current_user_admin_or_mod();
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;
    IF NOT v_instance AND (p_server_id IS NULL
                           OR NOT public.can_current_user_moderate_server_reports(p_server_id)) THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        r.id,
        r.created_at,
        r.updated_at,
        r.status,
        r.report_type,
        r.category,
        r.reason,
        r.comment,
        r.source,
        r.source_instance,
        (r.metadata->>'actor')::text,
        CASE WHEN v_instance THEN r.reporter_id END,
        CASE WHEN v_instance THEN reporter.username::text END,
        CASE WHEN v_instance THEN reporter.display_name::text END,
        CASE WHEN v_instance THEN reporter.avatar_url::text END,
        CASE WHEN v_instance THEN reporter.domain::text END,
        CASE WHEN v_instance THEN COALESCE(reporter.is_local, r.source = 'local') END,
        r.reported_user_id,
        COALESCE(ru.username, r.content_snapshot->'account'->>'username')::text,
        COALESCE(ru.display_name, r.content_snapshot->'account'->>'display_name')::text,
        COALESCE(ru.avatar_url, r.content_snapshot->'account'->>'avatar_url')::text,
        COALESCE(ru.domain, r.content_snapshot->'account'->>'domain')::text,
        COALESCE(ru.is_local, (r.content_snapshot->'account'->>'is_local')::boolean, true),
        COALESCE(ru.is_suspended, false),
        COALESCE(ru.is_silenced, false),
        COALESCE(fi.is_blocked, false),
        fi.limited_at IS NOT NULL,
        r.reported_post_id,
        r.reported_message_id,
        r.reported_server_id,
        r.scope_server_id,
        CASE WHEN po.id IS NOT NULL THEN
            LEFT(COALESCE((
                SELECT string_agg(
                    CASE
                        WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                        WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                        WHEN part->>'type' = 'mention' THEN '@' || COALESCE(part->>'username', 'user')
                        WHEN part->>'type' = 'hashtag' THEN '#' || COALESCE(part->>'name', 'tag')
                        WHEN part->>'type' = 'emoji' THEN ':' || COALESCE(part->'emoji'->>'name', 'emoji') || ':'
                        ELSE ''
                    END, ' ')
                  FROM jsonb_array_elements(po.content) AS part), '[Post content unavailable]'), 500)
        END::text,
        po.ap_id::text,
        po.url::text,
        po.is_sensitive,
        po.content_warning::text,
        CASE WHEN r.reported_post_id IS NOT NULL OR r.report_type = 'post'
             THEN COALESCE(po.is_deleted, true) END,
        CASE WHEN m.id IS NOT NULL THEN
            LEFT(COALESCE((
                SELECT string_agg(
                    CASE
                        WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                        WHEN part->>'type' = 'file' THEN '[' || COALESCE(part->>'fileType', 'file') || ': ' || COALESCE(part->>'filename', part->>'url', 'attachment') || ']'
                        WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                        WHEN part->>'type' = 'emoji' THEN COALESCE(part->'emoji'->>'name', ':emoji:')
                        WHEN part->>'type' = 'mention' THEN COALESCE(part->>'mention', '@user')
                        ELSE '[' || COALESCE(part->>'type', 'unknown') || ']'
                    END, ' ')
                  FROM jsonb_array_elements(m.content) AS part), '[Message content unavailable]'), 300)
        END::text,
        CASE WHEN r.reported_message_id IS NOT NULL OR r.report_type = 'message'
             THEN COALESCE(m.is_deleted, true) END,
        r.content_snapshot,
        r.forward,
        r.forwarded_at,
        r.federation_status,
        CASE WHEN r.forward_to_server THEN jsonb_build_object(
            'server_id', fs.id,
            'server_name', COALESCE(fs.name, r.content_snapshot->'server'->>'name'),
            'host', public.server_host_domain(fs),
            'status', r.server_forward_status,
            'forwarded_at', r.server_forwarded_at,
            'resolution', r.server_resolution,
            'resolved_at', r.server_resolved_at) END,
        CASE WHEN v_instance THEN r.assigned_to END,
        CASE WHEN v_instance THEN assignee.username::text END,
        r.resolved_at,
        CASE WHEN v_instance THEN resolver.username::text END,
        r.resolution_note,
        (SELECT count(*) FROM public.reports o
          WHERE r.reported_user_id IS NOT NULL
            AND o.reported_user_id = r.reported_user_id
            AND o.status IN ('pending', 'investigating')),
        count(*) OVER ()
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
    LEFT JOIN public.profiles ru ON ru.id = r.reported_user_id
    LEFT JOIN public.profiles assignee ON assignee.id = r.assigned_to
    LEFT JOIN public.profiles resolver ON resolver.id = r.resolved_by
    LEFT JOIN public.posts po ON po.id = r.reported_post_id
    LEFT JOIN public.messages m ON m.id = r.reported_message_id
    LEFT JOIN public.channels mc ON mc.id = m.channel_id
    LEFT JOIN public.servers fs
           ON r.forward_to_server
          AND fs.id = COALESCE(mc.server_id,
                               CASE WHEN r.content_snapshot->'message'->>'server_id'
                                         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN (r.content_snapshot->'message'->>'server_id')::uuid END)
    LEFT JOIN public.federated_instances fi
           ON NOT COALESCE(ru.is_local, true) AND fi.domain = lower(ru.domain)
    WHERE (p_status IS NULL OR r.status = p_status)
      AND (p_server_id IS NULL OR r.scope_server_id = p_server_id)
      AND (v_instance OR public.can_current_user_moderate_report(r))
    ORDER BY r.created_at DESC, r.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_reports_with_details(text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reports_with_details(text, integer, integer, uuid) TO authenticated, service_role;

-- Owners of SECURITY DEFINER callers keep EXECUTE on the internal helper.
DO $$
DECLARE
    grantee text;
BEGIN
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.server_host_domain(public.servers) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

COMMIT;

ALTER TABLE public.ap_activities VALIDATE CONSTRAINT ap_activities_valid_type;

NOTIFY pgrst, 'reload schema';
