-- Reports: local and federated reporting brought to Mastodon/Misskey parity.
--
-- Writes. Clients inserted reports under a policy that checked reporter_id alone, so a row could
-- carry any status, source, source_instance or resolved_by. create_report is the only client
-- write: it checks the target against what the caller can see, derives the reported account,
-- returns the caller's open report on the same target instead of a second row, limits each
-- reporter to 20 reports an hour and stores a snapshot built from the database. Moderators write
-- through moderate_report, which logs to admin_audit_log and notifies the reporter. The INSERT
-- and UPDATE policies are dropped. The UPDATE policy admitted admins only, so a moderator's
-- resolve changed no row while notify_report_update still told the reporter it had;
-- notify_report_update is dropped.
--
-- Columns. Reporters read their own rows through a column grant that omits resolved_by,
-- assigned_to, resolution_note, metadata, source_instance and content_snapshot.
--
-- Snapshot. Previews were joined live: an edit, the '[deleted]' overwrite of a deleted message,
-- or ON DELETE SET NULL removed the evidence, and reported_user_id ON DELETE CASCADE deleted the
-- report with the account. content_snapshot keeps the account, posts, message and server as
-- reported; reported_user_id is ON DELETE SET NULL. An encrypted message stores ciphertext, so
-- the reporter's plaintext is kept as message.evidence_text with evidence_source 'reporter'.
-- Existing rows are snapshotted from current content with backfilled = true.
--
-- Categories. category is Mastodon's set: spam, legal, violation, other. reason keeps the client
-- label (harassment, impersonation, nsfw, ...).
--
-- Forwarding. Every report about a remote account was federated as a Flag whose actor was the
-- reporter, naming them to the remote instance. A report is now forwarded only when the reporter
-- or a moderator sets forward, and the backend signs the Flag as the instance actor, whose key
-- is instance_actor_keys. The queued job carries the report id alone.
--
-- Inbound. Flags were stored against a profile created for the remote actor, with the Flag text
-- in reason (200 characters) and one row per object. create_federated_report attributes the
-- report to the source domain (reporter_id NULL, metadata.actor), keeps statuses of the target
-- account only, deduplicates on (ap_id, reported_user_id) and accepts 30 reports an hour per
-- domain. Production's reports_ap_id_key UNIQUE (ap_id) rejects the second target of a Flag and
-- is replaced. Existing federated rows are converted to that shape.
--
-- Scope. A report about a message in a channel of a local server carries scope_server_id. The
-- owner and accepted members with MANAGE_MESSAGES there list and settle those reports, without
-- the reporter's identity.
--
-- Account actions. prevent_profile_moderation_self_update admits instance admins only, so
-- silence, suspend and force-sensitive stay admin actions; moderators resolve, dismiss, assign,
-- forward, delete content and warn.
--
-- Domain limit. federated_instances.limited_at marks a limited domain. As in Mastodon's
-- DomainBlockWorker and UnblockDomainService, limiting silences the domain's accounts with
-- silenced_at = limited_at, an account created from the domain later is silenced on insert,
-- and lifting the limit unsilences the rows carrying that timestamp. Suspension is the existing
-- federated_instances.is_blocked.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS forward boolean,
    ADD COLUMN IF NOT EXISTS forwarded_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS content_snapshot jsonb,
    ADD COLUMN IF NOT EXISTS assigned_to uuid,
    ADD COLUMN IF NOT EXISTS scope_server_id uuid;

UPDATE public.reports
   SET category = CASE reason
                      WHEN 'spam' THEN 'spam'
                      WHEN 'illegal_content' THEN 'legal'
                      WHEN 'harassment' THEN 'violation'
                      WHEN 'impersonation' THEN 'violation'
                      WHEN 'nsfw' THEN 'violation'
                      ELSE 'other'
                  END
 WHERE category IS NULL;
UPDATE public.reports SET forward = false WHERE forward IS NULL;
UPDATE public.reports SET created_at = COALESCE(updated_at, now()) WHERE created_at IS NULL;

