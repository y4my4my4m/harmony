---
title: Instance funding
description: How instance administrators ask for support - goal, payment links, supporter tiers, supporter messages and their approval, the sign-in page strip - how the Harmony development tab works on every instance, and the project fund on har.mony.lol.
---

# Instance funding

This page is for the administrators of a Harmony instance. Members support the instance from the **Support** window: the heart in the bar above the chat (the support pill), the heart at the end of the server rail on a phone, or **User settings** → **My account** → **Support**.

## The Support window

The window has two tabs:

| Tab | What it shows |
|---|---|
| **This instance** | Your goal and progress, your payment links, the member's own supporter status and history, approved supporter messages and your supporter tiers |
| **Harmony development** | The Harmony project's development fund: its links, its goal and progress when it publishes them, and its supporters' messages unless you turn them off. Payment happens on the project's pages; your instance never handles that money |

The development fund is not har.mony.lol's own funding. On har.mony.lol the two tabs are two funds as well: **This instance** pays for that server, **Harmony development** for the project, and each counts only its own donations. See [The Harmony development fund](#the-harmony-development-fund).

A monthly goal counts donations in the current calendar month in UTC and says when it resets, for example **Resets Dec 1 (UTC)**. A supporter's badge lasts 30 days from their latest donation.

## Set it up

Open **User settings** → **Instance admin** → **Funding**.

- **Enable funding**, the goal amount, currency and period (monthly or all time), a description and a thank-you message shown to supporters.
- **Show in context bar** puts the progress pill above the chat.
- **Donation links**: Stripe Payment Links credit the donor's account automatically (Harmony opens them with the donor's account id); Ko-fi and other platforms credit a donor who writes their handle, `@name@your.domain`, in their message. See the Stripe and Ko-fi sections of the same tab for the webhook URLs and secrets.
- **Supporter tiers** with a minimum amount, badge and colour.

## Supporter messages

With **Supporter messages** on, a member can add a public message to their support in the Support window before opening a payment link:

- Plain text, up to 50 characters. Line breaks, control characters, text direction marks and stacks of three or more accents on one character are refused. Nothing in a message becomes a link, a mention or an emoji.
- The message goes with the member's next donation recorded within 24 hours of writing it, whichever way it is recorded: the Stripe or Ko-fi webhook, a donation you record by hand, or a pending donation you attribute. One message per donation.
- The member chooses to show their display name or **Anonymous**. Amounts are never shown next to messages.
- Nothing shows to anyone but its author until you approve it. Messages wait in **Supporter messages** in the Funding tab, newest first, with the donor, the amount and the date (an anonymous message shows you who wrote it). **Approve** shows it in the Support window; **Hide** takes it down at any time, and **Show again** puts it back. Admins can also hide a message from the Support window itself.
- A member can remove their own message at any time.

**Show approved messages on the sign-in page** adds a small **Recent supporters** strip under the sign-in form, one message at a time. Turn it off to keep messages inside the app.

### Harmony's supporter messages

**Show Harmony's supporter messages**, on by default, shows the messages of the Harmony project's own supporters on the **Harmony development** tab. The Harmony project approves those messages, not you. Turn it off and the tab shows only the project's links and progress: your instance's backend leaves the messages out of what it sends, so none reaches your members' devices. The switch applies whether or not your own funding is enabled, and does not appear on har.mony.lol, where the tab is the project's own fund. Members with the app already open see the change within 30 minutes.

## Public funding feed

Every instance publishes its funding at `GET /api/federation/funding/public`, as JSON any website can read: the links, the goal and progress, the supporter count and, when **Show approved messages on the sign-in page** is on, the approved messages. An anonymous message has no name, and no message carries an account id.

har.mony.lol also publishes the development fund, in the same form, at `GET /api/federation/funding/project-feed`. Every other instance's backend reads that feed for its **Harmony development** tab; see `PROJECT_FUNDING_URL` in [Configuration](/self-host/configuration#funding). Another instance answers that address with 404.

## The Harmony development fund

This section is for the administrators of har.mony.lol, the Harmony project's own instance (`PROJECT_INSTANCE`). Its **Funding** tab has a **Harmony development fund** section, which no other instance shows:

- **Publish the fund**, the goal amount, currency and period, a description and the donation links every instance shows on its **Harmony development** tab.
- **Stripe Payment Link ids**: the `plink_…` ids of the fund's Payment Links, from the Stripe dashboard. A checkout of one of them is the fund's. So is a subscription whose metadata has `fund` = `harmony-development`, which is how renewals are told apart: a renewal carries only its subscription. Every other Stripe payment, through the same webhook and signing secret, is the instance's.
- **Ko-fi verification token**: with a token here, Ko-fi donations that carry it are the fund's. Without one, every Ko-fi donation is the instance's.
- **Supporter messages** and their public display, as for the instance. A member of har.mony.lol writes a message for the fund on the **Harmony development** tab; it goes with their next donation to the fund within 24 hours and waits in the section's own queue, apart from the instance's.

A donation to the fund credits the donor's account when they pay from the Harmony development tab of har.mony.lol, and gives no supporter tier or badge: tiers are the instance's. Donations nobody can be credited with, from mony.lol or another instance, still count toward the fund's total and supporters, and wait in **Pending donations** tagged **Harmony development**; attributing or dismissing one does not change the total.
