---
layout: home
title: Harmony Docs
titleTemplate: false
description: Documentation for Harmony, the open-source federated chat app. Use it, run a server on it, host your own instance, or build bots and bridges for it.

hero:
  name: Harmony
  text: Documentation
  tagline: Open-source chat with servers, channels, DMs, threads and voice, plus a social timeline. Instances federate with each other and with the rest of the fediverse over ActivityPub.
  image:
    src: /logo.png
    alt: Harmony logo
  actions:
    - theme: brand
      text: Open har.mony.lol
      link: https://har.mony.lol
    - theme: alt
      text: Self-host an instance
      link: /self-host/install
    - theme: alt
      text: Project site
      link: https://mony.lol

features:
  - title: Use Harmony
    details: Create an account, join servers with an invite, send messages and threads, make calls, set notifications and secure your account.
    link: /use/
    linkText: For members
  - title: Run a server
    details: Set up channels and invites, give out roles and permissions, moderate with AutoMod and reports, bridge a Discord server.
    link: /run/
    linkText: For owners and moderators
  - title: Self-host
    details: Install an instance with one command, then configure email, sign-in providers, voice and push, and keep it updated and backed up.
    link: /self-host/
    linkText: For instance operators
  - title: Build
    details: Write bots against the gateway and REST API, post through webhooks, or connect another chat network with the bridge API.
    link: /build/
    linkText: For developers
---

<div class="hm-home">

<section class="hm-install">

## Run your own instance

On a Linux server with a domain pointed at it, one command checks the server, offers to install Docker, asks a few questions, starts the stack and creates the admin account. Running it again is safe.

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
```

Read [Install](/self-host/install) first for the server size, DNS records and the questions the installer asks.

</section>

<div class="hm-more">
<div>

### Federation

How Harmony talks to other Harmony instances and to Mastodon and the rest of the fediverse, and the ActivityPub details for implementers.

[Federation overview](/federation/)

</div>
<div>

### Contribute

Set up a development environment, learn the architecture, run the test suites and ship a database migration.

[Development setup](/contribute/)

</div>
<div>

### Changelog

Each version is a GitHub release with the desktop installers and the Android APK attached.

[Changelog](/changelog)

</div>
</div>

</div>
