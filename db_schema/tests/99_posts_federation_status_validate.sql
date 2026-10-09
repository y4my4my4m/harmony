-- 20261009600001_posts_federation_status_validate.sql: posts_federation_status_check is
-- validated, so no stored post fails it on update.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(2);

SELECT ok((SELECT convalidated FROM pg_constraint
            WHERE conrelid = 'public.posts'::regclass AND conname = 'posts_federation_status_check'),
          'posts_federation_status_check is validated');

SELECT is_empty(
    $q$SELECT conrelid::regclass::text || '.' || conname FROM pg_constraint
        WHERE contype = 'c' AND NOT convalidated
          AND connamespace = 'public'::regnamespace
          AND conname <> 'megolm_key_requests_status_check'$q$,
    'no other public check constraint is left NOT VALID');

SELECT * FROM finish();
ROLLBACK;
