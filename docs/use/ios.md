---
title: iPhone and iPad
description: Run Harmony on an iPhone or iPad, as the iOS app sideloaded with your own Apple ID or as a web app added to the Home Screen.
---

# iPhone and iPad

This page is for people who want Harmony on an iPhone, iPad or foldable iPhone. There are two ways: the iOS app, which is not on the App Store and is installed by sideloading, or the web app, added to the Home Screen from Safari. Both need iOS or iPadOS 16 or later.

| | iOS app | Web app |
|---|---|---|
| Install | A sideloading tool and your own Apple ID | Safari → Share → **Add to Home Screen** |
| Renewal | Re-sign every 7 days with a free Apple ID | None |
| Notifications | While the app is open | Push, also when closed (iOS 16.4 or later) |
| Instance | Asks for the **Instance domain** on first launch | The instance whose site you added |
| Updates | Install the newer `.ipa` | Follows the instance; **Update available** offers **Update now** |

If you want push notifications and no weekly renewal, use the web app.

## Web app

1. Open your instance in Safari, for example `https://har.mony.lol`.
2. Tap Share, then **Add to Home Screen**, then **Add**.
3. Open Harmony from the Home Screen and sign in.

Push notifications reach a web app opened from the Home Screen, not a Safari tab. Allow them in **User settings** → **Notifications** ([Notifications and apps](/use/notifications-apps)).

## iOS app

The iOS app is the same client as the desktop and Android apps, built for iPhone and iPad. On iPad it runs full screen, in Split View, in Slide Over and in resizable Stage Manager windows; the layout follows the window size, as it does when a foldable iPhone opens. On first launch it shows **Welcome to Harmony** and asks which instance to connect to, as described in [Choose an instance](/use/getting-started#choose-an-instance).

### Get the file

The app is the file `Harmony_iOS_V<version>.ipa` on Harmony's [GitHub releases](https://github.com/y4my4my4m/harmony/releases), from 1.8.9 on. Open the [latest release](https://github.com/y4my4my4m/harmony/releases/latest), expand **Assets** and download it; on the device, Safari saves it to **Downloads** in Files.

Test builds of unreleased changes are attached to runs of the [Tauri workflow](https://github.com/y4my4my4m/harmony/actions/workflows/tauri.yml) that built iOS, as `Harmony_iOS_V<version>_dev-<branch>-<commit>.ipa` under **Artifacts**. Downloading artifacts needs a GitHub account.

The file is unsigned. A sideloading tool signs it with your Apple ID when it installs it; iOS does not run it otherwise.

### Limits of a free Apple ID

Any Apple ID can sign apps for its own devices. Without a paid Apple Developer Program membership:

- An app stops opening 7 days after it was signed. Re-sign it before then; the sideloading tools call this refreshing.
- At most 3 sideloaded apps can be installed at once, and AltStore or SideStore counts as one of them.

::: warning
Sideloading tools sign in to Apple with your Apple ID and password. Some people use a separate Apple ID for this.
:::

### Turn on Developer Mode

iOS 16 and later run apps signed this way only with Developer Mode on. After the first install, open Settings → Privacy & Security → **Developer Mode**, turn it on and restart the device. If iOS says the developer is not trusted, open Settings → General → VPN & Device Management, tap your Apple ID and trust it.

### Install with a sideloading tool

Use one of these. Each has its own setup guide; follow it, then install the Harmony `.ipa` as below.

| Tool | Needs | Refreshing |
|---|---|---|
| [AltStore](https://altstore.io) | AltServer on a Mac or Windows PC on the same Wi-Fi | AltStore refreshes in the background while AltServer is reachable |
| [SideStore](https://sidestore.io) | A computer for the one-time setup | On the device, without a computer |
| [Sideloadly](https://sideloadly.io) | Sideloadly on a Mac or Windows PC, the device connected by cable or Wi-Fi | Install the `.ipa` again from Sideloadly |

- **AltStore** or **SideStore**: save the `.ipa` to Files on the device, open the tool, go to **My Apps**, tap **+** and pick the file.
- **Sideloadly**: on the computer, drop the `.ipa` into Sideloadly, enter your Apple ID and select **Start**.

### Update the app

Harmony does not check for new iOS builds. Each release carries a new `.ipa`: install it with the same tool and Apple ID, and it replaces the installed app.
