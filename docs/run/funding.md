---
title: Instance funding
description: How instance administrators ask for support - goal, payment links, supporter tiers, supporter messages and their approval, the sign-in page strip - and what the Harmony development tab shows on every instance.
---

# Instance funding

This page is for the administrators of a Harmony instance. Members support the instance from the **Support** window: the heart in the bar above the chat (the support pill), the heart at the end of the server rail on a phone, or **User settings** → **My account** → **Support**.

## The Support window

The window has two tabs:

| Tab | What it shows |
|---|---|
| **This instance** | Your goal and progress, your payment links, the member's own supporter status and history, approved supporter messages and your supporter tiers |
| **Harmony development** | The Harmony project's development fund: its one-time and monthly Stripe pages, and a link to its supporters and their messages on [mony.lol](https://mony.lol/supporters). Payment happens on Stripe; your instance never handles that money |

The **Harmony development** tab is the same on every instance, har.mony.lol included, whether or not your own funding is enabled. Its two Stripe pages are built into Harmony: no instance setting changes them, so no instance can put its own payment links under the Harmony development name. The tab shows no goal, progress or messages, and opening it sends nothing to your instance or to the project. Supporters of Harmony's development leave their messages at checkout on Stripe, and the project approves and publishes them on mony.lol.

A monthly goal counts donations in the current calendar month in UTC and says when it resets, for example **Resets Dec 1 (UTC)**. A supporter's badge lasts 30 days from their latest donation.

## Set it up

Open **User settings** → **Instance admin** → **Funding**.

- **Enable funding**, the goal amount, currency and period (monthly or all time), a description and a thank-you message shown to supporters.
- **Show in context bar** puts the progress pill above the chat.
- **Donation links**: Stripe Payment Links credit the donor's account automatically (Harmony opens them with the donor's account id); Ko-fi and other platforms credit a donor who writes their handle, `@name@your.domain`, in their message. See the Stripe and Ko-fi sections of the same tab for the webhook URLs and secrets.
- **Supporter tiers** with a minimum amount, badge and colour.

The Stripe webhook answers the Harmony development fund's payments and records nothing: checkouts of its two Payment Links, and invoices of subscriptions whose metadata has `fund` = `harmony-development`. An instance whose Stripe account also takes development donations, as har.mony.lol's does, never counts them as its own.

## Supporter messages

With **Supporter messages** on, a member can add a public message to their support in the Support window before opening a payment link:

- Plain text, up to 50 characters. Line breaks, control characters, text direction marks and stacks of three or more accents on one character are refused. Nothing in a message becomes a link, a mention or an emoji.
- The message goes with the member's next donation recorded within 24 hours of writing it, whichever way it is recorded: the Stripe or Ko-fi webhook, a donation you record by hand, or a pending donation you attribute. One message per donation.
- The member chooses to show their display name or **Anonymous**. Amounts are never shown next to messages.
- Nothing shows to anyone but its author until you approve it. Messages wait in **Supporter messages** in the Funding tab, newest first, with the donor, the amount and the date (an anonymous message shows you who wrote it). **Approve** shows it in the Support window; **Hide** takes it down at any time, and **Show again** puts it back. Admins can also hide a message from the Support window itself.
- A member can remove their own message at any time.

**Show approved messages on the sign-in page** adds a small **Recent supporters** strip under the sign-in form, one message at a time. Turn it off to keep messages inside the app.
