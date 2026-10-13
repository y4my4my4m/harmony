---
title: Install Harmony
description: Install a Harmony instance on a Linux server with one command, including DNS, the installer's questions, scripted and LAN installs, the admin account and registration.
---

# Install Harmony

This guide installs a Harmony instance on a Linux server with the
one-command installer, `self-host/install.sh`. It covers the DNS records,
every question the installer asks, what it does, scripted and LAN installs,
and the first steps after it finishes. [Self-host Harmony](/self-host/#what-you-need)
lists what the server needs.

## Create the DNS records {#dns}

At your DNS provider, create these records with your server's public IPv4
address (shown in your provider's dashboard, or by `curl -4 ifconfig.me` on
the server). The examples use `chat.example.com` as the domain:

| Type | Name | Value | For |
|---|---|---|---|
| A | `chat.example.com` | the server's IPv4 address | The app and federation |
| A | `db.chat.example.com` | the server's IPv4 address | Sign-in, data and uploads (the Supabase API) |
| A | `live.chat.example.com` | the server's IPv4 address | Voice and video; skip it if you turn voice off |

- Use your own name in place of `chat.example.com`. A bare domain such as
  `example.com` works too; the other two names then become `db.example.com`
  and `live.example.com`.
- With an IPv6 address on the server, add matching AAAA records, or none.
  Let's Encrypt tries IPv6 first, so an AAAA record that points elsewhere, or
  exists while the server has no public IPv6, makes certificate issuance fail.
- With Cloudflare, set the records to **DNS only** (grey cloud) while the
  certificates are issued.
- DNS changes take minutes to an hour to propagate. The installer checks the
  A records and shows what is still missing.

## Run the installer

Log in to the server as root and run:

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
```

Logged in as another user, pipe it to `sudo bash` instead. From a checkout
of the repository, `bash self-host/install.sh` installs that checkout in
place.

The questions read the terminal directly (`/dev/tty`), so they work under
`curl | bash`. Press Enter to accept the default shown in brackets.

## What the installer does

In order:

1. **Checks the host.** Linux on x86_64 or arm64; `tar`, `awk`, `sed` and
   `getent` present; `git`, `curl` and `openssl` present or, as root and with
   your consent, installed with the package manager (apt, dnf, yum, apk,
   pacman or zypper).
2. **Checks Docker.** When Docker is missing it offers, as root, to install
   it with the official script from `https://get.docker.com` and enables the
   service. It then requires a running daemon the current user may use and
   the Compose plugin 2.24.4 or later.
3. **Checks memory.** It warns under about 2 GB of RAM. With no swap and
   under 4 GB of RAM it offers to create a 2 GB `/swapfile` and adds it to
   `/etc/fstab`.
4. **Downloads Harmony** into `/opt/harmony`: the newest release that ships
   the installer (release tags `vX.Y.Z`, pre-releases excluded), else the
   default branch. It stops with under 4 GB free there and warns under 10 GB.
   An existing checkout in that directory is used as it is.
5. **Asks the questions** below.
6. **Checks the ports**: 80/tcp and 443/tcp, plus 7881/tcp and 7882/udp with
   voice on, must be free. Ports Harmony's own containers already hold do not
   count.
7. **Checks DNS**: each name must have an A record pointing at the server's
   public IPv4 address. See [When DNS is not ready](#when-dns-is-not-ready).
8. **Shows the settings** and asks to confirm.
9. **Writes the configuration** with `configure.sh`: the `.env` files,
   `livekit.yaml`, and the Supabase stack in `self-host/supabase/`, with
   fresh random secrets.
10. **Downloads the images and starts the stack**; several GB on a first run.
11. **Loads the database** with `bootstrap.sh`: applies the migrations,
    creates the `harmony_listener` role and, on a new database, writes the
    domain and instance name. It then waits for `auth`, `rest`, `kong` and
    `federation-server` to report healthy.
12. **Creates the admin account.** Sign-up stays closed until it exists.
13. **Applies the registration policy.**
14. **Links the `harmony` command** to `/usr/local/bin/harmony` (as root,
    unless that path holds something other than a link).
15. **Prints a summary**, then runs `harmony doctor`.

## The questions

| Question | Meaning | Default |
|---|---|---|
| Domain for your instance | The domain from the DNS records, such as `chat.example.com`. Handles look like `@you@chat.example.com`, and other servers keep it in your ids: choose it once | the current one on a re-run |
| Admin email | Your login. Also the contact Let's Encrypt and push services see | the current one on a re-run |
| Admin username | Your handle: 3 to 24 characters of `a-z`, `0-9` and `_`. Not asked when an admin exists | the email's local part, reduced to those characters; `admin` when that leaves fewer than 3 |
| Admin password | 8 characters or more, asked twice. Not asked when an admin exists | Enter generates one, shown once in the summary |
| Instance name | Shown in the app. It cannot contain `$`, `#`, `"`, `\` or a backtick, or start with a quote; the admin panel accepts any name later | `Harmony` |
| Enable voice and video? | Voice channels, calls and screen sharing (LiveKit). Needs the `live.` record and ports 7881/tcp and 7882/udp | `y` |
| Enable bots? | The bot gateway, for bots and Discord bridges | `n` |
| Host Discord bridges on this server? | Asked when bots are on. Communities paste their Discord bot token into Harmony and this server runs their bridge; see [Discord bridges](/self-host/discord-bridges) | `n` |
| Set up email (SMTP) now? | Then: SMTP server, SMTP port, SMTP username, SMTP password, sender address. Without it, accounts work but nobody can reset a forgotten password; see [Email](/self-host/email) | `n`; port `587`, sender `noreply@` your domain |
| Registration | `open`: anyone can sign up. `invite`: only people you invite. `closed`: no new accounts | `open` |

On a re-run, every default is the current configuration. The installer
does not ask about TLS: it uses Let's Encrypt unless you choose a LAN
install at the DNS step or set `HARMONY_TLS=internal`.

## When DNS is not ready

When a name has no A record or points elsewhere, the installer lists the
records to create and offers:

```text
   1) I've created the records, check again (DNS can take a few minutes)
   2) This is a LAN / internal server: use Caddy's own certificates (no Let's Encrypt)
   3) Continue anyway; certificates follow once DNS is right
   4) Quit
