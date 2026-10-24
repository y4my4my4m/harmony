---
title: Update, back up and restore
description: Update a self-hosted Harmony instance, choose its version, back it up, and restore a backup on the same or a new server.
---

# Update, back up and restore

This page covers keeping an instance current with `harmony update`,
choosing a version or the edge channel, rolling back, taking and scheduling
backups with `harmony backup`, and restoring them with `harmony restore`.
It applies to instances set up with the [installer](/self-host/install).

## Update an instance

Read the "Notes for self-hosters" of each release in the
[changelog](/changelog) first, then run:

```bash
harmony update
```

In order, it:

1. **Fetches the new code** from the git remote and checks out the target
   (see [Choose a version](#choose-a-version)). When the code changed, the
   rest of the update runs from the new `update.sh`, so its steps match the
   new code.
2. **Merges new configuration keys** (`configure.sh --non-interactive`):
   existing values stay, new keys are added. The image tag follows the
   checkout: `X.Y.Z` on tag `vX.Y.Z`, otherwise `edge`.
3. **Downloads the new images**, or builds Harmony's with `HARMONY_BUILD=1`.
   The running instance is untouched so far.
4. **Backs up** the database, the database roles and the configuration into
   `self-host/backups/TIME-OLD-to-NEW/` (no uploads). `HARMONY_SKIP_BACKUP=1`
   skips this, for when a backup was taken another way.
5. **Applies new database migrations** while the old containers keep
   running.
6. **Recreates the containers** whose image or configuration changed, and
   restarts Caddy when the Caddyfile changed.

It ends with a table of the containers and `Update complete (VERSION).`;
then run `harmony doctor`. Nothing in an update deletes volumes, data
directories or backups.

### The apps and an older instance

The desktop and mobile apps update on their own and talk to any instance, so they
can be newer than yours. From 1.9.0 they read what your instance supports from
`/api/federation/instance-info` (`capabilities`) at every start, hide what it
lacks, and tell each user once that some features need a newer version. Updating
the instance brings those features back without anyone reinstalling.

### Choose a version

| Checkout | `harmony update` moves to | Image tag |
|---|---|---|
| A release tag (what the installer picks) | The newest release, `vX.Y.Z` tags without a pre-release suffix | `X.Y.Z` |
| The `master` branch (the edge channel) | The newest commit of `master` | `edge` |
| Another branch | The newest commit of its upstream branch | `edge` |
| A commit that is not a release tag | Nothing: it stops and asks for a target | |

`--version` picks the target:

```bash
harmony update --version 1.7.9    # tag v1.7.9
harmony update --version edge     # the master branch
harmony update --version my-branch
```

The target sets the checkout, and the checkout sets what the next plain
`harmony update` follows: after `--version 1.7.9` the instance is on a
release tag again, so the next update moves to the newest release. To stay
on one version, pass `--version` every time or do not update.

The image workflow publishes `ghcr.io/y4my4my4m/harmony-web`,
`harmony-federation` and `harmony-bot-gateway` for amd64 and arm64: `X.Y.Z`,
`X.Y` and `latest` for each release tag, `edge` and `sha-SHORTHASH` for each
commit to `master`. A release's images appear some minutes after its tag; an
update started before then stops at the image step and can be re-run. Any
checkout that is not on a release tag runs the `edge` images, so code that
differs from `master` needs `HARMONY_BUILD=1`.

`HARMONY_VERSION=TAG harmony update` runs another image tag, for example
`sha-1a2b3c4`, until the next update or configuration run derives it from
the checkout again.

### When an update stops

A failure stops the update at its step and prints
`Update stopped during: STEP` with the state it left. Fix the cause and run
`harmony update` again.

| Step | State |
|---|---|
| `code` | The checkout is unchanged or at the target; no container was touched |
| `configure` | The new code is checked out; containers still run the previous version |
| `images` | Containers still run the previous version; the database is unchanged. Re-run once the images are available |
| `backup` | No migration was applied; containers still run the previous version |
| `migrate` | The database is at the last migration that succeeded; containers still run the previous version. The message names the pre-update backup |
| `restart` | Migrations are applied; some containers may still run old images. Check `docker compose ps` and run `docker compose up -d` in `self-host/` |

### Roll back an update

Migrations are not reversed. Returning to the previous version takes two
steps, in this order:

1. Move the code and images back, to the previous release or to the
   previous commit, which the pre-update backup's name carries
   (`TIME-OLD-to-NEW`, `OLD` being its short hash):

   ```bash
   harmony update --version 1.7.8
   harmony update --version 1a2b3c4
   ```

2. When the database must return too, restore the backup the update took
   (its name ends in `-OLD-to-NEW`). Everything written since that backup is
   lost:

   ```bash
   harmony restore /opt/harmony/self-host/backups/20261012-101500-1a2b3c4-to-5d6e7f8
   ```

Restore applies the migrations of the checked-out code, which is why the
code moves back first.

### Update the Supabase stack

`harmony update` does not replace the upstream Supabase stack in
`self-host/supabase/`. A release can pin a newer commit
(`SUPABASE_REF_DEFAULT` in `configure.sh`); `harmony doctor` then warns
`stack at …, this release pins …`. To move to the pin:

```bash
harmony backup
cd /opt/harmony/self-host
bash configure.sh --refresh-supabase
docker compose up -d
```

The refresh replaces the upstream compose and configuration files and adds
new keys to `supabase/.env`. It never touches `supabase/volumes/db/data` or
`supabase/volumes/storage`, and refuses a commit whose Postgres major
version differs from the existing database's: a major upgrade is a dump and
restore.

## Back up an instance

```bash
harmony backup
```

writes `self-host/backups/YYYYmmdd-HHMMSS/`, readable only by its owner:

| File | Holds |
|---|---|
| `database.dump` | The whole database in `pg_dump` custom format: accounts and sign-in, storage metadata, and all of Harmony's data |
| `roles.sql` | The database roles, with their password hashes, grants and settings (`pg_dumpall --globals-only`) |
| `config.tar` | `.env`, `federation.env`, `bot-gateway.env`, `discord-bridge.env`, `livekit.yaml` and `supabase/.env` (those that exist), and `supabase/pgsodium_root.key`, the key Supabase Vault encrypts its secrets with |
| `storage.tar` | Uploaded files (`supabase/volumes/storage`) with their extended attributes, where Supabase Storage keeps each file's content type. Absent with `--no-storage` |
| `manifest` | `created`, `commit`, `version`, `domain`, `supabase_ref`, `migration` (the newest applied) and `contents` |

`--label TEXT` appends `-TEXT` to the directory name. Other backups land
in the same place: each `harmony update` writes one labelled `OLD-to-NEW`,
and each restore one labelled `pre-restore`, both without uploads.

A backup leaves out Caddy's certificates (Caddy obtains them again), Redis
(queues and caches), the Discord bridge host's data volume, the Docker
images, and the code and upstream Supabase files, which the `manifest`
records and `configure.sh` fetches.

### Copy backups off the server

A backup holds every secret of the instance, and a backup on the same disk
does not survive the loss of that disk. Copy it off the server, for example
from your computer:

```bash
scp -r root@your-server:/opt/harmony/self-host/backups ./harmony-backups
```

### Schedule backups

Nothing schedules backups. `harmony doctor` warns when the newest is more
than 7 days old. A daily backup at 04:00, as a root cron job (`crontab -e`):

```text
0 4 * * * /opt/harmony/self-host/harmony backup >/var/log/harmony-backup.log 2>&1
```

Schedule the copy off the server too.

### Delete old backups

Nothing deletes backups, and every update adds one. Delete old directories
in `self-host/backups/` yourself, along with the `restore-TIME.log` files
restores leave there. `harmony doctor` fails its `disk` check under 1 GB
free.

## Restore a backup

```bash
harmony restore /opt/harmony/self-host/backups/20261007-040000
```

The argument is a backup directory, a tar archive of one, or a bare
`database.dump` (database only; the configuration and uploads stay). The
command shows the backup's `manifest` and what it replaces, and asks to
confirm; `--yes` skips the question.

In order, it:

1. **Backs up the current database and configuration** (label
   `pre-restore`, no uploads).
2. **Restores the configuration** from `config.tar`, when the backup has
   one, then runs `configure.sh`, which fetches the Supabase stack on a new
   server and keeps every restored value.
3. **Stops the stack** and **moves the current data aside**:
   `supabase/volumes/db/data` to `data.before-restore-TIME`, and, when the
   backup has uploads, `supabase/volumes/storage` to
   `storage.before-restore-TIME`. Nothing is deleted.
4. **Restores the Vault key**, so the secrets Supabase Vault holds decrypt.
5. **Starts a fresh database**, restores the roles, then loads the dump.
   `pg_restore` reports some errors on objects Supabase owns on every
   restore; the command filters those out and warns about any others.
6. **Restores the uploads** from `storage.tar`, when present.
7. **Applies newer migrations** of the installed code, starts everything and
   restarts the federation worker.

Details go to `self-host/backups/restore-TIME.log`. When the restored
instance works, remove the moved-aside directories; the command prints the
`rm -rf` line for them.

### Move to a new server

1. Install Harmony on the new server with the same domain, at the same
   version as the old one or newer. While DNS still points at the old
   server, choose **3** (continue anyway) at the installer's DNS step.
2. Take a backup on the old server. Anything written there after it stays
   behind.
3. Copy the backup directory to the new server.
4. Run `harmony restore` on it. The configuration comes from the backup, so
   the answers given to the installer are replaced.
5. Point the DNS records at the new server. Caddy obtains certificates once
   they resolve; `harmony doctor` shows when.
