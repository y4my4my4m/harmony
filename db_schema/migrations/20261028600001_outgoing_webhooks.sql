-- Outgoing webhooks (ROADMAP 15): the events a bot's gateway connection receives, POSTed to a URL
-- that a bot's owner or a server's managers register. Replaces the unused bot_webhooks.
--
--   outgoing_webhooks              one per URL: a bot's (bot_id) or a server's (server_id), the event
--                                  types it takes, its signing secret in Vault (secret_id; shown once
--                                  on create and rotate), and its delivery state. failing_since is the
--                                  first failure since the last success; three days of it disables
--                                  the webhook (disabled_reason 'failing') and tells its owner.
--   outgoing_webhook_deliveries    one per event and webhook: the payload as sent, attempts, the last
--                                  answer. Job 'deliver-outgoing-webhook' {delivery_id} makes one
--                                  attempt; a failure schedules the next (30 s, 2 min, 10 min, 30 min,
--                                  1 h, 3 h, 6 h), the eighth failure ends it. Kept seven days.
--   server_member_changes          joins and leaves of local servers, in order (id), for the bot
--                                  gateway; kept seven days.
--
-- Who receives an event: the bot gateway decides, as for its WebSocket connections
-- (EventDispatcher resolveReaders), and calls enqueue_outgoing_webhook_event with the bots that
-- read it. A server's webhook takes an event of a channel only while its creator can view the
-- channel and still manages the server's webhooks. Direct messages and end-to-end encrypted
-- messages never reach a webhook. The federation backend's worker signs (Standard Webhooks:
-- webhook-id, webhook-timestamp, webhook-signature v1) and sends.
--
-- Error messages begin with a stable code the client reads:
--   OUTGOING_WEBHOOK_FORBIDDEN       42501  not the bot's owner, nor a manager of the server's webhooks
--   OUTGOING_WEBHOOK_NOT_FOUND       P0002
--   OUTGOING_WEBHOOK_INVALID_NAME    22023  not 1 to 80 characters
--   OUTGOING_WEBHOOK_INVALID_URL     22023  not https (http only for localhost), or past 2048 characters
--   OUTGOING_WEBHOOK_INVALID_EVENTS  22023  none, or one this instance does not send
--   OUTGOING_WEBHOOK_LIMIT           54000  five per bot or per server
--   OUTGOING_WEBHOOK_UNAVAILABLE     0A000  Supabase Vault is not installed

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Present in supabase/postgres images; without it webhooks cannot be created.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS supabase_vault;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'supabase_vault unavailable (%): outgoing webhooks are disabled', SQLERRM;
END;
$$;

