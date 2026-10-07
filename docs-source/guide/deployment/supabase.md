# Supabase Setup

Harmony uses Supabase for PostgreSQL, authentication (GoTrue), the REST API (PostgREST), Realtime and file storage. The self-host stack runs the upstream Supabase Docker stack and loads the schema itself; this page covers what it does and how to do the same against a database you run elsewhere.

## Supported database

CI installs the schema on `supabase/postgres:15.8.1.060` (`scripts/check-fresh-install.sh`). `self-host/configure.sh` pins the upstream Supabase Docker stack to the last commit that runs that image (`SUPABASE_REF_DEFAULT`), and `supabase/config.toml` sets `major_version = 15`. `configure.sh --refresh-supabase` refuses a stack whose Postgres major version differs from the existing data directory's.

## Schema

The schema lives in `db_schema/migrations/`. File names are `<version>_<name>.sql`, `version` being `YYYYMMDDNNNNNN` and unique across the directory. `20260101000000_baseline.sql` builds the whole schema on an empty database; every later file is a change on top of it. A new instance and an existing one take the same path: the ledger `supabase_migrations.schema_migrations` decides what runs.

The ledger records versions only. Editing a file that is already applied changes new installs and nothing else, so every change ships as a new file.

### Postgres in Docker

```bash
bash self-host/bootstrap.sh                    # migrations, listener role, instance domain
bash self-host/bootstrap.sh --migrations-only  # migrations only
```

`bootstrap.sh` copies `db_schema/` into the Postgres container (`supabase-db`, or `SUPABASE_DB_CONTAINER`), applies each pending file in version order through `docker exec`, and records it in the ledger. It runs as `postgres`, or as `supabase_admin` when `postgres` does not own the existing functions. A failing file stops the run unrecorded, leaving the database at the last file that succeeded. PostgREST reloads its schema cache at the end.

Without `--migrations-only` it also:

- creates or updates the `harmony_listener` role, when `self-host/federation.env` holds `__LISTENER_PW`
- writes the instance name and domain into `instance_config` from `INSTANCE_NAME` and `DOMAIN` in `self-host/.env`, while the domain still holds the seed value `localhost`

`harmony update` runs `bootstrap.sh --migrations-only` after taking a backup.

### Postgres outside Docker

The Supabase CLI applies the same files against a connection string; `supabase/migrations` is a symlink to `db_schema/migrations`, and `--db-url` needs no `supabase link`:

```bash
npx supabase@2.83.0 migration list --db-url "$DATABASE_URL"
npx supabase@2.83.0 db push --dry-run --db-url "$DATABASE_URL"
npx supabase@2.83.0 db push --db-url "$DATABASE_URL"
```

The CLI keeps the same ledger, so `bootstrap.sh` and `db push` continue from each other.

A database whose migrations were applied by hand has no ledger. Record what it already has before the first push, or every file runs again:

```bash
scripts/baseline-migrations.sh --url "$DATABASE_URL" --through <last applied version>
scripts/baseline-migrations.sh --docker supabase-db --through <last applied version>
```

`--dry-run` prints what would be recorded.

### Listener role

The federation worker runs `LISTEN federation_jobs` on a direct, session-mode connection (port 5432, not a transaction pooler) to pick jobs up as they are queued. `harmony_listener` needs nothing beyond `CONNECT`. `bootstrap.sh` runs the equivalent of:

```sql
CREATE ROLE harmony_listener WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE harmony_listener WITH PASSWORD '<password>';
GRANT CONNECT ON DATABASE postgres TO harmony_listener;
```

The backend then gets `FEDERATION_LISTENER_URL=postgresql://harmony_listener:<password>@<host>:5432/postgres`. Without it, the worker picks jobs up through a 60 s sweep.

### Instance domain

`instance_config.domain` must hold the public domain; the link-preview trigger and the web app's ActivityPub ids read it. When `bootstrap.sh` has not set it:

```sql
UPDATE public.instance_config
   SET config_value = to_jsonb('chat.example.com'::text)
 WHERE config_key = 'domain';
```

## Authentication

- **Sign-up**: the self-host stack starts with `DISABLE_SIGNUP=true` in `supabase/.env` until an admin exists. `harmony registration open|invite|closed` sets `DISABLE_SIGNUP` and `instance_config.open_registration` together.
- **Email**: password resets and address confirmation need SMTP (`SMTP_*` in `supabase/.env`; the installer asks). Without it, `ENABLE_EMAIL_AUTOCONFIRM=true` makes accounts usable at sign-up.
- **URLs**: `SITE_URL` is `https://DOMAIN`, `API_EXTERNAL_URL` and `SUPABASE_PUBLIC_URL` are `https://db.DOMAIN`, and `ADDITIONAL_REDIRECT_URLS` includes `https://DOMAIN`.
- **OAuth**: providers enabled in `instance_config` (or `ENABLED_OAUTH_PROVIDERS`), each with its `GOTRUE_EXTERNAL_*` credentials.
- **Logout scope**: GoTrue's `POST /auth/v1/logout` accepts a token without the second factor, and its default `global` scope ends every session of the account. The Supabase API host lets only `?scope=local` through: Caddy does it in the self-host stack, `dev/nginx-auth-logout.template.conf` behind nginx. Other devices are signed out through `public.sign_out_my_sessions()`.

## Storage buckets

| Bucket | Access | Holds |
|---|---|---|
| `avatars`, `banners` | Public | Profile images |
| `server_icons`, `server_banners`, `group-icons` | Public | Server and group images |
| `emojis` | Public | Custom emoji |
| `user_media` | Public | Post media, which ActivityPub delivers by URL |
| `message_media` | Private | Chat attachments |

Members of a channel or conversation read `message_media` objects through signed URLs; other instances read them through the federation backend's `/media` route (`/api/federation/media/` behind the proxy).

Image transforms are served by imgproxy at `/storage/v1/render/image/public/<bucket>/<path>`. A cache in front of that path pins `Accept` (`proxy_set_header Accept "image/webp,*/*;q=0.8";` in nginx); otherwise one client's format is served to every client.

## Database conventions

- Row Level Security is enabled on every table; `get_current_profile_id()` maps the caller's auth user to a profile.
- Permissions are `bigint` bitmasks; `src/services/permissionsService.ts` names the bits.
- `SECURITY DEFINER` functions meant for the backend (for example `queue_federation_job()`) grant `EXECUTE` to `service_role` only. `db_schema/SURFACE.tsv` lists every function PostgREST publishes, with its security mode and grants (`scripts/generate-surface.sh` regenerates it).
- The `supabase_realtime` publication names the tables clients subscribe to; `src/services/RealtimeConnectionManager.ts` manages the subscriptions.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/deployment/supabase.md` and run `npm run docs:generate-guide` to update.
