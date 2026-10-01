-- Push transports for the Android app, and the read fan-out that closes a notification on
-- the phone once it is read anywhere.
--
-- Transports. push_subscriptions holds every push target, told apart by transport:
--   webpush      a browser or PWA subscription; the service worker renders the payload.
--   unifiedpush  a UnifiedPush endpoint of the Android app. Distributors accept RFC 8030
--                Web Push with RFC 8291 encryption and VAPID, so the row carries endpoint,
--                p256dh and auth like a browser's and the same web-push sender delivers it;
--                only the payload differs.
--   fcm          a Firebase Cloud Messaging registration token of the Android app, held in
--                endpoint. There are no Web Push keys, so p256dh and auth are null.
-- An FCM token names one installation, so it is unique across accounts
-- (push_subscriptions_fcm_token_unique); the backend moves the row on sign-in elsewhere.
-- get_user_push_subscriptions returns transport, which changes its result type: the
-- function is dropped and recreated.
--
-- Read fan-out. notifications already broadcasts notification:update, notification:bulk_read
-- and notification:deleted to open clients. A closed app hears none of them, so the same
-- transitions queue a 'dismiss-push-notifications' job for users with an app transport:
-- one job per user and statement, carrying the ids that turned read (or unread rows that
-- were deleted), or all = true for mark_all_notifications_read
-- (harmony.notification_bulk_read = 'on') and above 200 ids. Browsers get no dismissal:
-- Web Push requires every push to show a notification. Users with neither app transport
-- queue nothing.

BEGIN;

-- ---------------------------------------------------------------------------
-- Transports
-- ---------------------------------------------------------------------------

ALTER TABLE public.push_subscriptions
    ADD COLUMN IF NOT EXISTS transport text DEFAULT 'webpush' NOT NULL;
ALTER TABLE public.push_subscriptions ALTER COLUMN transport SET DEFAULT 'webpush';
ALTER TABLE public.push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE public.push_subscriptions ALTER COLUMN auth DROP NOT NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.push_subscriptions'::regclass
                  AND conname = 'push_subscriptions_transport_check') THEN
        RAISE NOTICE 'push_subscriptions_transport_check present, skipped';
    ELSE
        ALTER TABLE public.push_subscriptions
            ADD CONSTRAINT push_subscriptions_transport_check
            CHECK (transport IN ('webpush', 'unifiedpush', 'fcm'));
        RAISE NOTICE 'push_subscriptions_transport_check added';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.push_subscriptions'::regclass
                  AND conname = 'push_subscriptions_keys_check') THEN
        RAISE NOTICE 'push_subscriptions_keys_check present, skipped';
    ELSE
        ALTER TABLE public.push_subscriptions
            ADD CONSTRAINT push_subscriptions_keys_check
            CHECK (transport = 'fcm' OR (p256dh IS NOT NULL AND auth IS NOT NULL));
        RAISE NOTICE 'push_subscriptions_keys_check added';
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_fcm_token_unique
    ON public.push_subscriptions (endpoint)
    WHERE transport = 'fcm';

COMMENT ON COLUMN public.push_subscriptions.transport IS
    'webpush (browser), unifiedpush (Android app, Web Push keys) or fcm (Android app, token in endpoint).';
COMMENT ON COLUMN public.push_subscriptions.endpoint IS
    'Push service URL, or the FCM registration token when transport = fcm.';

DROP FUNCTION IF EXISTS public.get_user_push_subscriptions(uuid);

CREATE FUNCTION public.get_user_push_subscriptions(p_user_id uuid)
RETURNS TABLE(subscription_id uuid, endpoint text, p256dh text, auth text,
              push_enabled boolean, push_offline_only boolean, transport text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT ps.id,
           ps.endpoint,
           ps.p256dh,
           ps.auth,
           COALESCE(np.push_notifications, true),
           COALESCE(np.push_offline_only, true),
           ps.transport
      FROM public.push_subscriptions ps
      LEFT JOIN public.notification_preferences np ON np.user_id = ps.user_id
     WHERE ps.user_id = p_user_id
       AND COALESCE(ps.failure_count, 0) < 5;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_push_subscriptions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_push_subscriptions(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Read fan-out
-- ---------------------------------------------------------------------------

-- p_ids NULL means every notification of the user.
CREATE OR REPLACE FUNCTION public.queue_push_dismissal(p_user_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_all boolean := p_ids IS NULL OR cardinality(p_ids) > 200;
BEGIN
    PERFORM public.queue_federation_job(
        'dismiss-push-notifications',
        jsonb_build_object(
            'user_id', p_user_id,
            'ids', CASE WHEN v_all THEN NULL ELSE to_jsonb(p_ids) END,
            'all', v_all
        ),
        5,
        3,
        300
    );
END;
$$;

REVOKE ALL ON FUNCTION public.queue_push_dismissal(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.queue_push_dismissal_on_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bulk boolean := COALESCE(current_setting('harmony.notification_bulk_read', true), '') = 'on';
    r record;
BEGIN
    FOR r IN
        SELECT n.user_id, array_agg(n.id ORDER BY n.id) AS ids
          FROM push_read_new n
          JOIN push_read_old o ON o.id = n.id
         WHERE n.is_read IS TRUE
           AND o.is_read IS NOT TRUE
           AND EXISTS (SELECT 1 FROM public.push_subscriptions ps
                        WHERE ps.user_id = n.user_id
                          AND ps.transport IN ('unifiedpush', 'fcm'))
         GROUP BY n.user_id
    LOOP
        PERFORM public.queue_push_dismissal(r.user_id, CASE WHEN v_bulk THEN NULL ELSE r.ids END);
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_push_dismissal_on_read() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.queue_push_dismissal_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT d.user_id, array_agg(d.id ORDER BY d.id) AS ids
          FROM push_deleted d
         WHERE d.is_read IS NOT TRUE
           AND EXISTS (SELECT 1 FROM public.push_subscriptions ps
                        WHERE ps.user_id = d.user_id
                          AND ps.transport IN ('unifiedpush', 'fcm'))
         GROUP BY d.user_id
    LOOP
        PERFORM public.queue_push_dismissal(r.user_id, r.ids);
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_push_dismissal_on_delete() FROM PUBLIC, anon, authenticated;

-- Transition tables rule out a column list and a second event, hence two statement
-- triggers that fire on every UPDATE and DELETE.
DROP TRIGGER IF EXISTS trg_queue_push_dismissal_on_read ON public.notifications;
CREATE TRIGGER trg_queue_push_dismissal_on_read
    AFTER UPDATE ON public.notifications
    REFERENCING OLD TABLE AS push_read_old NEW TABLE AS push_read_new
    FOR EACH STATEMENT EXECUTE FUNCTION public.queue_push_dismissal_on_read();

DROP TRIGGER IF EXISTS trg_queue_push_dismissal_on_delete ON public.notifications;
CREATE TRIGGER trg_queue_push_dismissal_on_delete
    AFTER DELETE ON public.notifications
    REFERENCING OLD TABLE AS push_deleted
    FOR EACH STATEMENT EXECUTE FUNCTION public.queue_push_dismissal_on_delete();

COMMIT;

NOTIFY pgrst, 'reload schema';
