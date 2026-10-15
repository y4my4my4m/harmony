---
title: Run a server
description: What a Harmony server owner and the members they trust can set up and moderate, and where each task is documented.
---

# Run a server

This section is for people who own or help run a server (a community with its own channels, roles and members) on any Harmony instance. Running the instance itself is covered in [Self-host](/self-host/).

## What you can do as a server owner

- Create a server, from scratch or from a template, and lay it out in text and voice channels grouped into categories.
- Invite people, and list the server publicly so others can find it.
- Add custom emoji and soundboard sounds.
- Create roles, give them permissions, and change those permissions per channel.
- Moderate: AutoMod rules, reports, timeouts, kicks, bans and an audit log of what changed.
- Let other services post through channel webhooks, and add bots.
- Bridge the server to a Discord server.

Most of this lives in the server settings. Click the server name at the top of the channel list to open the server menu, then **Server settings**. Members without **Manage Server** see the same entry as **Overview** and get a read-only view.

## Owner, administrators and moderators

Harmony has no fixed staff ranks. Who can do what comes from server ownership and from the permissions of the roles a member holds (see [Roles and permissions](/run/roles-permissions)).

| Who | What decides it | What they can do |
|---|---|---|
| Owner | Created the server | Everything, in every channel. Only the owner can delete the server. The owner cannot be kicked, banned or timed out, and has no **Leave server** entry. |
| Administrators | Hold a role with the Administrator permission. Every server starts with an `Admin` role that has it, held by the owner. | Every permission in every channel; channel overrides do not apply to them. They cannot be timed out. |
| Moderators | Hold a role you gave moderation permissions, such as **Kick Members**, **Ban Members**, **Timeout Members**, **Manage Messages** or **View Audit Log** | What those permissions allow. Kicks and bans only reach members whose highest role is below theirs. |
| Everyone else | The `@everyone` role, plus any other roles | Read, post, react, start threads, join voice and invite, unless you change `@everyone`. |

The instance's own administrators and moderators are a separate group, set by whoever runs the instance. They can act on any server on their instance regardless of its roles.

## Pages in this section

| Page | What it covers |
|---|---|
| [Setting up a server](/run/setup) | Templates, channels, categories, invites, custom emoji, soundboard sounds and the server settings |
| [Roles and permissions](/run/roles-permissions) | Roles, the role hierarchy, channel overrides, and every permission |
| [Moderation](/run/moderation) | AutoMod, reports, timeouts, kicks, bans and the audit log |
| [Webhooks](/run/webhooks) | Creating and managing channel webhooks |
| [Discord bridge](/run/discord-bridge) | Linking the server to a Discord server |
