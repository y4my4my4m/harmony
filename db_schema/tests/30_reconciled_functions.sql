-- Behaviour pinned for functions reconciled between init/ and migrations/.
--
-- Each entry in db_schema/RECONCILE.md gets an assertion here before its
-- migration is written, so the chosen behaviour is stated as a test rather than
-- inferred from whichever body happened to be applied last.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(4);

-- is_author_suspended --------------------------------------------------------
-- profiles.is_suspended is nullable and NULL for every row created before the
-- column existed. The migrated body returns NULL for those, which is neither
-- true nor false: callers written as `IF is_author_suspended(x) THEN` fall
-- through, and `WHERE NOT is_author_suspended(x)` drops the row entirely, so a
-- pre-existing author's posts silently vanish from any filtered listing.
-- False is the answer that matches the column's meaning: not suspended.
INSERT INTO public.profiles (id, username, is_local, is_suspended)
VALUES ('aaaa1111-0000-0000-0000-00000000aaaa', 'nullsuspend', true, NULL);

INSERT INTO public.profiles (id, username, is_local, is_suspended)
VALUES ('bbbb2222-0000-0000-0000-00000000bbbb', 'suspended', true, true);

SELECT is(public.is_author_suspended('aaaa1111-0000-0000-0000-00000000aaaa'), false,
          'a NULL is_suspended reads as not suspended, never NULL');
SELECT is(public.is_author_suspended('bbbb2222-0000-0000-0000-00000000bbbb'), true,
          'a suspended author reads as suspended');
SELECT is(public.is_author_suspended('11111111-0000-0000-0000-000000000001'), false,
          'an ordinary author reads as not suspended');
SELECT is(public.is_author_suspended('00000000-0000-0000-0000-000000000000'), false,
          'an unknown author reads as not suspended rather than NULL');

SELECT * FROM finish();
ROLLBACK;
