---
title: Instance funding
description: How instance administrators ask for support - goal, payment links, supporter tiers, supporter messages and their approval, the sign-in page strip - and how the Harmony development tab works on every instance.
---

# Instance funding

This page is for the administrators of a Harmony instance. Members support the instance from the **Support** window: the heart in the bar above the chat (the support pill), the heart at the end of the server rail on a phone, or **User settings** → **My account** → **Support**.

## The Support window

On a self-hosted instance the window has two tabs:

| Tab | What it shows |
|---|---|
| **This instance** | Your goal and progress, your payment links, the member's own supporter status and history, approved supporter messages and your supporter tiers |
| **Harmony development** | The Harmony project's own funding: its links, its goal and progress when it publishes them, and its supporters' messages. Payment happens on the project's pages; your instance never handles that money |

On the Harmony project's own instance, har.mony.lol, both are the same funding and the window shows one view.

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

## Public funding feed

Every instance publishes its funding at `GET /api/federation/funding/public`, as JSON any website can read: the links, the goal and progress, the supporter count and, when **Show approved messages on the sign-in page** is on, the approved messages. An anonymous message has no name, and no message carries an account id. Self-hosted instances read the Harmony project's feed this way for their **Harmony development** tab; see `PROJECT_FUNDING_URL` in [Configuration](/self-host/configuration#funding).
