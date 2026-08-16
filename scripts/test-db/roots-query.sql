-- Entry points that do not appear in a --schema=public dump: cron schedules,
-- and RLS policies attached to tables in other schemas (realtime, storage).
-- Without these, functions reached only that way look unreachable.
\pset tuples_only on
\pset format unaligned
SELECT command FROM cron.job;
SELECT coalesce(pg_get_expr(polqual, polrelid), '') || ' ' ||
       coalesce(pg_get_expr(polwithcheck, polrelid), '')
  FROM pg_policy;
SELECT pg_get_viewdef(c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('v','m') AND n.nspname <> 'public';
SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef;
