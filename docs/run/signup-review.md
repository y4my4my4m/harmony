---
title: Reviewing signups
description: For instance administrators and moderators. See recent accounts, spot groups created together, and suspend or unsuspend many accounts with one reason.
---

# Reviewing signups

This page is for an instance's administrators and moderators. The tools are in **User settings** → **Instance admin** (**Instance moderation** for moderators) → **Signups**.

## What the tab shows

Choose a period of 1, 7 or 30 days. Filter by status, or search by username, name or email domain. Limits on signups themselves are set by administrators in **Invites** → [**Sign-up limits**](/self-host/signup-limits). The per-day table counts refused signups, and signups past a cap that only counts: neither appears in the account list as refused, since a refused signup has no account.

**Accounts** lists accounts created on this instance, newest first:

- when the account signed up, and whether its email address is confirmed
- its email domain, such as `example.com`
- its posts, messages, servers it is in and servers it owns
- the first server it joined within an hour of signing up

The tab never shows an email address or an IP address. Instance staff accounts are marked and cannot be selected. Accounts of other instances are not listed.

**Per day (UTC)** gives, for each day with signups:

| Column | Meaning |
|---|---|
| Signups | Accounts created that day |
| Email domains | How many different domains they used |
| Largest domain | How many of them used the most common domain |
| Busiest hour | How many signed up in the fullest clock hour |
| Suspended | How many of them are suspended now |

Many signups across many domains usually means the instance was mentioned somewhere. Many signups with one large domain, or most of them within an hour, is worth a closer look.

## Groups

**Groups** lists sets of three or more accounts from the period:

- **Email domain**: accounts sharing a domain. "Earlier accounts on this domain" says how many existed before the period, so a new domain stands out from a common provider.
- **Joined within an hour of signing up**: accounts that joined one server soon after signing up. "Members from before this period" says how many members that server already had. The instance's welcome server is left out.

Groups with few earlier accounts come first. **Show** limits the list to a group. **Select all** adds its accounts to the selection.

A group is a reason to look, not proof. Families, classes and communities sign up together and share providers. Read the accounts before you act.

## Suspend or unsuspend several accounts

1. Tick the accounts, or use **Select all** on a group. A selection holds up to 200 accounts, and can span pages and groups.
2. Choose **Suspend…** or **Unsuspend…**.
3. Read the dialog: who will change, who is left out and why, and which servers those accounts own.
4. Enter one reason. It is required.
5. Confirm.

These are always left out: your own account, instance staff, accounts of other instances, accounts without a sign-in and accounts deleted by staff. To act on a staff account, an administrator uses **Users**.

Each changed account gets its own entry in the activity log, with the reason and the batch it belonged to. All the accounts change together, or none do if the action fails.

## What a suspension does

| | Effect |
|---|---|
| Sign-in | The account's sessions end at once, and the app signs it out if it signs in again |
| Posts | Leave timelines, search and public pages on this instance |
| Messages | Stay in channels and direct messages |
| Follows with local accounts | Removed in both directions. Unsuspending does **not** restore them |
| Voice | Removed from voice channel lists. Active calls with other instances end |
| Remote followers | Stay |
| Other instances | Told nothing. What they already received stays with them, and the account's profile still answers there |
| Servers it owns | Stay open with the same owner. Members keep using them |

To close a server a suspended account owns, go to **Servers**, open the server, and suspend or delete it (see [Moderation](/run/moderation)). A server has no way to pass to a new owner from this tab.

A suspension is reversible except for the follows. Before suspending, the dialog says how many follows will be removed.

## Reports about hoarding

Members can report an account for **Username hoarding or account trading**. Staff see the reason in **Reports**, under the rule-violation category. A report about a message in a server hosted on another instance carries the reason to Harmony instances; older Harmony instances file it as "Other", and other software ignores it. A report about an account on another instance carries only the reporter's comment, as for every reason.
