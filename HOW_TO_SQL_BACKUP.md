# How to Backup and Restore Supabase Schema

pg_dump \
  -h <your-vps-ip-or-domain> \
  -p 15432 \
  -U postgres \
  --schema=public,storage \
  --no-owner \
  --no-privileges \
  --format=plain \
  --file=supabase_schema_backup.sql \
  --schema-only


pg_dump -h <host> -p <port> -U postgres --table=storage.buckets --data-only --inserts -f supabase_buckets_backup.sql


delete these:

```
--
-- PostgreSQL database dump
--

-- Dumped from database version 15.1 (Ubuntu 15.1-1.pgdg20.04+1)
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';

```

Same with the storage schema, if you have it:



# Restore the schema backup to your local PostgreSQL database

psql -h <host> -U <user> -d <dbname> -f supabase_schema_backup.sql

OR

manually copy paste the SQL in supabase's studio sql editor