DROP TABLE IF EXISTS public.bot_webhooks;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.outgoing_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid REFERENCES public.bots(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    name text NOT NULL CONSTRAINT outgoing_webhooks_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    url text NOT NULL CONSTRAINT outgoing_webhooks_url_check CHECK (char_length(url) <= 2048),
    events text[] NOT NULL CONSTRAINT outgoing_webhooks_events_check CHECK (cardinality(events) > 0),
    secret_id uuid,
    secret_hint text,
    is_active boolean NOT NULL DEFAULT true,
    disabled_reason text CONSTRAINT outgoing_webhooks_disabled_reason_check
        CHECK (disabled_reason IS NULL OR disabled_reason IN ('owner', 'failing')),
    failing_since timestamptz,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_status integer,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outgoing_webhooks_owner_check CHECK ((bot_id IS NULL) <> (server_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_bot ON public.outgoing_webhooks (bot_id) WHERE bot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_server ON public.outgoing_webhooks (server_id) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_created_by ON public.outgoing_webhooks (created_by);
COMMENT ON TABLE public.outgoing_webhooks IS
    'URLs a bot''s owner or a server''s managers registered for events; secrets in Vault.';

CREATE TABLE IF NOT EXISTS public.outgoing_webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id uuid NOT NULL REFERENCES public.outgoing_webhooks(id) ON DELETE CASCADE,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CONSTRAINT outgoing_webhook_deliveries_status_check CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_status integer,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_due
    ON public.outgoing_webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_webhook
    ON public.outgoing_webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_created
    ON public.outgoing_webhook_deliveries (created_at);

CREATE TABLE IF NOT EXISTS public.server_member_changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    change text NOT NULL CONSTRAINT server_member_changes_change_check CHECK (change IN ('join', 'leave')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_server_member_changes_server ON public.server_member_changes (server_id);
CREATE INDEX IF NOT EXISTS idx_server_member_changes_created ON public.server_member_changes (created_at);

REVOKE ALL ON public.outgoing_webhooks, public.outgoing_webhook_deliveries, public.server_member_changes
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.outgoing_webhooks, public.outgoing_webhook_deliveries, public.server_member_changes
    TO service_role;
ALTER TABLE public.outgoing_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outgoing_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_member_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outgoing_webhooks_service_role ON public.outgoing_webhooks;
CREATE POLICY outgoing_webhooks_service_role ON public.outgoing_webhooks
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS outgoing_webhook_deliveries_service_role ON public.outgoing_webhook_deliveries;
CREATE POLICY outgoing_webhook_deliveries_service_role ON public.outgoing_webhook_deliveries
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS server_member_changes_service_role ON public.server_member_changes;
CREATE POLICY server_member_changes_service_role ON public.server_member_changes
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Member changes
-- ---------------------------------------------------------------------------

-- An accepted membership of a local server begins or ends.
CREATE OR REPLACE FUNCTION public.record_server_member_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_was boolean := TG_OP <> 'INSERT' AND OLD.status = 'accepted';
    v_is boolean := TG_OP <> 'DELETE' AND NEW.status = 'accepted';
    v_server uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.server_id ELSE NEW.server_id END;
    v_user uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
    IF v_was = v_is THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_server AND s.is_local_server IS NOT FALSE) THEN
        RETURN NULL;
    END IF;
    INSERT INTO public.server_member_changes (server_id, user_id, change)
    VALUES (v_server, v_user, CASE WHEN v_is THEN 'join' ELSE 'leave' END);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_user_servers_member_changes ON public.user_servers;
CREATE TRIGGER z_user_servers_member_changes
    AFTER INSERT OR DELETE OR UPDATE OF status ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.record_server_member_change();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.outgoing_webhook_event_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE',
        'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
        'SERVER_MEMBER_ADD', 'SERVER_MEMBER_REMOVE', 'SERVER_MEMBER_KICK',
        'SERVER_BAN_ADD', 'SERVER_BAN_REMOVE']
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_assert_vault()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regprocedure('vault.create_secret(text, text, text, uuid)') IS NULL
       OR to_regclass('vault.decrypted_secrets') IS NULL THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_UNAVAILABLE: Supabase Vault (supabase_vault) is not installed'
            USING ERRCODE = '0A000';
    END IF;
END;
$$;

-- The caller may manage webhooks of the bot (its owner) or of the server (its owner, an instance
-- admin, or a member holding MANAGE_WEBHOOKS).
CREATE OR REPLACE FUNCTION public.can_manage_outgoing_webhooks(p_bot_id uuid, p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.get_current_profile_id() IS NOT NULL AND CASE
        WHEN p_bot_id IS NOT NULL THEN EXISTS (
            SELECT 1 FROM public.bots b WHERE b.id = p_bot_id AND b.owner_id = public.get_current_profile_id())
        WHEN p_server_id IS NOT NULL THEN EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE
               AND (s.owner = public.get_current_profile_id()
                    OR public.is_current_user_admin()
                    OR (EXISTS (SELECT 1 FROM public.user_servers us
                                 WHERE us.server_id = s.id AND us.user_id = public.get_current_profile_id()
                                   AND us.status = 'accepted')
                        AND public.has_permission(public.get_current_profile_id(), s.id, 'MANAGE_WEBHOOKS'))))
        ELSE false
    END
$$;

-- A server webhook's creator still manages the server's webhooks and views the channel.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_creator_reads(p_webhook public.outgoing_webhooks, p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_webhook.created_by IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.servers s
            WHERE s.id = p_webhook.server_id
              AND (s.owner = p_webhook.created_by
                   OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_webhook.created_by AND p.is_admin IS TRUE)
                   OR (EXISTS (SELECT 1 FROM public.user_servers us
                                WHERE us.server_id = s.id AND us.user_id = p_webhook.created_by
                                  AND us.status = 'accepted')
                       AND public.has_permission(p_webhook.created_by, s.id, 'MANAGE_WEBHOOKS'))))
       AND (p_channel_id IS NULL OR public.can_view_channel(p_webhook.created_by, p_channel_id))
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', w.id, 'bot_id', w.bot_id, 'server_id', w.server_id, 'name', w.name, 'url', w.url,
        'events', to_jsonb(w.events), 'secret_hint', w.secret_hint, 'is_active', w.is_active,
        'disabled_reason', w.disabled_reason, 'failing_since', w.failing_since,
        'last_success_at', w.last_success_at, 'last_failure_at', w.last_failure_at,
        'last_status', w.last_status, 'last_error', w.last_error,
        'created_by', w.created_by, 'created_at', w.created_at)
      FROM public.outgoing_webhooks w WHERE w.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_valid_url(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_url IS NOT NULL AND char_length(p_url) <= 2048 AND p_url !~ '\s'
       AND (p_url ~* '^https://[^/?#@]+(/|$|\?)'
            OR p_url ~* '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$|\?)')
$$;

-- A new secret in Standard Webhooks form (whsec_ + base64 of 32 random bytes), stored in Vault.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_new_secret(p_webhook_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_secret text := 'whsec_' || encode(extensions.gen_random_bytes(32), 'base64');
    v_old uuid;
    v_new uuid;
BEGIN
    PERFORM public.outgoing_webhook_assert_vault();
    v_new := vault.create_secret(v_secret, NULL, 'Outgoing webhook ' || p_webhook_id || ': signing secret');
    SELECT w.secret_id INTO v_old FROM public.outgoing_webhooks w WHERE w.id = p_webhook_id FOR UPDATE;
    UPDATE public.outgoing_webhooks
       SET secret_id = v_new, secret_hint = right(v_secret, 4), updated_at = now()
     WHERE id = p_webhook_id;
    IF v_old IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_old;
    END IF;
    RETURN v_secret;
END;
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhooks_purge_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.secret_id IS NOT NULL AND to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = OLD.secret_id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS outgoing_webhooks_purge_secret ON public.outgoing_webhooks;
CREATE TRIGGER outgoing_webhooks_purge_secret
    AFTER DELETE ON public.outgoing_webhooks
    FOR EACH ROW EXECUTE FUNCTION public.outgoing_webhooks_purge_secret();

-- The webhook, locked, when the caller may manage it.
CREATE OR REPLACE FUNCTION public.lock_managed_outgoing_webhook(p_webhook_id uuid)
RETURNS public.outgoing_webhooks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks;
BEGIN
    SELECT * INTO v_row FROM public.outgoing_webhooks WHERE id = p_webhook_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_NOT_FOUND: no such webhook' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_outgoing_webhooks(v_row.bot_id, v_row.server_id) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: you cannot manage this webhook' USING ERRCODE = '42501';
    END IF;
    RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_check_fields(p_name text, p_url text, p_events text[])
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_name IS NOT NULL AND char_length(btrim(p_name)) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_NAME: 1 to 80 characters' USING ERRCODE = '22023';
    END IF;
    IF p_url IS NOT NULL AND NOT public.outgoing_webhook_valid_url(p_url) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_URL: an https URL of at most 2048 characters' USING ERRCODE = '22023';
    END IF;
    IF p_events IS NOT NULL AND (cardinality(p_events) = 0 OR NOT p_events <@ public.outgoing_webhook_event_types()) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_EVENTS: choose events this instance sends' USING ERRCODE = '22023';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- Exactly one of p_bot_id and p_server_id. Returns the webhook with its secret, shown this once.
CREATE OR REPLACE FUNCTION public.create_outgoing_webhook(
    p_bot_id uuid, p_server_id uuid, p_name text, p_url text, p_events text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid;
    v_secret text;
BEGIN
    IF (p_bot_id IS NULL) = (p_server_id IS NULL) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: name a bot or a server' USING ERRCODE = '22023';
    END IF;
    IF NOT public.can_manage_outgoing_webhooks(p_bot_id, p_server_id) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: you cannot manage these webhooks' USING ERRCODE = '42501';
    END IF;
    IF p_name IS NULL OR p_url IS NULL OR p_events IS NULL THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_NAME: name, URL and events are required' USING ERRCODE = '22023';
    END IF;
    PERFORM public.outgoing_webhook_check_fields(p_name, p_url, p_events);
    PERFORM public.outgoing_webhook_assert_vault();

    PERFORM pg_advisory_xact_lock(hashtextextended('outgoing_webhooks:' || COALESCE(p_bot_id, p_server_id)::text, 0));
    IF (SELECT count(*) FROM public.outgoing_webhooks w
         WHERE w.bot_id IS NOT DISTINCT FROM p_bot_id AND w.server_id IS NOT DISTINCT FROM p_server_id) >= 5 THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_LIMIT: five webhooks at most' USING ERRCODE = '54000';
    END IF;

    INSERT INTO public.outgoing_webhooks (bot_id, server_id, created_by, name, url, events)
    VALUES (p_bot_id, p_server_id, public.get_current_profile_id(), btrim(p_name), p_url,
            ARRAY(SELECT DISTINCT e FROM unnest(p_events) e ORDER BY e))
    RETURNING id INTO v_id;
    v_secret := public.outgoing_webhook_new_secret(v_id);
    RETURN public.outgoing_webhook_json(v_id) || jsonb_build_object('secret', v_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_outgoing_webhooks(p_bot_id uuid, p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (p_bot_id IS NULL) = (p_server_id IS NULL) OR NOT public.can_manage_outgoing_webhooks(p_bot_id, p_server_id) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: you cannot manage these webhooks' USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(public.outgoing_webhook_json(w.id) ORDER BY w.created_at, w.id)
          FROM public.outgoing_webhooks w
         WHERE w.bot_id IS NOT DISTINCT FROM p_bot_id AND w.server_id IS NOT DISTINCT FROM p_server_id), '[]'::jsonb);
END;
$$;

-- NULL keeps a field. Turning a webhook on clears its failure state.
CREATE OR REPLACE FUNCTION public.update_outgoing_webhook(
    p_webhook_id uuid, p_name text DEFAULT NULL, p_url text DEFAULT NULL,
    p_events text[] DEFAULT NULL, p_active boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
BEGIN
    PERFORM public.outgoing_webhook_check_fields(p_name, p_url, p_events);
    UPDATE public.outgoing_webhooks
       SET name = COALESCE(btrim(p_name), name),
           url = COALESCE(p_url, url),
           events = CASE WHEN p_events IS NULL THEN events
                         ELSE ARRAY(SELECT DISTINCT e FROM unnest(p_events) e ORDER BY e) END,
           is_active = COALESCE(p_active, is_active),
           disabled_reason = CASE
               WHEN p_active IS TRUE THEN NULL
               WHEN p_active IS FALSE THEN 'owner'
               ELSE disabled_reason END,
           failing_since = CASE WHEN p_active IS TRUE AND NOT v_row.is_active THEN NULL ELSE failing_since END,
           updated_at = now()
     WHERE id = v_row.id;
    RETURN public.outgoing_webhook_json(v_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_outgoing_webhook_secret(p_webhook_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
    v_secret text := public.outgoing_webhook_new_secret(v_row.id);
BEGIN
    RETURN public.outgoing_webhook_json(v_row.id) || jsonb_build_object('secret', v_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_outgoing_webhook(p_webhook_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
BEGIN
    DELETE FROM public.outgoing_webhooks WHERE id = v_row.id;
END;
$$;

-- The webhook's latest deliveries, newest first; payloads left out.
CREATE OR REPLACE FUNCTION public.list_outgoing_webhook_deliveries(p_webhook_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
BEGIN
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', d.id, 'event', d.event, 'status', d.status, 'attempts', d.attempts,
                   'last_status', d.last_status, 'last_error', d.last_error,
                   'created_at', d.created_at, 'delivered_at', d.delivered_at,
                   'next_attempt_at', CASE WHEN d.status = 'pending' THEN d.next_attempt_at END)
                   ORDER BY d.created_at DESC, d.id)
          FROM (SELECT * FROM public.outgoing_webhook_deliveries x
                 WHERE x.webhook_id = v_row.id
                 ORDER BY x.created_at DESC, x.id
                 LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) d), '[]'::jsonb);
END;
$$;

-- A PING delivery, whatever events the webhook takes.
CREATE OR REPLACE FUNCTION public.test_outgoing_webhook(p_webhook_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
    v_id uuid;
BEGIN
    IF NOT v_row.is_active THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: turn the webhook on first' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload)
    VALUES (v_row.id, 'PING', jsonb_build_object(
        'webhook_id', v_row.id, 'bot_id', v_row.bot_id, 'server_id', v_row.server_id))
    RETURNING id INTO v_id;
    PERFORM public.queue_federation_job('deliver-outgoing-webhook', jsonb_build_object('delivery_id', v_id));
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Service RPCs: the bot gateway and the federation backend's worker
-- ---------------------------------------------------------------------------

-- Active webhooks and what they take, for the bot gateway's cache.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_routes()
RETURNS TABLE (bot_id uuid, server_id uuid, events text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT w.bot_id, w.server_id, w.events FROM public.outgoing_webhooks w WHERE w.is_active
$$;

-- One delivery for each active webhook taking p_event: a bot's, when the bot is among p_bot_ids
-- (the gateway's readers of the event); a server's, for an event of p_server_id whose channel its
-- creator reads. Returns the number queued.
CREATE OR REPLACE FUNCTION public.enqueue_outgoing_webhook_event(
    p_event text, p_server_id uuid, p_channel_id uuid, p_bot_ids uuid[], p_payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_webhook public.outgoing_webhooks;
    v_id uuid;
    v_count integer := 0;
BEGIN
    IF NOT p_event = ANY (public.outgoing_webhook_event_types()) THEN
        RETURN 0;
    END IF;
    FOR v_webhook IN
        SELECT w.* FROM public.outgoing_webhooks w
         WHERE w.is_active AND p_event = ANY (w.events)
           AND ((w.bot_id IS NOT NULL AND w.bot_id = ANY (COALESCE(p_bot_ids, '{}'::uuid[])))
                OR (w.server_id IS NOT NULL AND w.server_id = p_server_id))
    LOOP
        IF v_webhook.server_id IS NOT NULL AND NOT public.outgoing_webhook_creator_reads(v_webhook, p_channel_id) THEN
            CONTINUE;
        END IF;
        INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload)
        VALUES (v_webhook.id, p_event, p_payload)
        RETURNING id INTO v_id;
        PERFORM public.queue_federation_job('deliver-outgoing-webhook', jsonb_build_object('delivery_id', v_id));
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

-- Claims a pending, due delivery of an active webhook for one attempt: the next claim waits two
-- minutes, so a job and the sweep never send it twice. Returns what the worker sends; no row when
-- there is nothing to send.
CREATE OR REPLACE FUNCTION public.claim_outgoing_webhook_delivery(p_delivery_id uuid)
RETURNS TABLE (delivery_id uuid, webhook_id uuid, url text, secret text, event text, payload jsonb,
               attempts integer, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.outgoing_webhook_assert_vault();
    RETURN QUERY
    WITH claimed AS (
        UPDATE public.outgoing_webhook_deliveries d
           SET next_attempt_at = now() + interval '2 minutes'
          FROM public.outgoing_webhooks w
         WHERE d.id = p_delivery_id AND w.id = d.webhook_id
           AND d.status = 'pending' AND d.next_attempt_at <= now() AND w.is_active
        RETURNING d.id, d.webhook_id, d.event, d.payload, d.attempts, d.created_at, w.url, w.secret_id)
    SELECT c.id, c.webhook_id, c.url, s.decrypted_secret, c.event, c.payload, c.attempts, c.created_at
      FROM claimed c
      JOIN vault.decrypted_secrets s ON s.id = c.secret_id;
END;
$$;

-- The outcome of one attempt. A failure schedules the next attempt or ends the delivery; three
-- days of failures since the last success disable the webhook and tell its owner.
CREATE OR REPLACE FUNCTION public.record_outgoing_webhook_attempt(
    p_delivery_id uuid, p_ok boolean, p_status integer, p_error text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_delay CONSTANT interval[] := ARRAY['30 seconds', '2 minutes', '10 minutes', '30 minutes',
                                         '1 hour', '3 hours', '6 hours']::interval[];
    v_delivery public.outgoing_webhook_deliveries;
    v_webhook public.outgoing_webhooks;
    v_attempts integer;
    v_error text := left(p_error, 300);
    v_status text;
BEGIN
    SELECT * INTO v_delivery FROM public.outgoing_webhook_deliveries WHERE id = p_delivery_id FOR UPDATE;
    IF NOT FOUND OR v_delivery.status <> 'pending' THEN
        RETURN NULL;
    END IF;
    v_attempts := v_delivery.attempts + 1;
    v_status := CASE WHEN p_ok THEN 'delivered' WHEN v_attempts > cardinality(v_delay) THEN 'failed' ELSE 'pending' END;

    UPDATE public.outgoing_webhook_deliveries
       SET attempts = v_attempts, status = v_status, last_status = p_status,
           last_error = CASE WHEN p_ok THEN NULL ELSE v_error END,
           delivered_at = CASE WHEN p_ok THEN now() END,
           next_attempt_at = CASE WHEN v_status = 'pending' THEN now() + v_delay[v_attempts] ELSE next_attempt_at END
     WHERE id = p_delivery_id;

    SELECT * INTO v_webhook FROM public.outgoing_webhooks WHERE id = v_delivery.webhook_id FOR UPDATE;
    IF p_ok THEN
        UPDATE public.outgoing_webhooks
           SET last_success_at = now(), failing_since = NULL, last_status = p_status, last_error = NULL
         WHERE id = v_webhook.id;
    ELSE
        UPDATE public.outgoing_webhooks
           SET last_failure_at = now(), failing_since = COALESCE(failing_since, now()),
               last_status = p_status, last_error = v_error
         WHERE id = v_webhook.id
        RETURNING * INTO v_webhook;
        IF v_webhook.is_active AND v_webhook.failing_since < now() - interval '3 days' THEN
            UPDATE public.outgoing_webhooks SET is_active = false, disabled_reason = 'failing' WHERE id = v_webhook.id;
            INSERT INTO public.notifications (user_id, type, data)
            SELECT DISTINCT r.user_id, 'outgoing_webhook_disabled', jsonb_build_object(
                       'webhook', jsonb_build_object('id', v_webhook.id, 'name', v_webhook.name),
                       'bot_id', v_webhook.bot_id, 'server_id', v_webhook.server_id,
                       'last_error', v_error)
              FROM (SELECT b.owner_id AS user_id FROM public.bots b WHERE b.id = v_webhook.bot_id
                    UNION SELECT v_webhook.created_by WHERE v_webhook.server_id IS NOT NULL) r
             WHERE r.user_id IS NOT NULL;
        END IF;
    END IF;
    RETURN v_status;
END;
$$;

-- Pending deliveries due now: retries, and first attempts whose job was lost.
CREATE OR REPLACE FUNCTION public.due_outgoing_webhook_deliveries(p_limit integer DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT d.id FROM public.outgoing_webhook_deliveries d
     WHERE d.status = 'pending' AND d.next_attempt_at <= now()
       AND (d.attempts > 0 OR d.created_at < now() - interval '1 minute')
     ORDER BY d.next_attempt_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$$;

-- Deliveries and member changes older than seven days. Returns the rows removed.
CREATE OR REPLACE FUNCTION public.prune_outgoing_webhook_records()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deliveries integer;
    v_changes integer;
BEGIN
    DELETE FROM public.outgoing_webhook_deliveries WHERE created_at < now() - interval '7 days';
    GET DIAGNOSTICS v_deliveries = ROW_COUNT;
    DELETE FROM public.server_member_changes WHERE created_at < now() - interval '7 days';
    GET DIAGNOSTICS v_changes = ROW_COUNT;
    RETURN v_deliveries + v_changes;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.record_server_member_change()'::regprocedure,
        'public.outgoing_webhook_event_types()'::regprocedure,
        'public.outgoing_webhook_assert_vault()'::regprocedure,
        'public.can_manage_outgoing_webhooks(uuid, uuid)'::regprocedure,
        'public.outgoing_webhook_creator_reads(public.outgoing_webhooks, uuid)'::regprocedure,
        'public.outgoing_webhook_json(uuid)'::regprocedure,
        'public.outgoing_webhook_valid_url(text)'::regprocedure,
        'public.outgoing_webhook_new_secret(uuid)'::regprocedure,
        'public.outgoing_webhooks_purge_secret()'::regprocedure,
        'public.lock_managed_outgoing_webhook(uuid)'::regprocedure,
        'public.outgoing_webhook_check_fields(text, text, text[])'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.create_outgoing_webhook(uuid, uuid, text, text, text[])'::regprocedure,
        'public.list_outgoing_webhooks(uuid, uuid)'::regprocedure,
        'public.update_outgoing_webhook(uuid, text, text, text[], boolean)'::regprocedure,
        'public.rotate_outgoing_webhook_secret(uuid)'::regprocedure,
        'public.delete_outgoing_webhook(uuid)'::regprocedure,
        'public.list_outgoing_webhook_deliveries(uuid, integer)'::regprocedure,
        'public.test_outgoing_webhook(uuid)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.outgoing_webhook_routes()'::regprocedure,
        'public.enqueue_outgoing_webhook_event(text, uuid, uuid, uuid[], jsonb)'::regprocedure,
        'public.claim_outgoing_webhook_delivery(uuid)'::regprocedure,
        'public.record_outgoing_webhook_attempt(uuid, boolean, integer, text)'::regprocedure,
        'public.due_outgoing_webhook_deliveries(integer)'::regprocedure,
        'public.prune_outgoing_webhook_records()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
