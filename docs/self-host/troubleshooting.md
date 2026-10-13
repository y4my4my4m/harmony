---
title: Troubleshooting
description: Causes and fixes for common problems on a self-hosted Harmony instance, the messages of its installer and harmony command, and its security checks.
---

# Troubleshooting

This page lists problems on a self-hosted instance with their causes and
fixes: symptoms first, then the messages the installer and the `harmony`
command print, then what a failing security check means. Messages are
quoted as the scripts print them; `…` stands for a variable part.

## Start here

```bash
harmony doctor            # every check, each with a fix
harmony status            # versions, profiles, container states
harmony logs SERVICE      # one service's log; federation, supabase for groups
```

[The harmony command](/self-host/cli#harmony-doctor) describes every check
`harmony doctor` runs.

## Symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| The installer says a port is in use | Another web server holds 80 or 443 | `ss -ltnp 'sport = :80'` names it. Stop and disable it (`systemctl disable --now nginx apache2`), or [put Caddy behind it](/self-host/docker-compose#behind-another-reverse-proxy) |
| The browser shows a certificate error | A record missing or pointing elsewhere, an AAAA record that does not match, or ports 80 and 443 closed to the internet, so Let's Encrypt cannot validate | The DNS and TLS rows of `harmony doctor`, then `harmony logs caddy` |
| On a LAN install, browsers warn about the certificate | Devices do not trust Caddy's own certificate authority | Install its root certificate on each device; see [Install on a LAN](/self-host/install#install-on-a-lan) |
| The page loads, sign-in fails | The `db.` record missing or pointing elsewhere, or the auth service down | The `auth` row and the DNS rows of `harmony doctor`; `harmony logs auth` |
| Nobody can create an account | Registration is `invite` or `closed`, or no admin exists yet (sign-up stays closed until one does) | `harmony registration open`; `harmony admin create` first when there is no admin |
| Other servers cannot find your users | Federation endpoints unreachable from outside | The Federation rows of `harmony doctor`; `harmony logs federation` |
| Messages and posts reach other servers late | No `harmony_listener` role: the worker logs `No listener DB connection set` and picks jobs up through a 60-second sweep | `bash bootstrap.sh && docker compose restart federation-worker` in `self-host/` |
| Calls connect but nobody hears anything | UDP 7882 or TCP 7881 blocked at a firewall, or LiveKit announcing a wrong address | The `media tcp` and `media udp` rows of `harmony doctor`; `harmony logs livekit`; [Voice and video](/self-host/voice) |
| Password reset emails never arrive | No SMTP server, or the provider blocks outgoing 25 and 587 | The `email` row of `harmony doctor`; `harmony logs auth`; [Email](/self-host/email) |
| Push notifications never arrive | VAPID keys missing or not served | The `push` row of `harmony doctor`; [Push notifications](/self-host/push) |
| The proxy answers 502 | The federation server is down or unhealthy | `docker compose ps` (it reports `healthy` once `/health` answers 200); `docker exec harmony-caddy wget -qO- http://federation-server:3001/health`; `harmony logs federation-server` |
| Services restart in a loop; `docker compose ps` shows `Exited (137)` | The kernel killed them for lack of memory | Add swap or memory; the `memory` row of `harmony doctor` |
| Forgot the admin password | | `harmony admin reset-password --email you@example.com` |
| `harmony doctor` warns `no admin account` | No admin was created, for example after an interrupted install | `harmony admin create` |
| An update stopped | Its last lines name the step and the state | Fix the cause and run `harmony update` again; see [When an update stops](/self-host/update-backup#when-an-update-stops) |
| `harmony doctor` fails under Security | See [Security checks](#security) | |

## Installer messages

| Message | Cause | Fix |
|---|---|---|
| `the installer runs on Linux (a VPS, a home server, a VM)…` | Another operating system | Use a Linux server or VM |
| `no prebuilt images for … (amd64 and arm64 only)…` | Another CPU architecture | `HARMONY_BUILD=1` builds Harmony's images on the server, if Supabase's run there |
| `… is missing; this installer expects a standard Linux userland` | `tar`, `awk`, `sed` or `getent` absent | Install it with the package manager |
| `missing: …. Install them (e.g. apt-get install -y …) and re-run` | `git`, `curl` or `openssl` absent, and not root or not accepted | Install them, or re-run as root and accept; `HARMONY_INSTALL_PACKAGES=y` without a terminal |
| `Docker is required: https://docs.docker.com/engine/install/ (or re-run as root and accept the install)` | Docker absent, and not root or not accepted | Re-run as root and accept, or `HARMONY_INSTALL_DOCKER=y` without a terminal |
| `this user cannot use Docker; run the installer as root (… \| sudo bash) or join the docker group` | Permission denied on the Docker socket | Run as root, or add the user to the `docker` group |
| `the Docker daemon is not running; start it (systemctl start docker) and re-run` | Docker installed but stopped | `systemctl start docker` |
| `the Docker Compose plugin is missing…` | Docker without `docker compose` | Install `docker-compose-plugin` (Docker's repository) or `docker-compose-v2` (Ubuntu), or reinstall Docker with `https://get.docker.com` |
| `Docker Compose … is too old; 2.24.4 or later is required (upgrade docker-compose-plugin)` | An old Compose plugin | Upgrade it |
| `… MB free on …; the images alone take about 4 GB` | Under 4 GB free where Harmony goes | Free space, or install elsewhere with `HARMONY_DIR` |
| `not enough disk space for a swap file` | Under 6 GB free on `/` when creating `/swapfile` | Free space, or decline the swap file |
| `… exists and is not a Harmony checkout; choose another directory: HARMONY_DIR=/path (or --dir)` | `/opt/harmony` holds something else | Choose another directory, or empty it |
| `cannot write to …: run the installer as root (curl ... \| sudo bash) or set HARMONY_DIR to a directory of yours` | Not root | Run as root, or `HARMONY_DIR` in your home directory |
| `… predates this installer; update it first: cd …/self-host && bash update.sh` | An older checkout in the install directory | Run that update, then the installer |
| `no tag or branch … in …` | `HARMONY_REF` or `--ref` names nothing in the repository | Check the tag or branch name |
| `HARMONY_DOMAIN is required…`, `HARMONY_ADMIN_EMAIL is required`, `HARMONY_ADMIN_USERNAME must be 3-24 characters of a-z, 0-9 and _`, `HARMONY_ADMIN_PASSWORD needs at least 8 characters`, `HARMONY_REGISTRATION is open, invite or closed`, `HARMONY_TLS is acme or internal` | A non-interactive run with a missing or invalid answer | Set the variable; see [Install without prompts](/self-host/install#scripted-installs) |
| `port(s) … are in use by another program…` | Another program holds 80/tcp, 443/tcp, or with voice 7881/tcp or 7882/udp | Stop it (often `systemctl disable --now nginx apache2`), or [put Caddy behind it](/self-host/docker-compose#behind-another-reverse-proxy) |
| `stopped; re-run the installer when DNS is ready` | Quit at the DNS step | Create the records and re-run |
| `stopped; nothing was changed` | Declined the settings summary | Re-run |
| `the instance name cannot contain $ # " \ or a backtick, or start with a quote…` | The name would break the `.env` files | Choose a plainer name now; the admin panel accepts any name later |
| `cannot pull …. A release's images appear some minutes after its tag…` | The images for this version are not published yet, or the registry is unreachable | Wait and re-run; `HARMONY_VERSION` selects another tag; `HARMONY_BUILD=1` builds them |
| `… did not become healthy: harmony logs …` | `auth`, `rest`, `kong` or `federation-server` failed to start within 3 minutes | `harmony logs` for that service; memory (`harmony doctor`) |

## Configuration and database messages

`configure.sh` and `bootstrap.sh` run during installs, updates and restores.

| Message | Cause | Fix |
|---|---|---|
| `supabase/volumes/db/data holds a database, but supabase/.env has no JWT_SECRET/POSTGRES_PASSWORD…` | `supabase/.env` was lost or emptied; new secrets would lock the database out | Restore `supabase/.env` from a backup (`config.tar`) |
| `could not fetch … from https://github.com/supabase/supabase (network, or no such commit/tag/branch)` | No access to GitHub, or a wrong `SUPABASE_REF` | Check the network and `SUPABASE_REF` |
| `… runs Postgres …; the database in supabase/volumes/db/data is Postgres … and would not start…` | A refresh to a Supabase stack with another Postgres major version | Stay on the pinned commit; `supabase/` is unchanged |
| `docker compose rejects the configuration above (Compose …)` | An edited file Compose cannot parse, or an old Compose | Read the error above it; check hand edits to the `.env` files |
| `… failed. It was not recorded; later migrations were skipped.` then `migration failed - database is at the last migration that succeeded` | A migration hit an SQL error; the lines after it show the `ERROR` | Read the error, `harmony logs db`; re-run once fixed. Report it if the error comes from the migration itself |
| `Postgres in … did not become ready within 180 s…` | The database container is not starting | `harmony logs db`; disk space and memory |
| `no role can modify the schema: tried postgres and supabase_admin` | Neither role can connect inside the container | `harmony logs db` |
| `app.settings.jwt_secret kept: read by …` (warning) | A function reads the JWT secret from the database settings | Read the named functions; the `jwt secret` check stays WARN while it is kept |

## Update messages

| Message | Cause | Fix |
|---|---|---|
| `the checkout is detached at …; set the target: harmony update --version X.Y.Z` | The checkout sits on a commit that is not a release tag | `harmony update --version X.Y.Z`, or `--version edge` |
| `branch … tracks no remote branch; set the target: harmony update --version X.Y.Z` | A local branch without an upstream | Pass `--version` |
| `git could not fast-forward … (local commits or changes to tracked files…)` | Edits to files git tracks in the checkout | `git -C /opt/harmony status` shows them; undo them. Instance settings belong in the `.env` files, which git ignores |
| `git could not switch to branch … (local changes to tracked files?…)`, `git could not check out …` | Same | Same |
| `branch … has diverged from …; reconcile it by hand` | Local commits on the branch | Reset or rebase the branch by hand |
| `… is no branch, tag or commit of origin` | `--version` names nothing | Check the version; release `X.Y.Z` means tag `vX.Y.Z` |
| `Update stopped during: …` | A step failed | [When an update stops](/self-host/update-backup#when-an-update-stops) lists each state |

## Admin and registration messages

| Message | Cause | Fix |
|---|---|---|
| `not installed yet: …/harmony install` | No `self-host/.env` | `harmony install` |
| `federation-server is not running; start the stack: docker compose up -d` | `harmony admin` runs its calls inside that container | `docker compose up -d` in `self-host/` |
| `instance_config.domain is not set yet; run bootstrap.sh first` | The database was never bootstrapped | `bash bootstrap.sh` in `self-host/` |
| `the username … belongs to another account` | Another local profile has it | Choose another `--username` |
| `no admin exists yet; create one first (harmony admin create), then open registration` | `harmony registration open` before an admin exists | `harmony admin create` first |
| `--send needs SMTP (harmony config); without it, send the printed link yourself` | `harmony admin invite --send` without SMTP | Set up [email](/self-host/email), or send the printed link |
| `no such account` | `reset-password` found no account with that email or local username | Check the address or username |
| `the passwords differ` | The two entries did not match | Run it again |
| `harmony config asks questions; for scripted changes run: HARMONY_...=... bash configure.sh --non-interactive` | `harmony config` without a terminal | Run it in a terminal, or script `configure.sh` as [shown](/self-host/cli#harmony-config) |

## Backup and restore messages

| Message | Cause | Fix |
|---|---|---|
| `pg_dump failed; no backup written`, `pg_dump wrote nothing; no backup written` | The database did not answer, or the disk is full | `harmony logs db`; free space |
| `Postgres did not become ready within 240 s; check: docker compose logs db` | The database container is not starting | `harmony logs db` |
| `restore replaces the running instance's data; pass --yes to confirm` | `harmony restore` without a terminal | Add `--yes` |
| `a database-only backup needs a configured install; run harmony install first` | Restoring a bare `.dump` on a server without configuration | Install first, then restore |
| `… holds no database.dump`, `… is not a backup directory, a tar archive of one, or a .dump file` | The argument is not a backup | Point at the backup directory |
| `pg_restore errors beyond the expected ones (details in …)` (warning) | The dump loaded with errors beyond the ones on Supabase-owned objects | Read the log it names; `harmony doctor` |
| `the restored database has no migration ledger; see …. The previous data is in: …` | The dump did not load | Read the log; the previous database and uploads are kept under the names printed |
| `could not write the Vault key into the db-config volume` | The database image could not run to write the key | `harmony logs db` |
| `could not extract uploads; the database is restored` | `storage.tar` could not be unpacked | Check disk space, then run the restore again |

## Domain mismatch {#domain-mismatch}

`harmony doctor` fails `domain` when `instance_config.domain` in the
database differs from `DOMAIN` in `self-host/.env`. Handles and ActivityPub
ids then disagree. `bootstrap.sh` writes the database value only on a new
database, so it does not follow a later change of `DOMAIN`.

Make the two equal. To put `.env` back to the database's domain:

```bash
cd /opt/harmony/self-host
HARMONY_DOMAIN=chat.example.com bash configure.sh --non-interactive
docker compose up -d
```

To change the database's value instead, as `supabase_admin`
(`docker compose exec db psql -U supabase_admin -h 127.0.0.1 -d postgres`):

```sql
UPDATE public.instance_config SET config_value = to_jsonb('chat.example.com'::text)
 WHERE config_key = 'domain';
```

Other servers keep the domain in the ids of every account and post they
know, so an instance that has federated keeps its domain.

## Security checks {#security}

The Security section of `harmony doctor` looks for the traces of a known
automated attack on exposed Postgres, which plants an event trigger whose
function creates a superuser the next time an administrator changes the
schema, and for the exposure that lets it in.

A failing `event triggers`, `superusers` or `login roles` check means the
database may be compromised, unless you created the object yourself. Then:

1. Stop publishing the port that let it in. The `published` and `reachable`
   checks name it; remove its `ports:` entry and block it at the provider's
   firewall. Ports published by Docker bypass `ufw` and `firewalld`.
2. Restore a backup taken before the object appeared (`harmony restore`).
3. [Change the secrets](#change-supabase-s-example-secrets).

The SQL the fixes name runs as `supabase_admin`, in `self-host/`:

```bash
docker compose exec db psql -U supabase_admin -h 127.0.0.1 -d postgres
```

The WARN checks:

- `functions`: read each listed function with `\sf NAME` in psql and drop
  any you did not write.
- `extensions`: drop the listed extensions unless you need them
  (`DROP EXTENSION NAME`).
- `jwt secret`: `bash bootstrap.sh --migrations-only` removes the database
  default; `harmony update` brings the override that stops PostgREST from
  setting it.
- `other containers`: containers outside Harmony publish database-type
  ports; bind them to 127.0.0.1 or stop them.

### Change Supabase's example secrets {#change-supabase-s-example-secrets}

`configure.sh` generates every secret on a new install. The `secrets` check
fails when `supabase/.env` still holds Supabase's example value (or nothing)
for one of these. Change it in `self-host/supabase/.env`:

- `DASHBOARD_PASSWORD`: set a random value (`openssl rand -hex 16`), then
  `docker compose up -d`.
- `JWT_SECRET`: set a random value of at least 32 characters
  (`openssl rand -base64 48`), then
  `bash configure.sh --non-interactive && docker compose up -d`.
  `configure.sh` re-signs the anon and service keys with it and writes them
  to every file that holds them. Everyone signs in again.
- `POSTGRES_PASSWORD`: it is the password of `postgres`, `supabase_admin`,
  `authenticator`, `pgbouncer`, `supabase_auth_admin`,
  `supabase_functions_admin` and `supabase_storage_admin`. As
  `supabase_admin` in psql, run `ALTER ROLE NAME PASSWORD 'NEW';` for each,
  set the same value in `supabase/.env`, then `docker compose up -d`.