```

Option 3 installs anyway; Caddy obtains the certificates once the records
point at the server, and `harmony doctor` shows when they do. Without a
terminal, the installer continues as with option 3. Option 2 switches to a
[LAN install](#install-on-a-lan).

## After the installer finishes

The summary shows the URL, the admin login and password, the registration
policy and where the secrets live. **Store the password now**: it is shown
once. `harmony admin reset-password` sets a new one if it is lost.

Open the firewall, if the server has one. The installer does not touch it:

```bash
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw allow 7881/tcp && ufw allow 7882/udp     # voice and video
```

Many providers also have a firewall in their dashboard; open the same ports
there.

Then check the instance:

```bash
harmony doctor
```

The installer already ran it once. Each line is OK, WARN or FAIL with a fix;
[the harmony command](/self-host/cli#harmony-doctor) lists every check.

## Sign in and open the admin panel

Open `https://chat.example.com` and sign in with the admin email and
password. The admin panel is in **User settings** → **Instance admin**
(`https://chat.example.com/admin`). Its tabs are **Overview**,
**Federation**, **Users**, **Retention**, **Reports**, **Anti-spam**,
**Content**, **Emojis**, **Config**, **Funding** and **Tools**. The instance
name, description, rules, icon and legal links are under **Config** →
**Branding**.

Instance moderators see the same entry as **Instance moderation**, with the
**Federation**, **Users**, **Reports** and **Anti-spam** tabs.

## Add more admins

```bash
harmony admin create --email friend@example.com --username friend
```