ALTER TABLE public.reports
    ALTER COLUMN category SET DEFAULT 'other',
    ALTER COLUMN category SET NOT NULL,
    ALTER COLUMN forward SET DEFAULT false,
    ALTER COLUMN forward SET NOT NULL,
    ALTER COLUMN content_snapshot SET DEFAULT '{}'::jsonb,
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN report_type SET DEFAULT 'user';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_category_check') THEN
        RAISE NOTICE 'reports_category_check present, skipped';
    ELSE
        ALTER TABLE public.reports ADD CONSTRAINT reports_category_check
            CHECK (category IN ('spam', 'legal', 'violation', 'other'));
        RAISE NOTICE 'reports_category_check added';
    END IF;
END;
$$;

-- reported_user_id: ON DELETE CASCADE -> SET NULL. assigned_to and scope_server_id are new.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.reports'::regclass
                  AND conname = 'reports_reported_user_id_fkey'
                  AND confdeltype = 'n') THEN
        RAISE NOTICE 'reports_reported_user_id_fkey already SET NULL, skipped';
    ELSE
        ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_reported_user_id_fkey;
        ALTER TABLE public.reports ADD CONSTRAINT reports_reported_user_id_fkey
            FOREIGN KEY (reported_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
        RAISE NOTICE 'reports_reported_user_id_fkey now ON DELETE SET NULL';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_assigned_to_fkey') THEN
        ALTER TABLE public.reports ADD CONSTRAINT reports_assigned_to_fkey
            FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;
        RAISE NOTICE 'reports_assigned_to_fkey added';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_scope_server_id_fkey') THEN
        ALTER TABLE public.reports ADD CONSTRAINT reports_scope_server_id_fkey
            FOREIGN KEY (scope_server_id) REFERENCES public.servers(id) ON DELETE SET NULL;
        RAISE NOTICE 'reports_scope_server_id_fkey added';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Existing federated rows: Flag text out of reason, remote actor profile out of reporter_id
-- ---------------------------------------------------------------------------

UPDATE public.reports
   SET comment = reason,
       reason = 'other'
 WHERE source = 'federation'
   AND comment IS NULL
   AND reason NOT IN ('spam', 'harassment', 'illegal_content', 'impersonation', 'nsfw', 'other');

UPDATE public.reports r
   SET metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object('actor', p.federated_id),
       source_instance = COALESCE(r.source_instance, p.domain),
       reporter_id = NULL
  FROM public.profiles p
 WHERE r.source = 'federation'
   AND p.id = r.reporter_id
   AND NOT COALESCE(p.is_local, true);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_ap_id_key;
DROP INDEX IF EXISTS public.idx_reports_ap_id;

-- One Flag naming an account and its post produced two rows with the same (ap_id, account).
-- The later rows keep their content under a distinct ap_id.
DO $$
DECLARE
    v_renamed integer;
BEGIN
    WITH ranked AS (
        SELECT id, row_number() OVER (PARTITION BY ap_id, reported_user_id ORDER BY created_at, id) AS n
          FROM public.reports
         WHERE ap_id IS NOT NULL
    )
    UPDATE public.reports r
       SET ap_id = r.ap_id || '#duplicate-' || r.id
      FROM ranked
     WHERE ranked.id = r.id AND ranked.n > 1;
    GET DIAGNOSTICS v_renamed = ROW_COUNT;
    RAISE NOTICE 'reports: % duplicate (ap_id, reported_user_id) rows renamed', v_renamed;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS reports_ap_id_target_key ON public.reports (ap_id, reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON public.reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON public.reports (reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_source_instance_created ON public.reports (source_instance, created_at DESC)
    WHERE source = 'federation';
CREATE INDEX IF NOT EXISTS idx_reports_assigned_to ON public.reports (assigned_to);
CREATE INDEX IF NOT EXISTS idx_reports_scope_server_id ON public.reports (scope_server_id);

-- ---------------------------------------------------------------------------
-- Domain limit
-- ---------------------------------------------------------------------------

ALTER TABLE public.federated_instances ADD COLUMN IF NOT EXISTS limited_at timestamp with time zone;

COMMENT ON COLUMN public.federated_instances.limited_at IS
    'Set while the domain is limited; its accounts silenced by the limit carry this silenced_at.';

-- Remote accounts from a limited domain are created silenced. Remote profiles are inserted by
-- the service role, which a_clamp_profile_moderation_on_insert_trigger leaves unclamped.
CREATE OR REPLACE FUNCTION public.apply_domain_limit_on_profile_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limited_at timestamp with time zone;
BEGIN
    IF COALESCE(NEW.is_local, true) OR NEW.domain IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT fi.limited_at INTO v_limited_at
      FROM public.federated_instances fi
     WHERE fi.domain = lower(NEW.domain);

    IF v_limited_at IS NOT NULL AND NOT COALESCE(NEW.is_silenced, false) THEN
        NEW.is_silenced := true;
        NEW.silenced_at := v_limited_at;
        NEW.silenced_reason := 'Domain limited';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_domain_limit_on_profile_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS apply_domain_limit_on_profile_insert_trigger ON public.profiles;
CREATE TRIGGER apply_domain_limit_on_profile_insert_trigger
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.apply_domain_limit_on_profile_insert();

-- Domain policy: 'suspend' blocks, 'limit' limits and unblocks, 'none' lifts both.
-- Instance admins only. Mirrors Mastodon's domain block severities (suspend, silence, noop).
CREATE OR REPLACE FUNCTION public.set_domain_moderation(
    p_domain text,
    p_policy text,
    p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_domain text := lower(btrim(COALESCE(p_domain, '')));
    v_limited_at timestamp with time zone;
    v_at timestamp with time zone := now();
    v_count integer := 0;
BEGIN
    IF v_caller IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Permission denied: instance admin required' USING ERRCODE = '42501';
    END IF;
    IF v_domain = '' OR v_domain !~ '^[a-z0-9.:-]+$' THEN
        RAISE EXCEPTION 'Invalid domain' USING ERRCODE = '22023';
    END IF;
    IF p_policy NOT IN ('none', 'limit', 'suspend') THEN
        RAISE EXCEPTION 'Invalid domain policy: %', p_policy USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.federated_instances (domain) VALUES (v_domain)
    ON CONFLICT (domain) DO NOTHING;

    SELECT fi.limited_at INTO v_limited_at
      FROM public.federated_instances fi
     WHERE fi.domain = v_domain
       FOR UPDATE;

    IF p_policy = 'suspend' THEN
        UPDATE public.federated_instances
           SET is_blocked = true,
               updated_at = v_at,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'blocked_reason', COALESCE(p_reason, 'Moderation'),
                   'blocked_by', v_caller,
                   'blocked_at', v_at)
         WHERE domain = v_domain;
    ELSE
        UPDATE public.federated_instances
           SET is_blocked = false,
               updated_at = v_at
         WHERE domain = v_domain;
    END IF;

    IF p_policy = 'limit' AND v_limited_at IS NULL THEN
        UPDATE public.federated_instances
           SET limited_at = v_at,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'limit_reason', COALESCE(p_reason, 'Moderation'),
                   'limited_by', v_caller)
         WHERE domain = v_domain;
        UPDATE public.profiles
           SET is_silenced = true,
               silenced_at = v_at,
               silenced_reason = 'Domain limited'
         WHERE NOT COALESCE(is_local, true)
           AND lower(domain) = v_domain
           AND NOT COALESCE(is_silenced, false);
        GET DIAGNOSTICS v_count = ROW_COUNT;
    ELSIF p_policy = 'none' AND v_limited_at IS NOT NULL THEN
        UPDATE public.profiles
           SET is_silenced = false,
               silenced_at = NULL,
               silenced_reason = NULL
         WHERE NOT COALESCE(is_local, true)
           AND lower(domain) = v_domain
           AND silenced_at = v_limited_at;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        UPDATE public.federated_instances SET limited_at = NULL WHERE domain = v_domain;
    END IF;

    PERFORM public.log_admin_action(
        v_caller, 'domain_' || p_policy, 'domain', v_domain,
        jsonb_build_object('reason', p_reason, 'accounts_changed', v_count));
END;
$$;

REVOKE ALL ON FUNCTION public.set_domain_moderation(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_domain_moderation(text, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Instance actor key
-- ---------------------------------------------------------------------------

-- One row. The federation backend generates the pair on first use and signs forwarded Flags with
-- it as https://<domain>/users/instance.actor (Misskey's instance actor name; usernames cannot
-- contain '.', so no account collides).
CREATE TABLE IF NOT EXISTS public.instance_actor_keys (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.instance_actor_keys IS 'Instance actor key pair - accessible only via service_role';

ALTER TABLE public.instance_actor_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instance_actor_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.instance_actor_keys TO service_role;

DROP POLICY IF EXISTS "Service role manages the instance actor key" ON public.instance_actor_keys;
CREATE POLICY "Service role manages the instance actor key" ON public.instance_actor_keys
    AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Snapshot
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_content_snapshot(
    p_user_id uuid,
    p_post_ids uuid[],
    p_message_id uuid,
    p_server_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'taken_at', now(),
        'account', (
            SELECT jsonb_build_object(
                'id', p.id, 'username', p.username, 'display_name', p.display_name,
                'domain', p.domain, 'is_local', p.is_local, 'federated_id', p.federated_id,
                'avatar_url', p.avatar_url, 'bio', p.bio)
              FROM public.profiles p
             WHERE p.id = p_user_id),
        'posts', (
            SELECT jsonb_agg(jsonb_build_object(
                'id', po.id, 'ap_id', po.ap_id, 'url', po.url, 'author_id', po.author_id,
                'content', po.content, 'content_warning', po.content_warning,
                'is_sensitive', po.is_sensitive, 'visibility', po.visibility,
                'media_attachments', po.media_attachments, 'is_local', po.is_local,
                'is_deleted', po.is_deleted, 'created_at', po.created_at,
                'updated_at', po.updated_at) ORDER BY po.created_at)
              FROM public.posts po
             WHERE po.id = ANY (COALESCE(p_post_ids, '{}'::uuid[]))),
        'message', (
            SELECT jsonb_build_object(
                'id', m.id, 'user_id', m.user_id, 'bot_id', m.bot_id, 'channel_id', m.channel_id,
                'server_id', c.server_id, 'conversation_id', m.conversation_id,
                'content', m.content, 'encrypted', m.encrypted, 'is_deleted', m.is_deleted,
                'created_at', m.created_at, 'updated_at', m.updated_at)
              FROM public.messages m
              LEFT JOIN public.channels c ON c.id = m.channel_id
             WHERE m.id = p_message_id),
        'server', (
            SELECT jsonb_build_object(
                'id', s.id, 'name', s.name, 'description', s.description, 'owner', s.owner)
              FROM public.servers s
             WHERE s.id = p_server_id)
    ));
$$;

REVOKE ALL ON FUNCTION public.report_content_snapshot(uuid, uuid[], uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_content_snapshot(uuid, uuid[], uuid, uuid) TO service_role;

UPDATE public.reports r
   SET content_snapshot = public.report_content_snapshot(
           r.reported_user_id,
           CASE WHEN r.reported_post_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[r.reported_post_id] END,
           r.reported_message_id,
           r.reported_server_id) || '{"backfilled": true}'::jsonb
 WHERE r.content_snapshot IS NULL OR r.content_snapshot = '{}'::jsonb;

ALTER TABLE public.reports ALTER COLUMN content_snapshot SET NOT NULL;

UPDATE public.reports r
   SET scope_server_id = c.server_id
  FROM public.messages m
  JOIN public.channels c ON c.id = m.channel_id
  JOIN public.servers s ON s.id = c.server_id
 WHERE r.reported_message_id = m.id
   AND r.scope_server_id IS NULL
   AND COALESCE(s.is_local_server, true);

-- ---------------------------------------------------------------------------
-- Server-scoped moderation
-- ---------------------------------------------------------------------------

-- The server's owner, or an accepted member holding MANAGE_MESSAGES (ADMINISTRATOR implies it).
CREATE OR REPLACE FUNCTION public.can_current_user_moderate_server_reports(p_server_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL OR p_server_id IS NULL THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_caller) THEN
        RETURN true;
    END IF;
    RETURN EXISTS (
            SELECT 1 FROM public.user_servers us
             WHERE us.server_id = p_server_id
               AND us.user_id = v_caller
               AND us.status = 'accepted')
       AND public.has_permission(v_caller, p_server_id, 'MANAGE_MESSAGES');
END;
$$;

-- Evaluated as the querying role inside the reports SELECT policy.
REVOKE ALL ON FUNCTION public.can_current_user_moderate_server_reports(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_current_user_moderate_server_reports(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privileges and policies
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE public.reports FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, created_at, updated_at, reporter_id, reported_user_id, reported_post_id,
              reported_message_id, reported_server_id, reason, category, comment, report_type,
              status, resolved_at, forward, forwarded_at)
    ON TABLE public.reports TO authenticated;
GRANT ALL ON TABLE public.reports TO service_role;

DO $$
DECLARE
    v_policy text;
BEGIN
    FOR v_policy IN
        SELECT polname FROM pg_policy
         WHERE polrelid = 'public.reports'::regclass
           AND polname NOT IN ('Users can view own reports', 'Moderators can view reports they moderate')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.reports', v_policy);
        RAISE NOTICE 'drop   public.reports %', quote_ident(v_policy);
    END LOOP;
END;
$$;

DROP POLICY IF EXISTS "Users can view own reports" ON public.reports;
CREATE POLICY "Users can view own reports" ON public.reports
    FOR SELECT TO authenticated
    USING (reporter_id = ( SELECT public.get_current_profile_id() ));

DROP POLICY IF EXISTS "Moderators can view reports they moderate" ON public.reports;
CREATE POLICY "Moderators can view reports they moderate" ON public.reports
    FOR SELECT TO authenticated
    USING (
        ( SELECT public.is_current_user_admin_or_mod() )
        OR (scope_server_id IS NOT NULL
            AND public.can_current_user_moderate_server_reports(scope_server_id))
    );

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

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
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_report_federation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client: create_report
-- ---------------------------------------------------------------------------

-- p_category defaults from p_reason. p_forward applies when the reported account is remote.
-- p_evidence_text is kept only for an encrypted message, as the reporter's plaintext.
-- Returns the new report, or the caller's open report on the same target.
CREATE OR REPLACE FUNCTION public.create_report(
    p_report_type text,
    p_reported_user_id uuid DEFAULT NULL,
    p_reported_post_id uuid DEFAULT NULL,
    p_reported_message_id uuid DEFAULT NULL,
    p_reported_server_id uuid DEFAULT NULL,
    p_reason text DEFAULT 'other',
    p_category text DEFAULT NULL,
    p_comment text DEFAULT NULL,
    p_forward boolean DEFAULT false,
    p_evidence_text text DEFAULT NULL
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

    SELECT COALESCE(p.is_local, true) INTO v_target_local FROM public.profiles p WHERE p.id = v_target;

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
        scope_server_id)
    VALUES (
        v_caller, v_target, v_post_id, v_message_id, v_server_id,
        p_report_type, left(COALESCE(NULLIF(btrim(p_reason), ''), 'other'), 200), v_category,
        NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''), 'pending', 'local',
        COALESCE(p_forward, false) AND v_target_local IS FALSE, v_snapshot, v_scope)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Federation: create_federated_report
-- ---------------------------------------------------------------------------

-- One report per local account named by an inbound Flag. p_post_ids not authored by the
-- account, or not local, are dropped. Result status: created, duplicate, rate_limited,
-- blocked, not_local.
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
-- Moderator queue
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_reports_with_details(text, integer, integer);
DROP FUNCTION IF EXISTS public.get_reports_with_details(text, integer, integer, uuid);

-- Instance admins and moderators list every report, or one server's with p_server_id. A server
-- moderator lists only p_server_id's and receives no reporter identity.
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
    LEFT JOIN public.federated_instances fi
           ON NOT COALESCE(ru.is_local, true) AND fi.domain = lower(ru.domain)
    WHERE (p_status IS NULL OR r.status = p_status)
      AND (p_server_id IS NULL OR r.scope_server_id = p_server_id)
    ORDER BY r.created_at DESC, r.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_reports_with_details(text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reports_with_details(text, integer, integer, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Moderator actions
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.notify_report_update(uuid, jsonb, boolean);

-- p_action:
--   investigate, resolve, dismiss, reopen, assign, unassign     status and assignment
--   forward                                                     queue the Flag (remote account)
--   delete_post, mark_sensitive, delete_message, warn           content and warning; resolve
--   silence_account, suspend_account, force_sensitive_account   account; instance admin; resolve
--   limit_domain, suspend_domain                                remote domain; instance admin; resolve
-- A server moderator of scope_server_id may use the status actions, assign and delete_message.
-- p_note reaches the reporter on resolve or dismiss. p_reason is the account, warning or domain
-- reason and is not sent to the reporter. The reporter's notification names the moderator only
-- with p_show_resolver.
CREATE OR REPLACE FUNCTION public.moderate_report(
    p_report_id uuid,
    p_action text,
    p_note text DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_show_resolver boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_is_admin boolean := public.is_current_user_admin();
    v_is_mod boolean := public.is_current_user_admin_or_mod();
    v_server_mod boolean := false;
    r public.reports%ROWTYPE;
    v_target public.profiles%ROWTYPE;
    v_status text;
    v_open boolean;
    v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 1000), '');
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
    v_resolver jsonb := '{}'::jsonb;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report not found' USING ERRCODE = 'P0002';
    END IF;

    v_server_mod := r.scope_server_id IS NOT NULL
                    AND public.can_current_user_moderate_server_reports(r.scope_server_id);
    IF NOT v_is_mod AND NOT v_server_mod THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_mod AND p_action NOT IN ('investigate', 'resolve', 'dismiss', 'reopen',
                                         'assign', 'unassign', 'delete_message') THEN
        RAISE EXCEPTION 'Permission denied: % requires an instance moderator', p_action USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_admin AND p_action IN ('silence_account', 'suspend_account', 'force_sensitive_account',
                                       'limit_domain', 'suspend_domain') THEN
        RAISE EXCEPTION 'Permission denied: % requires an instance admin', p_action USING ERRCODE = '42501';
    END IF;

    v_open := r.status IN ('pending', 'investigating');
    v_status := r.status;

    IF r.reported_user_id IS NOT NULL THEN
        SELECT * INTO v_target FROM public.profiles WHERE id = r.reported_user_id;
    END IF;

    CASE p_action
    WHEN 'investigate' THEN
        IF r.status <> 'pending' THEN
            RAISE EXCEPTION 'Only a pending report can move to investigating' USING ERRCODE = '22023';
        END IF;
        v_status := 'investigating';
    WHEN 'resolve' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        v_status := 'resolved';
    WHEN 'dismiss' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        v_status := 'dismissed';
    WHEN 'reopen' THEN
        IF v_open THEN RAISE EXCEPTION 'Report is open' USING ERRCODE = '22023'; END IF;
        v_status := 'pending';
    WHEN 'assign' THEN
        UPDATE public.reports SET assigned_to = v_caller, updated_at = now() WHERE id = r.id;
    WHEN 'unassign' THEN
        UPDATE public.reports SET assigned_to = NULL, updated_at = now() WHERE id = r.id;
    WHEN 'forward' THEN
        IF r.source <> 'local' OR v_target.id IS NULL OR COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a local report about a remote account can be forwarded' USING ERRCODE = '22023';
        END IF;
        IF r.forwarded_at IS NOT NULL OR r.federation_status IN ('queued', 'processing') THEN
            RAISE EXCEPTION 'Report already forwarded' USING ERRCODE = '22023';
        END IF;
        UPDATE public.reports
           SET forward = true, federation_status = 'queued', updated_at = now()
         WHERE id = r.id;
        PERFORM public.queue_federation_job(
            'federate-report', jsonb_build_object('type', 'create', 'report_id', r.id), 10, 5, 7200);
    WHEN 'delete_post' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_post_id IS NULL THEN
            RAISE EXCEPTION 'Report names no post' USING ERRCODE = '22023';
        END IF;
        UPDATE public.posts SET is_deleted = true, deleted_at = now() WHERE id = r.reported_post_id;
        v_status := 'resolved';
    WHEN 'mark_sensitive' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_post_id IS NULL THEN
            RAISE EXCEPTION 'Report names no post' USING ERRCODE = '22023';
        END IF;
        UPDATE public.posts SET is_sensitive = true WHERE id = r.reported_post_id;
        v_status := 'resolved';
    WHEN 'delete_message' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_message_id IS NULL THEN
            RAISE EXCEPTION 'Report names no message' USING ERRCODE = '22023';
        END IF;
        -- Same write as CoreMessageService.deleteMessage.
        UPDATE public.messages
           SET content = '[{"type": "text", "text": "[deleted]"}]'::jsonb, is_deleted = true
         WHERE id = r.reported_message_id;
        v_status := 'resolved';
    WHEN 'warn' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL OR NOT COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a local account can be warned' USING ERRCODE = '22023';
        END IF;
        PERFORM public.send_notification_to_user(
            'moderation_warning', v_target.id,
            jsonb_build_object('text', v_reason, 'category', r.category, 'report_type', r.report_type),
            NULL, NULL, NULL, NULL, 'high');
        v_status := 'resolved';
    WHEN 'silence_account', 'suspend_account', 'force_sensitive_account' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL THEN
            RAISE EXCEPTION 'Report names no account' USING ERRCODE = '22023';
        END IF;
        IF p_action = 'silence_account' THEN
            UPDATE public.profiles
               SET is_silenced = true, silenced_at = now(), silenced_reason = v_reason
             WHERE id = v_target.id;
        ELSIF p_action = 'suspend_account' THEN
            UPDATE public.profiles
               SET is_suspended = true, suspended_at = now(), suspension_reason = v_reason
             WHERE id = v_target.id;
        ELSE
            UPDATE public.profiles SET force_sensitive = true WHERE id = v_target.id;
        END IF;
        v_status := 'resolved';
    WHEN 'limit_domain', 'suspend_domain' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL OR COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a remote account''s domain can be limited or suspended' USING ERRCODE = '22023';
        END IF;
        PERFORM public.set_domain_moderation(
            v_target.domain,
            CASE p_action WHEN 'limit_domain' THEN 'limit' ELSE 'suspend' END,
            v_reason);
        v_status := 'resolved';
    ELSE
        RAISE EXCEPTION 'Invalid report action: %', p_action USING ERRCODE = '22023';
    END CASE;

    IF v_status IS DISTINCT FROM r.status THEN
        UPDATE public.reports
           SET status = v_status,
               updated_at = now(),
               resolved_at = CASE WHEN v_status IN ('resolved', 'dismissed') THEN now() END,
               resolved_by = CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_caller END,
               resolution_note = CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_note
                                      WHEN v_status = 'pending' THEN NULL
                                      ELSE resolution_note END
         WHERE id = r.id;
    END IF;

    PERFORM public.log_admin_action(
        v_caller, 'report_' || p_action, 'report', r.id::text,
        jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'previous_status', r.status,
            'report_type', r.report_type,
            'category', r.category,
            'reported_user_id', r.reported_user_id,
            'reported_post_id', r.reported_post_id,
            'reported_message_id', r.reported_message_id,
            'domain', CASE WHEN p_action IN ('limit_domain', 'suspend_domain') THEN lower(v_target.domain) END,
            'reason', v_reason,
            'note', v_note,
            'server_scope', CASE WHEN NOT v_is_mod THEN r.scope_server_id END)));

    IF r.reporter_id IS NOT NULL
       AND v_status IS DISTINCT FROM r.status
       AND v_status IN ('investigating', 'resolved', 'dismissed') THEN
        IF p_show_resolver THEN
            SELECT jsonb_build_object('resolver_username', p.username,
                                      'resolver_display_name', p.display_name,
                                      'resolver_avatar_url', p.avatar_url)
              INTO v_resolver
              FROM public.profiles p WHERE p.id = v_caller;
        END IF;
        PERFORM public.send_notification_to_user(
            'report_update', r.reporter_id,
            jsonb_build_object(
                'report_id', r.id,
                'status', v_status,
                'report_type', r.report_type,
                'category', r.category,
                'resolution_note', CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_note END,
                'show_resolver', COALESCE(p_show_resolver, false))
            || COALESCE(v_resolver, '{}'::jsonb),
            NULL, NULL, NULL,
            CASE WHEN p_show_resolver THEN v_caller END,
            'normal');
    END IF;

    RETURN jsonb_build_object('report_id', r.id, 'action', p_action, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_report(uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid, text, text, text, boolean) TO authenticated, service_role;

-- Owners of SECURITY DEFINER callers keep EXECUTE on the internal snapshot builder.
DO $$
DECLARE
    grantee text;
BEGIN
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.report_content_snapshot(uuid, uuid[], uuid, uuid) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
