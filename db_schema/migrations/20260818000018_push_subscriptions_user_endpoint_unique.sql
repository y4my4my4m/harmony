-- federation-backend/src/services/PushNotificationService.ts upserts ON CONFLICT
-- (user_id, endpoint). Without a matching unique constraint Postgres raises 42P10 and
-- Web Push registration fails. Production carries the constraint; init/ did not.
--
-- Keeper is the newest row per (user_id, endpoint). p256dh and auth rotate on
-- re-subscribe, so an older copy's keys no longer decrypt. Nothing references
-- push_subscriptions.id.

BEGIN;

DELETE FROM public.push_subscriptions
WHERE id IN (
    SELECT id
      FROM (
        SELECT id,
               row_number() OVER (
                   PARTITION BY user_id, endpoint
                   ORDER BY updated_at DESC, created_at DESC, id DESC
               ) AS rn
          FROM public.push_subscriptions
      ) ranked
     WHERE rn > 1
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.push_subscriptions'::regclass
           AND conname = 'push_subscriptions_user_endpoint_unique'
    ) THEN
        ALTER TABLE public.push_subscriptions
            ADD CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint);
    END IF;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