This creates the account with its address confirmed, sets up its profile and
makes it an instance admin. Without `--password` it asks for one, or
generates and prints one. An account that already exists becomes an admin
and keeps its password. [harmony admin create](/self-host/cli#harmony-admin-create)
has every option.

## Choose who can register

```bash
harmony registration open      # anyone can create an account
harmony registration invite    # only people you invite
harmony registration closed    # no new accounts
```

| Policy | Sign-up (`DISABLE_SIGNUP` in `supabase/.env`) | `instance_config.open_registration` |
|---|---|---|
| `open` | on | `true` |
| `invite` | off | `false` |
| `closed` | off | `false` |

The command records the policy as `REGISTRATION` in `self-host/.env`,
updates both settings and restarts the auth service. `open` refuses to run
before an admin account exists. With sign-up off, new accounts through OAuth
providers are refused too. NodeInfo advertises the policy to other servers
(`openRegistrations`).

### Invite someone

With `invite`, each invitation is a single-use link:

```bash
harmony admin invite friend@example.com           # prints the link; send it yourself
harmony admin invite friend@example.com --send    # emails it (needs SMTP)
```

The link signs the person in on Harmony's password page
(`/reset-password`), where they choose a password; they then pick a
username.

## Install without prompts {#scripted-installs}

Without a terminal, or with `--non-interactive`, every answer comes from the
environment. Changes to the host (Docker, packages, swap) happen only when
their variable is `y`.

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | \
  HARMONY_DOMAIN=chat.example.com \
  HARMONY_ADMIN_EMAIL=you@example.com \
  HARMONY_ADMIN_USERNAME=you \
  HARMONY_INSTANCE_NAME="Example Chat" \
  HARMONY_VOICE=y HARMONY_BOTS=n HARMONY_REGISTRATION=invite \
  HARMONY_INSTALL_DOCKER=y \
  bash -s -- --non-interactive
```

Answers:

| Variable | Meaning | Default |
|---|---|---|
| `HARMONY_DOMAIN` | The instance's domain | required |
| `HARMONY_ADMIN_EMAIL` | Admin login, Let's Encrypt and push contact | required |
| `HARMONY_ADMIN_USERNAME` | Admin handle | the email's local part |
| `HARMONY_ADMIN_PASSWORD` | Admin password, 8 characters or more | generated, printed in the summary |
| `HARMONY_INSTANCE_NAME` | Instance name | `Harmony` |
| `HARMONY_VOICE` | `y` or `n`: voice and video | `y` |
| `HARMONY_BOTS` | `y` or `n`: bot gateway | `n` |
| `HARMONY_DISCORD` | `y` or `n`: Discord bridge hosting; `y` turns bots on | `n` |
| `HARMONY_REGISTRATION` | `open`, `invite` or `closed` | `open` |
| `HARMONY_SMTP_HOST` | SMTP server; setting it configures email | unset: no email |
| `HARMONY_SMTP_PORT` | SMTP port | `587` |
| `HARMONY_SMTP_USER`, `HARMONY_SMTP_PASS` | SMTP login | empty |
| `HARMONY_SMTP_SENDER` | From address | `noreply@` the domain |
| `HARMONY_TLS` | `acme` (Let's Encrypt) or `internal` (Caddy's own CA) | `acme` |

Host and source:

| Variable | Meaning | Default |
|---|---|---|
| `HARMONY_DIR` | Install directory | `/opt/harmony` |
| `HARMONY_REPO` | Git URL to clone | `https://github.com/y4my4my4m/harmony.git` |
| `HARMONY_REF` | Tag or branch of a new checkout. An existing checkout stays as it is; `harmony update --version` moves it | the newest release that ships the installer, else the default branch |
| `HARMONY_VERSION` | Image tag | derived from the checkout: `X.Y.Z` on tag `vX.Y.Z`, otherwise `edge` |
| `HARMONY_BUILD=1` | Build Harmony's images on the server instead of downloading them | off |
| `HARMONY_HTTP_PORT`, `HARMONY_HTTPS_PORT` | `[address:]port` Caddy publishes for 80 and 443 | `80`, `443` |
| `HARMONY_PUBLIC_IP` | The server's public IPv4, when the installer cannot look it up | looked up |
| `HARMONY_NONINTERACTIVE=1` | Same as `--non-interactive` | off |

Consent and extras:

| Variable | Effect |
|---|---|
| `HARMONY_INSTALL_DOCKER=y` | Install Docker with `https://get.docker.com` when missing |
| `HARMONY_INSTALL_PACKAGES=y` | Install missing `git`, `curl`, `openssl` |
| `HARMONY_CREATE_SWAP=y` | Create a 2 GB `/swapfile` when RAM is under 4 GB and there is no swap |
| `HARMONY_CLI_LINK=n` | No `/usr/local/bin/harmony` link |
| `HARMONY_SKIP_DOCTOR=1` | No `harmony doctor` run at the end |

Options:

| Option | Same as |
|---|---|
| `--dir DIR` | `HARMONY_DIR=DIR` |
| `--ref REF` | `HARMONY_REF=REF` |
| `--non-interactive` | `HARMONY_NONINTERACTIVE=1` |
| `-h`, `--help` | Prints the installer's built-in help |

In a non-interactive run, the installer stops when a required answer is
missing or invalid, or when a port is in use; it continues past DNS records
that are not ready.

## Install on a LAN

For a server on your home network without public DNS, choose **2** at the
DNS step or set `HARMONY_TLS=internal`. Caddy then signs certificates with its
own certificate authority instead of Let's Encrypt (`CADDY_TLS=internal` in
`self-host/.env`).

- Each device resolves the three names to the server: a local DNS server,
  your router's DNS, or `/etc/hosts` entries.
- Browsers warn until each device trusts Caddy's root certificate. Copy it
  off the server and install it as a trusted root:

  ```bash
  cd /opt/harmony/self-host
  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt harmony-root.crt
  ```

- Such an instance federates only with servers that reach it and trust its
  certificates.
- `harmony doctor` reports DNS problems as WARN instead of FAIL, and checks
  the federation endpoints through the server's own port.
- Voice on a LAN needs LiveKit's address set by hand; see
  [Voice and video](/self-host/voice).

## Re-run the installer

The installer is safe to re-run, with the same command or `harmony install`:
it keeps the configuration, secrets, data and admin account, and uses the
current answers as defaults. It does not update the code; `harmony update`
does. Re-run it to repair an installation, or use `harmony config` to change
answers.

## Install a specific version or a fork

- A release: `--ref v1.7.9` (or `HARMONY_REF=v1.7.9`). The image tag follows
  the checkout: `1.7.9` on tag `v1.7.9`.
- The edge channel: `--ref master`. The image tag is `edge`, which the image
  workflow publishes from master.
- A fork: `HARMONY_REPO=https://github.com/you/harmony.git` and
  `HARMONY_BUILD=1`, since the published images carry upstream's code.

Release images appear some minutes after their tag; an install started
before then stops at the image download and can be re-run.

## Uninstall

This deletes the instance and its data. Back up first if anything should
survive, and move the backup off the server.

```bash
cd /opt/harmony/self-host
harmony backup                  # optional
docker compose down -v          # containers, networks, Caddy certificates, Redis, the Vault key
cd / && rm -rf /opt/harmony     # code, configuration, database, uploads, backups
rm -f /usr/local/bin/harmony
```

`docker image ls` lists the downloaded images; `docker image rm` removes them.
