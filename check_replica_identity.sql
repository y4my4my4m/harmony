SELECT relname, CASE relreplident WHEN 'f' THEN 'FULL' WHEN 'd' THEN 'DEFAULT' WHEN 'n' THEN 'NOTHING' WHEN 'i' THEN 'INDEX' END as replica_identity FROM pg_class WHERE relname = 'post_interactions';
