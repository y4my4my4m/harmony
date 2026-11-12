---
title: Migrate from Discord
description: Move a Discord community to Harmony. Members link their Discord account, join with their roles, and Harmony follows Discord until you finish the migration.
---

# Migrate from Discord

This page is for Harmony server owners and members with the Manage Server permission who are moving a community from Discord. In **Server settings** → **Migrate from Discord** you connect the Discord server, match its roles to Harmony roles and open a link. Members who follow the link sign in with Discord, create or link a Harmony account, join your server and receive the Harmony roles that match their Discord roles. While the migration is open, Harmony follows Discord. When you are done with Discord, you finish the migration and Harmony alone decides.

The migration moves people, not content. It does not copy channels, roles or messages. Instance operators who want to control account creation read [Hosting Discord bridges](/self-host/discord-bridges#migrate-from-discord).

## Before you start

1. **Clone your Discord server into the Harmony server.** Channels, categories and roles have to exist on Harmony first. With the [Discord bridge](/run/discord-bridge) connected, run `/bridge clone-server` and then `/bridge sync-perms` in Discord. You can also build the roles by hand.
2. **Have a Discord bot in the Discord server.** The migration reads members and roles through a bot. It needs no privileged intents. To tell a ban from a removal it also needs **Ban Members**; without it, members banned on Discord count as removed, and the page tells you so.

## Choose where the Discord bot comes from

The **Where the Discord bot comes from** card offers the options your server can use.

| Option | What you do | Offered when |
|---|---|---|
| **This instance's Discord bot** | Invite the instance's bot to your Discord server | The operator set up the instance bot |
| **This server's hosted bridge bot** | Nothing. The migration reuses your bridge's bot token | The server has a bridge that runs on this instance |
| **My own Discord application** | Create an application and bot in the Discord Developer Portal, and paste its **Client ID**, **Client secret** and **Bot token** | Always |

The first two reference the stored bot live, so a token rotation carries over. If the instance bot is turned off or the bridge is removed, the migration pauses until you choose another source. For the hosted bridge, you still enter the client secret of the bridge's application.

Whichever you pick, enter the **Discord server ID** (in Discord, turn on Developer Mode, right-click the server and choose **Copy Server ID**) and click **Save**. The ID is prefilled from your bridge when there is one. It cannot change once the migration is open.

### The redirect address

Members sign in to Discord through your Discord application, so the application has to accept this return address. In the Developer Portal, open **OAuth2**, click **Add Redirect**, paste the **Redirect address** the page shows, and save. It has the form:

```text
https://<your instance>/bot-gateway/bridge/v2/migrate/callback
```

It is the same address for every server on the instance and has to match exactly. This holds for every source, including this instance's own Discord bot: that application needs this redirect in addition to the `…/bridge/v2/discord/callback` one it already has for the bridge. Without it Discord answers "Invalid OAuth2 redirect_uri" when a member signs in. The page repeats the address next to **Open migration**, and Open stays disabled until you tick **I added it**. The migration asks Discord for the `identify` scope only: a member's Discord username and profile, never their email or servers.

Secrets are stored encrypted and are never shown again; leave a field empty to keep the saved value.

## Map the roles

Click **Fetch from Discord**. Harmony reads the Discord server's roles and the page lists each one with a dropdown of your Harmony roles. Roles that share a name with a Harmony role are filled in for you, marked **Matched by name**; **Accept matches** saves them.

- **Every Discord role has to map to a Harmony role.** There is no "ignore" choice. A role you do not want to carry over should be deleted on Discord before you migrate, or on Harmony after. A counter shows how many roles still need a match, and you cannot open the migration until it reaches zero.
- Roles Discord manages (bot and integration roles, Server Booster) and `@everyone` are never shown or mapped.
- **Discord owns mapped roles while the migration is open.** A linked member's mapped Harmony roles always match their Discord roles, including roles you granted by hand on Harmony. Harmony roles you leave unmapped are never touched.
- You can map only roles below your own top role. The owner can map any role.

### Apply Discord permissions

A bridge bot can give a cloned Harmony role only the permissions of `@everyone` plus the bot's own install flags. `/bridge clone-server` and `/bridge sync-perms` therefore leave Kick Members, Ban Members, Manage Messages, Manage Nicknames, Pin Messages and Administrator off the cloned roles. Your moderators would arrive with their role but without its powers.

For each mapped role whose Harmony version lacks permissions the Discord role has, the page lists what is missing and offers **Apply Discord permissions** per role, and **Apply all**.

- Applying only adds permissions. It never removes one the Harmony role has and the Discord role lacks.
- It runs as you, under Harmony's ordinary role rules: you can change only roles below your top role (the owner any), and give only permissions you hold. Having Administrator counts as holding all.

### Administrator roles

Because Discord decides who holds a mapped role, a mapped role with Administrator makes anyone given that role on Discord a Harmony admin at the next sync. The page therefore treats a row as Administrator-bearing when the Discord role has Administrator, the Harmony role has it, or the Harmony role is the protected admin role.

- **Only the owner** can map such a row or apply Administrator to a role. Others see **Only the server owner can map roles with Administrator**.
- The owner confirms in a dialog that lists the linked members who hold that Discord role now, and says that anyone given it on Discord later becomes an admin too.
- The sync audits every Administrator role it grants or removes, and notifies the owner.
- The sync never touches the owner: no role is added or removed, and the owner is never removed from the server.
- The sync never removes a holder of an Administrator role from the server. That member can lose the mapped role, which is audited and notified.

## Open the migration

The **Ready to open** card lists what still blocks you: missing credentials or server ID, roles not fetched, roles not matched. It also warns, without blocking, about Discord channels with no paired Harmony channel, per-member channel permission overrides that will not carry over, and a bot that cannot ban.

Click **Open migration**. The page shows the **Invitation link**, `https://<your instance>/migrate/<token>`, with a copy button. Post it where your members will see it. The token is random and not guessable. **Regenerate link** replaces it; the old link stops working. A link for a migration that is not open shows only "This migration is closed".

## What a member does

1. Opens the link and sees your server's name and icon.
2. Signed in to Harmony, they are told which account will be linked and can sign out if it is the wrong one. Signed out, they choose **I have a Harmony account** (and return after signing in) or **I'm new: continue with Discord**.
3. Signs in with Discord and allows the `identify` scope. The migration checks with the bot that they are in your Discord server.
4. A new member fills in a username (filled from Discord), an email and a password. Existing accounts are never merged: an email that already exists asks the member to sign in instead.
5. Joins the server and receives the Harmony roles that match their Discord roles. The link works as an invitation, so it also works on an invite-only server. The server's welcome screen and rules gate still apply after joining.
6. Chooses which profile fields to copy (below).

Only accounts on your instance can migrate; a member signed in from another instance is asked to make an account here. If the instance requires email confirmation, a new member confirms the email, signs in, and joins automatically; the Discord check is kept for 7 days. If the operator turned off account creation for migrations, only members with an existing account can use the link.

A member refused for a reason (banned on Harmony, removed on Harmony, banned on Discord, not in the Discord server, Discord account linked to another Harmony account) sees a message saying why, and nothing is created.

## What syncs

Sync runs about every 6 hours, and when you press **Sync now** (the gateway starts it within about half a minute) or re-open the migration. It reads every linked member from Discord, oldest check first, and carries on in the next run when a large server does not finish in one.

| What | How it follows Discord |
|---|---|
| **Roles** | Always. Mapped roles are added and removed to match Discord. One way: Discord to Harmony |
| **Membership** | A member who leaves or is kicked on Discord is removed from the Harmony server. A member banned on Discord is banned on Harmony. Changes are audited as made by the migration, and a member who returns to Discord can use the link again |
| **Timeouts** | Always. A Discord timeout becomes a Harmony timeout. When Discord lifts it, the migration lifts only the timeouts it made; a timeout set by a moderator or AutoMod is never replaced or lifted |
| **Profile fields** | Only the fields each member ticks (below) |
| **Discord join date** | Stored on the link and shown on the member's profile card in your server as **Joined on Discord** |

Each member chooses any of these fields, at the end of the link page and later in their user settings: **Profile picture**, **Display name**, **Banner**, **Accent colour** (their account profile) and **Nickname in this server**, **Picture in this server**, **Banner in this server** (their profile in your server). Images are copied to Harmony's own storage; Discord's image addresses are never kept. Unticking a field stops copying it but does not clear what was copied. Bio and pronouns are Harmony-only.

### Harmony moderation comes first

Discord can take people out of your Harmony server, but nothing on Discord undoes a Harmony decision:

- A member banned on Harmony is refused by the link and never re-added by a sync.
- A member you kick on Harmony is marked **Kicked here** in the member list and is refused by the link. Use **Allow back** on that row to let them in again.
- The sync adds nobody to the server; only the link does that.

### The brake

If one pass would remove more than 10% of the linked members (and at least 3), the sync stops removing and pauses instead, with a notice, so an outage or a bot that lost access cannot empty your server. Role changes still apply. Check the cause, then click **Resume**. The sync also pauses, and changes nothing, when the bot can no longer see the Discord server or Discord rejects its token; fix the bot and click **Resume**.

## Finish and re-open

When you are done with Discord, click **Finish migration** and confirm. The link stops working and syncing stops. Accounts, memberships and roles stay as they are, and every migrated account has an ordinary email and password login, so nobody is locked out. From then on Harmony alone decides who holds which role, and who is an admin.

A finished migration can be re-opened with **Re-open**. Mapped roles and membership then follow Discord again, and a sync runs at once, so check your role map first.
