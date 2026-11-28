# Changelog

All notable user-facing changes to Harmony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.8] - 2026-11-25

### Added

- **Speak a message aloud.** **Speak message** in a message's options menu reads it with
  this browser's own voice, or an ElevenLabs-compatible API you configure, and **Stop
  speaking** ends it. The settings and any key stay on this device, per account, are
  never sent to a Harmony server, and are removed when you sign out. Spoilers
  are not read, and the action is hidden until an encrypted message is unlocked. See
  [Privacy and security](docs/use/privacy-security.md#spoken-messages).

- **Limits on call signals and calls placed.** Each account may send 300 call signals and place 10
  calls a minute by default, calls to other instances included, set in **Admin** → **Anti-spam**. A
  call past the limit says when the next one can ring; hanging up is never refused.
- **Admins choose the STUN and TURN servers of peer-to-peer calls** in **Admin** → **Config** →
  **Voice & video**: STUN and TURN URLs, with coturn shared-secret credentials minted per account
  (valid 24 h) or one fixed username and password. Peer-to-peer calls carry the instance's choice
  instead of a hard-coded list.
- **Sign in with Discord.** **Continue with Discord** joins Google, Twitch and GitHub on the sign-in
  and registration pages. A first sign-in starts the profile with the Discord display name, avatar
  and username. Three or more sign-in buttons sit two to a row under the provider's name, so the
  password form stays in view on a phone.
- **Sign-in providers set up in the admin panel.** **Admin** → **Config** → **Authentication** takes
  the client ID and secret of Google, Twitch, GitHub and Discord, shows the callback URL to register,
  and says when the sign-in service has them; the federation server hands them to it within about
  15 seconds, with no restart and no `supabase/.env` edit. The secret is write-only and kept in
  Supabase Vault. Self-host: `harmony update` sets this up. Instances that keep their credentials in
  `supabase/.env` work as before, and a self-host install that keeps providers apart from existing
  accounts keeps Discord apart too.
- **Play together.** **Activities** (popcorn) starts a multiplayer activity everyone there can join
  from the notice it posts; nobody needs to be in a call. It is a button in a text channel's header
  and in a call, and an entry of **More options** (⋮) in a DM or a group. In a call the activity
  takes the stage like a shared screen, and until you join it, it is a tile beside the participants
  with **Join**, as watch and listen together are; leaving the call leaves its game. Player names
  show their custom emojis. The panel
  docks above the messages at a height you drag,
  expands over them, and keeps running behind a corner card when you open another conversation. A
  game ends when its last player selects **Leave**; one whose last player only lost the connection
  waits a minute for them to come back. The first activity is **DrawinPhone**: write a prompt, draw
  the next one, describe the drawing after that, then replay every chain together with reactions and
  favourites. In a text channel, starting or joining takes **Send Messages**, and a member timed out
  in the server cannot play: the notice and the banner give the reason instead of **Join**, and a
  member who loses the permission mid-game is removed within 30 seconds. A conversation with someone
  who blocks you answers as any conversation you cannot play in. Activities run sandboxed with no
  access to your account, your messages or the desktop app. They cannot use WebRTC or load scripts
  from other sites (a browser may still follow an activity's `preconnect` and `prerender` hints),
  and they talk through a relay in the federation backend that limits connections per IPv4 address
  or IPv6 /64, sockets not yet signed in and bytes queued for slow readers; a slow avatar address
  delays nobody's game. Instance admins turn each activity on or off in **Admin** → **Activities**.
  Developers: see the Activities SDK in the docs.
- **Install activities.** **Admin** → **Activities** → **Install an activity** takes an activity
  package (a `.zip` of at most 32 entries and 6 MB unpacked, uploaded or from an `https://` address),
  shows what it is and its SHA-256 before installing, installs it switched off, and later checks its
  address for updates or removes it. The instance serves its own copy in the same sandbox as the
  built-ins. Installed activities carry a **Third-party** label in the picker, on the Join banner or
  tile and above the game. They run on computers only: phones run the frame in the app's own web process,
  where one that never yields would freeze the app.
- **Roles members pick themselves.** In the role editor, **Members can pick this role** (with a group
  and a short description) lists a role in **Pick roles**, in the server menu and on your own profile
  card, where members take it and drop it with a tap. `/rolemenu` posts a role menu card in a channel
  that works the same way, also in end-to-end encrypted servers. Only roles that give nothing a
  member could misuse can be picked; the editor says why a role cannot. An account changes its
  roles at most 60 times a minute by default, set in **Admin** → **Anti-spam**. Role menus are
  posted only with **Manage roles** and cannot be edited.
- **Role for new members.** **Server settings** → **Roles** → **Role for new members** gives a role
  to everyone who joins from then on. A role that has permissions @everyone lacks, or sits above one
  that does, cannot be chosen and is not given; one stored by an earlier version is cleared.
- **Bots can give roles and post files.** `PUT` and `DELETE
  /servers/{id}/members/{user}/roles/{role}` give a member a role or take it away, within the bot's
  **Manage roles** reach; the server audit log names the bot. `POST /channels/{id}/attachments`
  uploads a file (an edited image, a chart) that the bot then sends in a message or a slash-command
  reply; it needs the new **Attach files** permission, on by default, counts toward the server's
  stored-bot-files limit, and loses its location and camera metadata like any upload. Three uploads
  of a bot run at once and ten more wait, a bot upload may take up to 30 minutes, the answer is 429
  rather than 507 while other uploads hold the server's cap, and the instance's upload limit applies
  behind the shipped proxies. Message and reaction events now carry `server_id`, and the member list
  shows each member's role IDs.
- **Matrix bridge.** Harmony works with the [Matrix bridge](https://github.com/y4my4my4m/harmony-matrix-bridge),
  an application service an instance operator runs beside a Matrix homeserver. Messages, replies,
  images and files cross both ways between a paired channel and Matrix room, in channels without
  end-to-end encryption. Matrix people show as Discord people do: their name and avatar, with a
  Matrix icon or a `MATRIX` label (**Bridge source indicator** in **Appearance**), in messages,
  mentions, the member list, reactions, notifications and their profile card. Harmony members appear
  in Matrix as their own Matrix users or through one shared bridge account, chosen per channel in
  **Server settings** → **Bridges** → **Matrix**. Server managers remove a Matrix person from the
  bridge and erase what it relayed there, as for Discord people. Matrix people's avatars count
  toward the server's limit on stored bridge files, at most 1000 per bridge bot, and are deleted an
  hour after the bridge is removed. Past 1000 avatars in a server, a new one replaces the one unused
  longest. On other instances' copies of the server, a Matrix person's
  messages carry their name and picture; instances on 1.9.7 and older show them as a webhook's.
  (#197, ZaneH)
- **One Bridges page.** **Server settings** → **Bridges** holds the Discord and Matrix bridges on two
  tabs. Links to the former **Discord Bridge** page open the Discord tab.
- **Matrix bridges are set up in the app.** **Server settings** → **Bridges** → **Matrix** pairs
  channels: choose your bridge bot and tick channels from its channel list (one outside the list says
  where to add it), change them later, or unpair the bot. A status card counts the paired channels,
  those with a Matrix room and those still waiting for one, and a manager without a bot gets the setup
  steps and a link to the guide.
- **Keep your messages off a bridge.** **Bridge privacy** in a server's menu stops its Discord or
  Matrix bridge, each on its own, from relaying your messages, edits, reactions and the bots' public
  answers to your slash commands. Deleting a message still reaches the bridge, so a copy relayed
  before is removed too. A bridge also never gets what an opted-out member wrote through a system
  notice: the name of a thread started on their message reads "Thread", notices of a kick or ban and
  AutoMod alerts about them are withheld, and the delete of a withheld message carries only the
  bridge's own mapping. Other people's replies in those threads still cross. The entry shows only in
  servers with a bridge, and the choice lasts when you leave and rejoin. (#197, ZaneH)
- **Discord history import through every bridge.** **Admin** → **Config** → **General** →
  **Discord bridge** → **Discord history import** has a third choice, **All bridges**: besides
  bridges their server's owner runs, the instance's Discord bot and the own-bot bridges the instance
  hosts can import. The three choices are cards with a line each instead of a drop-down. Needs the
  bridge host 2.8.0.
- **Import private Discord channels from Harmony.** A pair whose Discord channel `@everyone` cannot
  read shows a lock. **Import all** and **Import history** name those channels and ask a second
  time before including them; left unticked, they are left out and the others start. On Discord,
  `/bridge import-history scope:all` still starts every channel the member can read in one command.
  The notice the bridge pins in each imported Discord channel no longer sends a push notification,
  and Discord's "pinned a message" line is removed (bridge 2.8.0).
- **Self-host: uploads in an S3-compatible bucket.** `STORAGE_BACKEND=s3` with the `STORAGE_S3_*`
  keys (`BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `FORCE_PATH_STYLE`) in
  `supabase/.env` keeps uploads in Cloudflare R2, MinIO or AWS S3 instead of
  `supabase/volumes/storage`. AWS variables exported in your shell never reach it. An endpoint, key
  or path style not set as `STORAGE_S3_*` is not passed to storage, so what a compose override of
  your own gives is kept. `harmony doctor` warns when storage runs with `STORAGE_BACKEND=s3` and
  without a bucket or keys. Unset, storage stays on disk.

### Fixed

- **Fetching a post's replies from its server shows the right counts.** A fetch that ended while its
  progress was being read reported the counts from before it.
- **A Discord bridge pair on a voice channel shows the channel's name.** The Discord bridge page
  named a pair whose Harmony side is a voice channel's chat by its id; the form for a new pair still
  offers text channels only. (#215, ROODAY)
- **The admin panel no longer stalls the instance.** **Overview**, **Federation** and the **Users**
  filter counts read one stored statistics snapshot instead of many exact counts at once, which held
  every database connection and made other requests fail. **Overview** says when its figures were
  computed, counts accounts and posts of the last 24 hours, and shows chat servers active in the
  last 30 days. A suspension made in the panel updates the counts at once. If a refresh fails, the
  last figures stay, with their age. Totals over very large tables are estimates, marked ≈.
- **Announcements show the emoji or icon their admin chose.** The **Icon** field takes an emoji, or
  info, warning, megaphone, maintenance, update or security; an emoji and `megaphone` showed the
  info icon in the pop-up, on **Today** and in **User settings** → **Announcements**.
- **Live updates come back on their own.** When the instance closed a live feed (an expired sign-in,
  for example), the server's channel list, members and statuses, voice channels, typing, incoming
  calls and timelines stayed closed until a reload; they now reopen within seconds and fetch what
  changed meanwhile. On a slow connection a reconnect could also lose every live feed for good.
- **Thread replies sent during a connection drop appear on their own.** An open thread, in the panel
  or as a page, showed them only after it was reopened.
- **Live reactions on a post shown twice keep updating.** When one copy of the post closed, the
  other stopped receiving reactions.
- **DM call answers and hang-ups, and voice room effects, carry their real sender.** A participant
  can no longer answer, decline or end a call as someone else, or start an effect in another
  member's name. Apps before 1.9.8 cannot answer or end DM calls on an updated instance until they
  update.
- **Answering or declining a call on one device stops it ringing on your others**, calls from other
  instances included. Nobody else in the conversation can stop it for you, and a declined call no
  longer reports "Missed call".
- **Peer-to-peer calls carry their real sender.** Without LiveKit, call signals go through the
  database, which names the sender; no member can offer media or end connections as another. Apps
  before 1.9.8 cannot connect peer-to-peer calls on an updated instance until they update.
- **Downloading a file no longer drops the call you are in.** On the web, following a file link makes
  the browser announce that the page is leaving before it starts the download; calls took that as a
  close. They end when the page really goes.
- **A peer-to-peer call that cannot be joined releases the microphone.** A join that failed kept the
  microphone open and the room's signals connected.
- **Signing out during a call leaves it at once.** The leave was sent after the session ended and
  refused, so others saw you until the connection timed out.
- **A session the server no longer refreshes returns to sign-in.** The tab, and every other tab of the
  browser, stopped answering until a reload.
- **Another account signed in elsewhere in the browser takes the tab over cleanly.** The first account's
  servers, conversations, caches and call go first; an unfinished two-factor sign-in is refused.
- **A member of a peer-to-peer call whose app crashed leaves the call.** Their tile and count stayed
  until they came back.
- **A call cancelled at its microphone prompt no longer disturbs the next one.** The late microphone is
  stopped; before, it replaced the next call's and ended it.
- **Joining a federated call can be cancelled while it loads,** and a camera or screen prompt answered
  after the call releases the device.
- **Closing a tab open over an hour leaves its voice channel at once.**
- **A call ends when its session does, and the microphone with it.** Signing out in another tab, or a
  session revoked from elsewhere, left a running call up in this tab with the microphone on, and the
  other-tab case stayed on the page. The call closes at once and the page returns to sign-in.
- **Rejoining a peer-to-peer call no longer leaves a second connection and doubled audio.**
- **Peer-to-peer calls connect when two people join at the same moment.**
- **A DM call whose join fails stops ringing at once**, with no "No answer" 30 s later.
- **Signing out leaves you offline.** A heartbeat during sign-out no longer showed the account
  online for up to 150 s.
- **A two-factor code that verifies after the 30 s timeout finishes the sign-in properly**, for
  password and provider sign-ins alike, instead of leaving the app half signed in.
- **Settings changed right after a provider sign-in survive a reload.** On a shared device, nothing
  is stored while signed out, and the next account no longer opens at the previous account's last
  server and channel.
- **Closing voice settings, or switching cameras, before the camera starts no longer leaves the
  camera on.**
- **Spatial audio positions end with the call, and the spatial audio on/off setting is each
  account's own.**
- **Removing an attachment keeps the other previews with their files**, and keyboard focus moves to
  the next Remove button.
- **The voice channel easter egg keeps working after Realtime closes its channel.**
- **A message whose key could not reach every member says so.** When the encryption key of a sent
  message cannot be shared with some members, even after a retry, the sender is told they may not be
  able to read it yet. The message is still sent.
- **A forged encrypted message shows as forged.** A message whose signature does not match its
  sender reads "Message hidden", instead of looking like a message waiting for its key.
- **An encrypted message the server stored twice is marked Repeated.** The later copy carries the
  badge.
- **Signing out cancels a key backup still scheduled.**
- **Discord handles that match nobody on Harmony keep their domain.** `@user@host` typed in Discord
  arrives as written instead of as `@user`. (bridge 2.8.0)
- **A reply chain that loops back on itself stops at the repeat.** Remote posts replying to each
  other are fetched once each instead of up to ten times.
- **The `backfill-posts` maintenance script no longer restores removed posts.** It skips deleted
  posts and rewrites content only from the same post, served from its own id, by its stored author.
- **Generated emoji images download through the same address checks as other server fetches.**
- **The bot gateway no longer logs bot messages' metadata.** Discord names, avatars and reply
  excerpts from bridged messages stay out of the logs.
- **Discord people stay in their own channel's member list.** Leaving a bridged channel before its
  member list loaded put its Discord people in the list of the channel opened next, even in another
  server, where they then came and went every minute. A server opened next no longer shows the last
  one's bridged people for a moment either, and a bot gateway that does not answer has 15 seconds.
- **`@` suggests bridged people whichever bot bridges them.** A bridge bot that is private suggested
  its people to its owner only.
- **People added later to a group chat from another instance join it.** Someone here who is added to
  a group this instance already holds becomes a member of it and reads it, earlier messages included,
  and people added together when the group is made all join. Each gets one notice, with the group's
  name. An invite from someone you block, or whom your message setting refuses, does nothing.
- **Add people in a conversation lists everyone in it.** Opened from the header of a group, the
  picker listed nobody already there, and an account whose profile id differs from its sign-in id
  was offered as someone to add.
- **Files stored at the same time no longer pass a server's limit together.** Bot uploads and
  mirrored Discord files claim their space before they are read, and release it when they fail.
- **A reply shows a Discord or Matrix person in their own name colour.** A reply quoting a bridged
  person drew their name in Discord blurple whenever it appeared before the channel's member list
  loaded; it now takes their role colour when the list arrives, as their own message does.
- **A mention of a split-domain account typed with its server's host now opens the account.**
  `@maddy@chat.understars.dev` names the account stored as `@maddy@understars.dev` (Mastodon
  `WEB_DOMAIN` setups, Shoot): new messages store the account itself and show it as
  `@maddy@understars.dev`, as Mastodon does, and mentions already sent, or of an account this
  instance has not met yet, are looked up when clicked instead of doing nothing.
- **A Discord file added by an edit is stored even when the edit lands mid-download**, instead of
  keeping a Discord link that expires after about a day.
- **One deleted Discord attachment no longer keeps a message's other files from being stored.** The
  others are stored at once; only the dead link waits for a re-sign.
- **Mirroring Discord files no longer slows down as a server stores more of them.** The per-server
  limit and the admin's "Storing Discord files" figure take the same time to read however many files
  are stored.
- **History import no longer leaves stray files** when a batch repeats a Discord message or fails
  partway.
- **A Discord message relayed after the history import stored it now notifies.** The live copy
  replaces the quiet imported one, with mentions, unread counts and federation.
- **An import whose bridge went away can be stopped.** "Cancelling…" offers Stop now, and a paused
  import has Resume.
- **Linking replies of a very long imported channel no longer times out.**
- **A thread a moderator deleted stays deleted on the next history import.**
- **Importing again after removing all bridged messages rebuilds threads on their messages,** with
  one "started a thread" line.
- **Starting an import while it is cancelling keeps it running.**
- **Erasing the member who started an import no longer deadlocks with it.**
- **Fast history imports no longer wait out rate limits** when reading and updating their job.
- **A late bridge report can no longer restore an import's cursor after a purge.**
- **Opting back in, or a Restore, stops an erase at once.** A batch already running no longer
  finishes erasing after it.
- **Images in a busy author's Discord messages are re-signed without waiting for another look.**
- **A Discord thread started on an opted-out member's message no longer carries their words as its
  title**, nor does one started before its author opted back in.
- **No account can tell from a refused message whether a Discord user opted out of a bridge.**
- **Erasing a Discord member also clears the title of a thread started on an AutoMod alert about
  them.**
- **Importing a Discord emoji gives up after 15 seconds** instead of waiting forever on Discord's
  CDN.
- **A Discord bridge can no longer move an opted-out member's message to another author, or onto
  them.**
- **Stickers and sounds a manager deletes, and emoji an instance admin purges, stay deleted.** The
  Discord bridge's next sync no longer copies them back and lists them as left removed (bridge
  2.8.0).
- **Public pages of remote accounts load quickly on large instances.** Looking an account up no
  longer reads every profile; the index builds during the upgrade without blocking the instance.
- **Custom emoji a remote account removes disappear from its profile.** Taking every custom emoji
  out of a name and bio left the old ones showing here.
- **Removing a reaction made with a server's custom emoji works on member instances.** The reaction
  could stay once the instance held a second copy of the emoji's image.
- **A server on another instance can no longer flood its members with emoji changes.** A copy takes
  at most 2000 renames, new images and restores an hour; the rest follow at a later sync.
- **An instance admin's removal of another server's emoji outlives the admin's account.** The emoji
  came back at the next sync once that admin's account was deleted.
- **Reactions with a server's custom emoji show as one pill.** Instances that had cached the same
  image twice split them; they are merged on upgrade and at each sync.
- **Server changes reach member instances when servers' clocks differ.** A change made while an
  update was being sent could be dropped; it now goes out in the next update.
- **Every emoji of a server hosted elsewhere reaches its copy.** An old database rule on some
  instances allowed one emoji per name and instance. It refused a second server's emoji of the same
  name, an emoji added again under its old name, and some reactions with remote emoji. The rule is
  removed.
- **A blocked account no longer learns who blocks it.** It could read the block naming it and ask
  whether an account blocked it. Neither answers now, and a call to someone who blocks you says
  "Your call could not be placed."
- **A blocked account can no longer edit its earlier direct messages.** Its edits reached the person
  who blocked it as they were made. They are now refused like new messages; deleting still works.
- **Member searches in Kick, Ban and Roles no longer show another server's members.** A search still
  running when the dialog closed or the server changed could fill the next view.
- **Watch together recovers from a false playback state.** A member who could control the activity
  could keep everyone paused or at the start until the next real control. A state the server does
  not confirm within 3 seconds now gives way, and a late update no longer jumps playback back after
  a seek.
- **Roles → Add members finds members the role lacks.** The list came up empty when the first 30
  matches already held the role.
- **A reply typed into a notification is sent only as the account it was for.** Unsent replies
  survived sign-out and went out as whoever signed in next.
- **Calling someone who blocks you no longer ends your current call first.** From another call,
  Harmony says "Your call could not be placed." before asking to switch calls.
- **A personal emoji's owner is shown to everyone.** An account its owner blocks saw no name, which
  revealed the block.
- **Replies typed into a notification are sent as soon as Harmony has loaded.** A reply from the
  notification while Harmony was still loading waited until you switched back to the tab.
- **Sign-in through your own OIDC provider gets the address from userinfo.** A provider that sends
  the address and name from its userinfo endpoint only, as Better Auth and Authelia 4.39 do, ended
  every sign-in with "Error getting user email from external provider": the sign-in service read
  the ID token alone. `harmony auth add-provider --issuer` now has the sign-in service read
  userinfo, and an ID token signed with the client secret (HS256) no longer matters. Providers that
  already work keep reading the ID token; one that fails this way switches with
  `harmony auth add-provider ID --userinfo`, which asks for the client secret again.
  `harmony auth providers` shows which each one reads.
- **DMs show the other person's new avatar and name at once.** When someone you have a DM or group
  chat with changed their avatar or display name, the conversation kept the old one until you
  opened a server you both belong to. The DM header, the conversation list and their messages now
  update as soon as they save, with or without a shared server.
- **A limit notice says how long to wait in minutes or hours, and names the conversation limit.**
  Reaching an hourly limit said "Try again in 3600 s". The wait is now given as "45 seconds",
  "59 minutes" or "1 hour". Starting conversations, or a group chat, with more people you don't
  know than the instance allows per hour says so and gives the number, instead of "You're doing
  that too quickly".
- **The voice dock works over the media viewer.** With an image or video open full size, the dock
  showed on top but a press on it reached the viewer underneath: dragging the dock moved the image,
  and its buttons did nothing. The dock, docked or minimized, now drags and answers its buttons over
  the viewer, and Escape after pressing one of them still closes the viewer. Other dialogs now
  cover the dock instead of showing it over their own buttons.
- **The voice dock stays at the left edge.** Dropped against the left edge of the window, the
  docked bar jumped back to the middle at the height it was dropped. It now stays where it is
  dropped, also after a reload; released near its home at the bottom centre it still snaps there.
- **Other instances' list keeps up.** Typed text narrows the servers shown at once, and the count
  appears with the answer for that text instead of the previous one's. More than 60 servers loaded
  stay loaded while an instance is still being read; the list is read again in pages. A failed
  **Load more** says so and tries again on the next press. The last **Load more**, on both tabs,
  hands keyboard focus to the first server it added instead of dropping it to the top of the page.
- **Self-hosted instances no longer all go by "Harmony".** The installer offered Harmony, the
  software's name, as the instance name, so other servers listed every instance that kept it under
  that one name, in invite cards and server lists alike. The installer now offers the instance's
  domain (`chat.example.org`), and asks you to confirm Harmony if you type it. Unattended installs
  take `--name` or `HARMONY_INSTANCE_NAME`, else the domain. The instance actor now carries the
  name set in the admin panel, as NodeInfo already did.
- **Renaming the instance reaches its link previews.** A name set in **Admin** → **Config** →
  **Branding** did not reach the server invite page, the invite badge and card widgets, the Drive
  link page or the post and invite oEmbed, which kept the name from the instance's configuration
  file in their titles, "Open in …" buttons and site name. `/instance-info`, which the desktop and
  mobile apps read when adding an instance, and `/health` kept it too. All of them now use the
  admin panel's name, within 30 seconds of a change.
- **A deleted direct message leaves the conversation list.** The preview under a conversation in
  the DM list showed "[deleted]" after a reload once its last message was deleted, and the deleted
  text itself when the message was deleted on another instance, by the other person, or on another
  of your devices. It now shows the message before it, at once on every device, for everyone in
  the conversation; with nothing left it reads "No messages yet". A conversation you open again
  no longer shows messages deleted while it was closed.
- **A server invite's Markdown badge works in chat.** Pasting the badge from **Add to your
  website** (`[![Join …](…/badge.svg)](…/invite/…)`) sent stray brackets, the badge image and the
  bare invite URL. It now sends one link to the invite, labelled "Join …", with the invite card
  below. `![alt](https://…)` sends a link to the image labelled with its alt text, and `\[` and
  `\]` in a link label stand for brackets.
- **A closed invite names the other instance by its address.** The card of an invite to a server
  on another instance that takes no outside members said "Only people on Harmony can join this
  server." whenever that instance kept the default name. It now names the instance's domain, as
  the invite dialog does.
- **Uploads survive a dropped request.** An attachment, avatar, banner or server icon under 6 MB
  whose request failed on the network or stalled ended in "Network error", as some did in Firefox on
  Android. The request is now sent once more a second later, or once the device is back online, and
  an upload the instance had stored, with only its answer lost, completes.
- **Public NeoDB posts appear on imported profiles.** Posts fetched from an account's outbox
  now use the same visibility rules as incoming federation activities, recognizing NeoDB's
  compact `as:Public` audience instead of treating public posts as direct messages.
  (#214, ZaneH)
- **Who a federated post is for is read one way everywhere.** A post whose audience was stated
  on its Create activity alone lost it: followers-only and public posts became unlisted, and a
  direct message became an unlisted post on the sender's profile. A message to an
  account whose name begins with "followers" was taken for a followers-only post and shown to
  the sender's followers. A followers-only post sent to a personal inbox was refused when its
  followers address and the stored one differed by a trailing slash. Recipients written as
  objects were not read; they are now read by their `id`, as Mastodon, Misskey and Pleroma read
  them. The followers collection is now the one the author's profile declares, else
  `<actor>/followers`, as on Misskey.
- **A post addressed to nobody is private.** A fetched post, reply or boosted original that
  names no audience was stored as unlisted, readable by every account here and shown on public
  profile pages; it is now direct, as on Mastodon. A direct message naming no account here is
  no longer stored as a conversation among remote accounts. Opening a Harmony server as a
  profile no longer imports its channel messages as posts. An incoming message to hundreds of
  thousands of addresses took seconds of processing; its addresses are now read in linear time
  and a direct message resolves at most 250 of them.
- **Encrypted thread replies are readable.** In an end-to-end encrypted channel, thread replies
  showed as scrambled text in the thread panel and the full thread view, to their sender too.
  They now read as plaintext for every member holding the channel's keys, after sending, editing,
  reopening or unlocking encryption. The message a thread was started from showed its ciphertext
  in the full view, and in the panel once it refreshed; it is decrypted too. (#181, #217, ZaneH)

### Changed

- **A quieter DM header.** A DM or group shows **Call**, **Search** and **More options** (⋮). A
  call starts with your camera off, and the call bar turns it on while it rings or after it is
  answered; **More options** holds **Add people**, **Start video call** for video from the first
  second, and **Activities**.
- **Send any kind of file.** Chats and Drive take every file type, as Discord does: an APK, an
  executable or a JSON file no longer stops at "isn't allowed". A type your instance's storage does
  not serve as itself is stored as a download under its own name and shows as a file card; HTML,
  SVG, XML and scripts are always stored that way, so nothing sent opens as a page. Size limits are
  unchanged.
- **One Activities button in calls.** Watch or listen together and the games share one
  **Activities** dialog behind the popcorn button: in a call on this instance's servers it offers a
  link or a Drive file to watch together above the games; elsewhere it lists the games. The voice
  dock drops from 14 controls to 10 in three groups parted by separators (the call, what plays in
  it, the view): **Participants**, **Spatial audio**, **Voice settings** and **Pop out call** sit
  under **More options** (⋯). Arrows pointing out open a larger view and arrows pointing in a smaller
  one, in the dock, the minimized dock and the call view alike; the square corners mean full screen
  only, and floating the dock has its own icon instead of Pop out's.
- **Discover communities shows more servers.** On both tabs the search and filters fold behind a
  **Search and filters** button and open folded; the tabs, the count and every active filter stay
  on screen, each filter a chip that clears it, and scrolling the list folds open controls. Other
  instances has one field: it filters the listed servers as you type, and a typed domain is offered
  as **Browse example.social** (or Enter); the known instances still filter by instance. Join sits
  beside a server's icon. A 1280×1000 window fits 4 whole cards on This instance and 12 on Other
  instances; a phone fits 2 and 4.
- **A group chat holds up to 10 people**, its creator included, as a Discord group DM. The picker
  shows the spots left and stops at the tenth person; adding or rejoining past 10 is refused with
  "This group is full". A group started on another instance arrives with everyone its message names.
  A group already larger keeps its members and takes nobody new here until it is below 10.
- **Docs and tests.** The docs cover the changes of 1.9.7, and this file has headings for 1.6.21,
  1.9.5, 1.9.6 and 1.9.7 (#220, #221, impascab). The database test of busy sign-up days passes in
  the first hour of a UTC day (#216, ROODAY).

### Security

- Channel permissions: a member who manages a channel's permissions can no longer move an
  override from one role or member to another. Moving one onto their own role or onto themselves
  handed them permissions they lack, such as Manage Messages given to a moderator role. An override
  now keeps its role or member; giving permissions to someone else adds a new override, which
  allows only permissions its author holds.
- Android: content embedded in the app (activities, YouTube and X posts, media players) can no
  longer run the app's native commands. The Android WebView handed every embedded frame the same
  bridge to the app as Harmony's own page; the bridge now answers Harmony's page only. On a
  WebView too old for that, the app runs no activities and asks to update Android System WebView.

### Notes for self-hosters

- The admin panel's statistics refresh every 5 minutes through pg_cron (`admin-instance-stats`);
  without pg_cron, opening the panel refreshes figures older than 15 minutes. Posts, messages and
  profiles are now vacuumed once 5% of their rows change. Nothing to do.
- Discord history import also has **All bridges**: communities import through every bridge, the
  instance's Discord bot included, set under **Admin** → **Config** → **General** → **Discord
  bridge** → **Discord history import**. Imports through the instance bot and hosted own-bot bridges
  need the bridge host 2.8.0 (`harmony update`).
- Behind your own reverse proxy, pass `/api/federation/activities/socket` as a WebSocket and
  `/activities/` to the web container; `docs/self-host/activities.md` has the nginx locations. The
  bundled Caddy passes both.
- Peer-to-peer calls (instances without LiveKit) send their signals through the database, which
  names the sender. Apps before 1.9.8 cannot connect peer-to-peer calls on an updated instance, and
  cannot answer or end direct-message calls there, until they update; web tabs pick it up on reload.
  LiveKit calls are unaffected.
- Peer-to-peer calls use Google STUN and no TURN unless an admin sets servers in **Admin** →
  **Config** → **Voice & video**; the public openrelay TURN relay is gone. Peers behind strict NATs
  need the instance's own TURN: `docs/self-host/voice.md` sets up coturn in shared-secret mode,
  which gives each account its own credentials.
- An instance still named Harmony from an earlier install is named after its domain by
  `harmony update`, which prints one line. A name set in the admin panel stays. To keep Harmony on
  purpose, set it again in **Admin** → **Config** → **Branding**, or answer Harmony to `harmony config`.

## [1.9.7] - 2026-11-15

### Added

- **Category permissions.** **Edit category** has a **Permissions** tab, as a channel does: the
  **Private category** switch, then each role's channel permissions as **Deny**, **Inherit** or
  **Allow**, voice included. Saving applies them to every channel synced with the category. Closing
  with unsaved changes asks first.
- **Moderators hear about new reports.** Each new report sends a notification to whoever handles
  it: a server's owner and members with Manage Messages for a report about a message in their
  server, the instance's admins and moderators for any other. It names the content and the reason,
  never the reporter, and opens the queue. The admin panel's **Reports** tab, **Server settings** →
  **Reports** and **Instance moderation** in **User settings** show how many wait. **Notify me about
  new reports** at the top of the queue turns the notifications off.
- **Custom emoji in announcements.** `:name:` in an announcement shows the instance's custom emoji
  of that name, in the pop-up, on **Today** and in **User settings** → **Announcements**. Images with
  an `https` address show too.
- **Share any profile, and let anyone read it.** **Copy profile link** comes first in a profile's
  **⋯** menu and copies its address on your instance, `/@name` or `/@name@other.server`. Visitors
  who aren't signed in now see another server's account at that address: its profile and the public
  posts your instance has received, with a link to its own server, instead of a sign-in page.
- **Refresh profile** in another server's account's **⋯** menu reads the account from its server
  now: a new name, avatar or bio shows at once. When that server can't be reached, the profile stays
  as it was.
- **Discord files are stored in the background.** With **Mirror to storage**, the gateway now also
  stores the Discord files of messages already in Harmony, and files over 50 MB: the cap is the
  instance's upload ceiling (`harmony config --upload-ceiling`). Large files are downloaded one at a
  time through a temporary file. Expired links are refreshed through the bridge. **Instance admin** →
  **Config** shows how many files are waiting, too large or failed, and the size stored. One server stores up to
  5120 MB of them (**Stored Discord files per server (MB)** under **Discord history import**, `0`
  for no limit); past it, further files keep their Discord links until the limit is raised.
- **A captcha only when a sign-up looks automated.** Admins can turn on a sign-up check with
  Cloudflare Turnstile or hCaptcha in **Admin** → **Invites** → **Sign-up check**. It appears for a
  second account from the same network within an hour, an email domain new to the instance, or a
  sign-up past a counting limit; most people never see it. It works in the apps too. Off until set up,
  and asked only while **Apply sign-up limits** is on.
- **Import emojis from other instances.** **Admin** → **Emojis** → **Import** lists the custom emojis
  seen in posts and reactions from other instances, by instance and name. Pick one or many: each
  image is copied to your instance and the emoji joins the instance emojis for everyone here, with
  its licence and where it came from kept. A name already in use is offered under another name or
  can be skipped; an existing emoji is never replaced. **Re-host** is now **Copy image to this
  instance**: it only changes where an existing emoji's image is served from.
- **Discord bridge soundboard sync.** The Discord bridge can sync a server's
  soundboard (`/bridge sync-sounds` in harmony-discord-bridge) through three
  bot-gateway endpoints for the server's bridge bot: `GET
  /servers/{id}/sounds`, `POST /servers/{id}/sounds/discord` and `DELETE
  /servers/{id}/sounds/{soundId}`. The bridge deletes only sounds it imported:
  a sound a member uploaded answers `403` `SOUND_NOT_LINKED`.
- **Discord bridge sticker sync.** The same bridge bot can sync a server's
  stickers through `GET /servers/{id}/stickers/discord` (the sticker limit and
  the Discord-linked stickers, removed ones included), `POST
  /servers/{id}/stickers/discord` (copies a PNG, APNG or GIF sticker from
  Discord's CDN; Lottie stickers are refused with `422` `STICKER_FILE`) and
  `DELETE /servers/{id}/stickers/{stickerId}`, which retires the sticker: it
  leaves the picker and the list and no new message can use it, while old
  messages keep showing it. The bridge retires only stickers it imported
  (`403` `STICKER_NOT_LINKED` for a member's), and a server keeps the 60 retired
  last. A message that names a removed or unknown sticker now answers `422`
  `STICKER_REFUSED`.
- **Discord bridge emoji sync.** The same bridge bot can sync a server's emoji
  through `GET /servers/{id}/emojis/discord` (the server's emoji limit and its
  Discord-linked emoji, removed ones included), an `update` flag on `POST
  /servers/{id}/emojis/discord`, and `DELETE /servers/{id}/emojis/{emojiId}`.
  The bridge removes only emoji it imported (`403` `EMOJI_NOT_LINKED` for a
  member's, also one linked by name) and restores only emoji it removed (`403`
  `EMOJI_REMOVED` for one a person removed); a server keeps the 500 it removed
  last.
- **Bot API: gateway capabilities.** `READY` and `GET /users/@me` carry
  `capabilities`, the features this gateway has (`bridge_sound_sync`,
  `bridge_emoji_sync`, `bridge_sticker_sync`, `bridge_history_import`,
  `bridge_privacy`), so a bot can tell an older gateway without calling a
  route that answers `404`.
- **Import Discord history.** A Discord bridge you run yourself can copy a
  paired channel's older messages, threads and pins into its Harmony channel,
  with their original dates and Discord authors. Start it with **Import
  history** or **Import all** in Server settings, Discord Bridge, or with
  `/bridge import-history` in Discord (bridge 2.6.0 or later); each start asks
  for a confirmation. Imported messages are quiet: no notifications, unread
  counts, pings or federation, and a repeat or a restart never duplicates a
  message. Reactions are not imported.
  - It is off until the instance's admin turns it on (**Admin** → **Config** →
    **Discord bridge** → **Discord history import**), and never runs through
    the instance's Discord bot or a bot the instance runs for a community.
  - Messages from people who have left the Discord server are skipped, the
    bridge pins a notice in each Discord channel it imports, and a Discord
    channel that `@everyone` cannot see is imported only when started on
    Discord by someone who can see it.
  - The instance limits how many imports run at once (1) and how many
    messages each stores per minute (600), and with AutoMod's **Exempt bots**
    off a server's blocking keyword, invite and link rules apply to imported
    messages.
- **Bridge privacy.** Discord members decide about their own messages with
  `/bridge-privacy` on Discord: `opt-out` keeps them out of the Harmony server
  from then on, live and imported, `erase` also deletes what the bridge
  already brought, `opt-in` and `status` do what they say. Opting back in,
  or a manager's **Restore**, brings later messages only: history import
  leaves out what the member wrote before. It works with every kind of
  bridge: the member list, mention suggestions and mentions leave out
  opted-out members whatever a bridge sends. For someone who cannot run it, members with Manage Server
  remove a Discord user by ID under **Server settings** → **Discord Bridge** →
  **Bridge privacy**, where **Remove all bridged messages** clears the whole
  server and stops its unfinished imports; instance admins have **Remove all Discord messages** for the
  instance, which also turns Discord history import off. A long erase
  finishes in the background, across restarts. Erasing on Harmony never
  deletes anything on Discord.
- **Bot API: bridge privacy and import limits.** `/bridge/v2/privacy` lists a
  server's opted-out remote users and takes opt-out, opt-in and erase; a
  relayed message or edit of an opted-out author answers `403`
  `BRIDGE_AUTHOR_OPTED_OUT`. `/bridge/v2/config` carries `history_import` and
  `privacy_version`. The import routes answer `403` `import_disabled` while
  import is off, `429` `import_busy` and `import_rate_limited` with
  `Retry-After`, and reject a message that cannot be stored alone (`rejected`
  with `invalid`, `future_date`, `opted_out`, `before_opt_in`, `automod`) instead of failing its
  batch. See the developer docs, Build → Writing a bridge.

### Fixed

- **A Discord reply to a message that is gone arrives without the reply.** A reply relayed
  from Discord to a message erased or purged on Harmony was dropped (`500`); it is now sent
  without the reply link, as Discord shows it. A bot naming a message of another channel gets
  `400` `REPLY_OUT_OF_SCOPE`.
- **Select and copy inline code, settings and dialog text.** Inline code in messages, and the
  text of settings pages, dialogs, profile cards and the audit log, could not be selected. They now
  select like message text; buttons, tabs and switches still do not. (#204, ROODAY)
- **Creating a server no longer fails because of a private server's name.** A server's address
  comes from the Latin letters and digits of its name. When a private server you couldn't see
  already held that address, creating the server failed: めじたぐharmony支部 could not be created
  while a private server's address was `harmony`. It now takes the next free address.
- **A server's custom emojis on other instances.** Members who joined a server from another
  instance saw none of its custom emojis in the emoji picker or in `:name` suggestions. The server
  now sends its emojis to the instances its members are on, and keeps them current as they are
  added, renamed or removed; each shows in that server's section of the picker, and a reaction or
  message with one shows the same emoji on the server. The images stay on the server's instance.
  Both instances need 1.9.7: a server joined earlier gets its emojis the next time a member opens
  it.
- **Every emoji picker lists the same emoji.** The reaction picker showed **My Emoji**, the
  instance's emoji and **AI Generated** only once the composer's picker had been opened.
- **Emoji pickers on phones leave the keyboard down.** Opening the reaction or composer emoji
  picker put the cursor in its search field, and the on-screen keyboard covered most of the list.
  Tap the search field to type.
- **Pasted Discord file links play again after they expire.** With **Refresh on demand**, only
  messages a bridge relayed from Discord got new links; a `cdn.discordapp.com` link someone posted on
  Harmony stopped loading a day later. Viewing it now has the instance's Discord bot re-sign it, as
  it does for a bridged message whose bridge is offline. The message is not marked edited. Needs
  **This instance's Discord bot** set up and offered to communities (**Instance admin** → **Config**
  → **Discord bridge**).
- **Large servers list every member.** Past 1000 members, the member list, the member count and
  `@` suggestions stopped at 1000 on an instance with a row limit, and in any server that size the
  name of someone who had left turned into "Unknown User". The count now comes from the server, the
  list and the suggestions reach every member, and authors keep their names.
- **My Emoji shows your current avatar.** After you changed your avatar, the emoji picker's
  **My Emoji** section kept the old one for up to 15 minutes. It now changes with it, and the
  instance's section with the instance's name and icon.
- **`:P` suggests 😛.** Beside a custom emoji whose name starts with p, typing `:P` listed that
  emoji alone and Enter inserted it. The emoticon's own emoji now leads the list; the same for
  `:D`, `:O`, `:s` and `:p`.
- **Discord bridge: finding a message by its Discord id reads an index.** The bridge asks for the
  Harmony message behind a Discord message on replies, edits, deletes and reactions it has no record
  of (`GET /channels/{id}/messages/lookup`), and the gateway does on a message relayed twice. Both
  read every message of the channel, and every message of the instance when the id was not there.
- **Pinned messages show bridged, webhook and bot authors.** Pins of messages from the Discord
  bridge, webhooks and bots listed "Unknown"; they now show the same name and avatar as in chat.
- **`@` before a name no one has is plain text.** `@5:32`, `@asdfgh` or any `@name` that is no
  account on your instance shows as you typed it, in the message field and in the message, instead
  of a mention that pointed at nobody. Messages sent before show the same way. Names picked from
  the list, or typed exactly as a member's username, are mentions as before. `@name@server` handles
  of other servers are not affected.
- **A reply to a message with an emoji is one line tall again.** The line above the reply drew the
  emoji, even one cut off at the end, 300 px tall, so the replied-to name sat alone between two
  empty gaps.
- **Blocking holds in direct messages, both ways.** While one of you blocks the other, neither can
  send a message, post a call notice or start a new conversation, including from accounts on other
  servers, until the unblock. The person who blocked sees **Unblock** in place of the message field;
  the other gets "Your message could not be delivered" at once instead of a message that retried
  and failed. A blocked account can no longer add you to a group, or back into one you left.
  **Block** never removes a block already in place: on a screen that had not caught up, pressing it
  could unblock.
- **Instance emojis and your own in `:name` suggestions.** Typing `:name` offered them only after
  the emoji picker had been opened once; it now offers them from the first keystroke.
- **Live messages no longer stop until you open another chat.** When the app could not renew your
  sign-in on a flaky connection, it went on with the instance's public key, which closed every live
  feed of the tab: the open conversation or channel, the conversation list, notifications, typing,
  voice channels and the channel list. They stayed closed after the renewal went through, until
  another chat was opened or the app reloaded. The app now keeps its current sign-in until the
  renewal succeeds, and a conversation, channel or notification feed closed this way opens again
  with the next renewal.
- **Other tabs stayed half signed in after a sign-out on a bad connection.** When signing out could
  not reach the server, the other open tabs and windows were not told: they kept showing the
  account while every live feed and request went out signed out, until a reload. They now sign out
  with it.
- **Watch together** plays for the member who starts it again. After they had hidden an earlier
  activity in the call, or when their profile id differs from their sign-in id, their own video
  stayed hidden while everyone else saw it.
- **Watch together at a zoom level other than 100%.** In a browser and in the Android app, with
  **Appearance** → **Zoom level** changed, the video sat away from its place in the call bar and
  in the call view, smaller or larger than it, and the place itself stayed black. It now covers its
  place at every zoom level.
- **Watch together in the Windows, Linux and Android apps.** YouTube, SoundCloud and Spotify
  showed a black frame there: the app's own content rules refused the player page. Those apps now
  load it from your instance, as the macOS and iOS apps do.
- **Link previews and GIFs on public pages.** Visitors who aren't signed in saw every link of a
  post as its address on `/@name`, `/@name@example.social` and a post's own page: no preview card,
  and a link to a GIF as text. They now see the preview stored with the post, the GIF itself, and a
  link to an image or video file as that file. Nothing is fetched when a visitor opens the page.
- **Watch together in the full call view.** Since 1.8.3 the video played behind the call view:
  its place there stayed black while the call bar's small player showed it. It now shows in the
  call view.
- **Watch together in full screen.** With the call view in full screen, the video's place was black
  and its timeline lay across the call's controls. The video now fills the screen; the call's
  controls, the timeline and the title float over it, hide while the pointer rests and come back
  when it moves.
- **Watch together plays only what the call started.** Another member of a call could make your
  app play a link of their choosing at once, with no invite. Members of a call now change only the
  play, pause and position of what is already playing; what plays comes from the server.
- **Custom emoji of accounts on other instances on public pages.** An account on another instance
  that edited its profile showed `:shortcode:` text instead of its custom emoji in its name and bio
  on public profile and post pages. Profiles stored that way are corrected by the upgrade.
- **Bluesky accounts bridged to the fediverse, and other usernames with a dot.** Searching
  `@name.bsky.social@bsky.brid.gy` (Bridgy Fed), a Threads account such as `@john.doe@threads.net`,
  or any account whose username has a dot found nobody; it now finds the account, which you can
  follow and mention. Self-hosted instances could not store such accounts at all; they can now.
- **Opening a remote profile no longer fetches it every time.** A profile whose bio held a link and
  no custom emoji was fetched again from its instance, outbox included, every time anyone opened it.
  It now opens from the stored profile, which is read again in the background at most once a day,
  when someone opens it and the stored copy is over a day old, as Mastodon and Misskey do. Profiles
  found by search also keep the instance's shared inbox and the account's creation date, which the
  spam checks use as its age.

### Changed

- **The member list loads as you scroll**, as on Discord. A server of more than 200 members shows
  its groups and their counts at once and fills in the members near what you see; searching the list,
  `@` suggestions, the kick and ban picker, `from:` in message search and the member pickers of roles,
  private categories and bot commands ask the server, so any member can be found by name. The app no
  longer reads every member of every server at start-up. In a server of more than 1000 members,
  others' presence updates within about 20 seconds.
- **Your own status shows at once in the member list**, in a server of any size: online, away or busy
  where you chose, and **Offline** while you are invisible, as others see you.
- **Emoticons convert as on Discord.** The set is Discord's: `:')` is 🥲, `:'D` 😂, `8-)` 😎, `O:)` 😇,
  `>:(` 😠, `]:)` 😈, `,:)` 😅, `;(` 😭, `:*` 😗, `:s` 😒, with the `=` and nose variants of each.
  `:D` is 😄 and `:(` is 😦, as Discord has them. `:p`, `xD` and `:/` still convert.
- **Emoji names follow Discord where they differed.** `:sunglasses:` is 😎, `:dog:` 🐶, `:cat:` 🐱,
  `:kiss:` 💋, `:umbrella:` ☔, `:snowman:` ⛄, `:pencil:` 📝, `:calendar:` 📆, `:satellite:` 📡,
  `:train:` 🚋, `:post_office:` 🏣, and `:tiger:`, `:horse:`, `:cow:`, `:pig:`, `:camel:`, `:mouse:`,
  `:rabbit:` and `:whale:` are the animal's face. The emoji that held those names answer to
  `:dark_sunglasses:`, `:dog2:`, `:cat2:`, `:couplekiss:`, `:umbrella2:`, `:snowman2:`, `:pencil2:`,
  `:date:`, `:satellite_orbital:`, `:train2:` and the like. A message that holds one of the 19
  names as typed text shows the other emoji now.
- **Group conversations take messages from someone you blocked**, collapsed for you as in Discord.
  One member's block used to stop that person writing in the whole group.
- **Bot API:** importing a Discord emoji through the bridge now respects the server's emoji limit
  (`409` with `"code": "EMOJI_LIMIT"`) and name uniqueness (`409` with `"code": "EMOJI_NAME_TAKEN"`).
- **Drag and shrink images in the media viewer.** With a mouse, an image moves under a drag at any
  zoom, past its own edges too, and stays where you leave it while you zoom with the wheel. The
  wheel, the zoom-out button and the **-** key now go on below the fitted size, down to a tenth of
  it. Zooming out from a close-up stops at the fitted size and centres the image; a double click
  does the same from anywhere. A tall screenshot or other image shown small now zooms up to three
  times its real size, and the wheel zooms smoothly on a trackpad.

### Notes for self-hosters

- Discord history import is off after the upgrade. To let communities import through bridges they
  run themselves, turn it on under **Admin** → **Config** → **Discord bridge** → **Discord history
  import**, and read the notes shown there first. The same section holds the import limits.

## [1.9.6] - 2026-11-10

### Fixed

- **The message field no longer locks after switching servers.** A switch could leave "You do not
  have permission to send messages in this channel" in place of the field until a reload, on 1.9.5
  instances.

## [1.9.5] - 2026-11-10

### Added

- **Slash commands for bots.** Bots register commands with `PUT /commands`; members pick them from
  the `/` list in server channels and threads, fill in typed options (text, numbers, true or false,
  choices, members, channels, roles) and the bot receives `INTERACTION_CREATE`. It answers within
  5 seconds, or defers for up to 15 minutes, publicly ("Alice used /weather") or only to the member
  who ran the command. Shapes follow Discord's; permissions are Harmony permission names. Not in
  encrypted channels or direct messages. See the developer docs, Build → Slash commands.
- **Invite widgets for your website.** The invite dialog's **Add to your website** gives a badge,
  a Markdown badge for READMEs and forums, a join button, a small icon and a card to frame. Each
  shows the server's name and counts and links to the invite.
- **Animate custom emoji** in **User settings** → **Appearance**. Off, animated emoji show their
  first frame, on your screen only. **Reduce motion** does the same.
- **Backslash escapes in messages.** `\*not italic\*`, `\@name`, `\#channel`, `\:emoji:`, `\> line`
  and `\https://link` show as typed, and an escaped mention pings nobody. Inline code keeps its
  backslashes.
- **Instance limits.** Ceilings on what one local account creates and how fast it writes, set in
  the admin panel: servers (100) and bots (25) per account, and rates for messages, posts,
  reactions, follows, server joins, new servers and conversations with strangers. Bots have an
  overall REST ceiling (600 per minute; 3,000 for a linked Discord bridge). An admin can exempt an
  account in **Users**. **Stored files across the instance** adds an optional Drive total.
- **Following import.** **Account migration** takes Mastodon's `following_accounts.csv` or Harmony's
  data export and follows the accounts on it in the background, with the result per account. Locked
  and remote accounts get a request; blocks apply. Posts and likes are not imported, as on Mastodon.
- **Copy your old profile.** After a confirmed move, the new account can copy the old one's display
  name, bio, avatar, banner and profile fields. It is optional and asks before replacing anything.
- **Who can start a conversation.** **Privacy** → **Direct messages**: everyone, server members and
  people you follow, or only people you follow. It also applies to other instances.
- **Sign-up limits.** Disposable email addresses and a sixth account on one inbox in 30 days are
  refused. Disposable mail is also recognized by the mail server behind a domain, so a service's new
  domains are refused too. Accounts per network and per domain in a day are counted, and refused only
  if an admin turns that on, so a campus or office signing up together is not affected. An admin can
  add domains, mail hosts, addresses and ranges to refuse, and list domains that are never limited.
  **Admin** → **Invites** → **Sign-up limits**.
- **Signups tab for staff.** **Admin** → **Signups** lists recent accounts with their email domain,
  shows groups created together, and suspends or unsuspends a selection with one reason. Members can
  report an account for username hoarding or trading.
- **Delete accounts and free their usernames.** Administrators can delete selected accounts in
  **Admin** → **Signups**. The usernames become free at once.
- **Platform names are reserved.** New accounts and renames cannot take the names of 35 large
  services and platforms, such as `discord`, `google`, `openai` and `twitch`. Accounts that already
  hold one keep it.

### Fixed

- **Live updates no longer stop for a whole instance.** Realtime allowed 200 connected clients, 100
  channel joins and 100 messages per second across an instance. Past those, new clients got no live
  updates, a restart could keep disconnecting everyone, and live messages stopped for up to a minute:
  one edit of a server with a few thousand members was enough. `harmony update` raises all three.
- **Encrypted channels across instances.** A server hosted on another instance now shows the lock
  on encrypted channels and the private mark on hidden ones. Accounts from other instances can no
  longer join an encrypted voice channel, where they heard nothing and were heard in plaintext;
  they are told why, and anyone already connected is removed when encryption turns on. In an
  encrypted text channel the message box says why they cannot post, instead of the message
  vanishing.
- **Leave thread does something you can see.** The thread drops off your sidebar until you join or
  post in it again, and the right-click menu shows **Join thread** when you aren't a member. The
  member count follows joins and leaves.
- **Thread drafts stay put.** Text and attachments you leave in a thread opened from the sidebar
  are still there when you come back, after a reload too, and each thread keeps its own. A thread
  you start on a message keeps its draft until you send the first reply.
- **A thread you are reading no longer notifies you.** Replies and mentions in a thread open full
  page make no notification on any of your devices, as in an open channel. Opening the thread marks
  its notifications read, and a mention in a thread opens that thread.
- **Threads read as one conversation.** The starter message scrolls with the replies instead of
  holding the top of the panel and the full view, and the gap under the reply count is gone. The
  thread menu has **Go to first message** and **Show in channel**. The full view's thread menu now
  opens at all; a click on it used to close it again.
- **Links to threads and messages read as references**: `#channel › thread` for a thread or a
  message in one, `#channel` for a message in another server or a DM. A link to a place you cannot
  read stays a plain URL.
- **Mention suggestions take any display name**: kana, kanji, Hangul, accents, full-width letters
  and names with spaces, also while an input method is still composing, and with the full-width
  ＠ of a Japanese input mode.
- **X and Instagram links lose their newer share trackers.** Posts copied from X on the web carry
  `?a=…` and Instagram links `?vrfl=…`; both are now removed with the earlier ones, on the sites and
  their embed mirrors.
- **Default emoji in reply previews** use your emoji pack instead of the system's.
- **Formatting no longer runs inside inline code**: `` `*a*` `` shows its asterisks.
- **Scrolling up right after opening a channel** no longer pulls you back to the newest message.
- **Quoted posts show in place.** A quote reached through a boost, a search or a profile stored
  only a link to the quoted post, as did one whose read failed. The post is now read when you see it.
- **Device linking** on one computer: the signed-in device's button now reads **Show a code to scan
  or copy instead**. It said the new device needed a camera.
- **Refused voice joins across instances.** A person refused by a voice channel on another instance
  now sees the reason at once instead of waiting 20 seconds for a timeout, and no longer stays
  listed in the channel. Works when the hosting instance runs this version.
- **Federated calls in the admin panel.** The **Allow federated voice calls** switch under
  **Config** → **Voice & video** never changed anything. The tab now shows the state the backend
  reports; `ALLOW_FEDERATED_VOICE` decides it.
- **Admin config keeps what you type while it loads.** A value typed in **Admin** → **Config**
  before the stored settings arrived was overwritten, and after a failed load, saving branding
  wrote defaults over the stored values. Each tab now stays locked until its settings are read,
  and says so when the read fails.
- **Installing and updating on arm64.** Harmony 1.9.4's gateway image, `kong:2.8.5`, has no arm64
  build, so `harmony install` and `harmony update` stopped at the image pull on arm64 servers. The
  stack now runs `kong:3.9.4`, and CI checks every image for amd64 and arm64.
- **Messages pausing after a link to a channel you cannot open.** Each channel the server refused
  stopped everything else on the connection for 5 seconds, messages included, up to 30 seconds for
  one link. A refusal now costs about 100 ms and is not retried.
- **Servers with some 90 or more private voice channels.** Opening one took the slots live chat
  needs and could leave the connection stuck for minutes. Harmony now follows 60 private voice
  channels of a server live and reads who is in the others every 30 seconds.

### Changed

- **Bot API:** message text over the instance's length limit answers `400` on create and edit, in
  place of `500`.
- **Bot API:** a message history read returns at most 100 messages and a member list at most 1000;
  a `limit` that is not a whole number takes the default instead of failing. Bot audit rows record
  their server and channel. While the rate-limit check fails, all of a bot's requests also count
  together, up to 3000 a minute.
- **The self-host data API runs PostgREST v14.18**, in place of v12.2.12. CI now tests the same
  version self-hosted instances run.
- **Newer self-host services:** storage-api v1.90.0, whose resumable uploads fail cleanly when a
  connection dies mid-write, Realtime v2.153.6, imgproxy v4.0.22, and with log collection on,
  Logflare 1.50.15 and Vector 0.53.0.

### Security

- Federation, API routes and database functions check what a request acts on, not only who sent
  it. Update to this release.

### Notes for self-hosters

- Supabase Studio is off unless you choose it. An install that never chose has it removed by
  `harmony update`, which prints one line; `harmony studio on` brings it back.
- Sign-up limits and the auth service's per-address limits read the client's address from
  `Sb-Forwarded-For`, which the bundled Caddy sets. Behind another proxy, follow
  [The client address](https://docs.mony.lol/self-host/signup-limits#client-address).
- `harmony update` deletes its own old backups after it succeeds, keeping the newest 5 that changed
  the version and the newest 5 of runs with no new code. The first update on this version can delete
  many at once. To keep them all, set `HARMONY_KEEP_UPDATE_BACKUPS=0` in `self-host/.env` before
  updating. Backups from `harmony backup` and restores stay.
- If you worked around the arm64 error with `docker-compose.arm64.yml`, delete that file and the
  `COMPOSE_FILE` line it needed from `.env`. The instance keeps working if you leave them, on Kong
  2.8.1.
- Installing under a restrictive umask such as 077 or 027 works: `configure.sh` gives the database
  init scripts and mounted files the modes the containers need, and `harmony doctor` checks them.
  An install that already failed this way needs a fresh database: see
  [A restrictive umask](https://docs.mony.lol/self-host/troubleshooting#umask).
- An instance whose `JWT_SECRET` has fewer than 32 characters keeps PostgREST v12.2.12, because later
  versions refuse to start with it. `harmony doctor` warns and says how to replace the secret.
- Instance limits are on after updating, at values well above ordinary use. Stored `antispam`
  values stay as they are; the tighter new-account limits start only on a new install. A script
  writing as a normal account or a v1 or non-Discord bridge can reach them: raise the limit under
  **Anti-spam**, or exempt the account in **Users**.
- Clients can no longer insert into `public.bots`. `create_bot` is the way to make a bot.

## [1.6.21] - 2026-10-08

### Added

- **One-command self-hosting.** `curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash`
  installs an instance on a blank Linux server: it checks the host (offering
  Docker and a swap file), asks a few questions, checks DNS, starts the
  stack, loads the database and creates the admin account. Re-running it is
  safe.
- **`harmony` command** for operators: `update`, `doctor`, `backup`,
  `restore`, `status`, `logs`, `admin create | reset-password | invite`,
  `registration open | invite | closed`, `config`.
- **`harmony doctor`** checks DNS, certificates, containers, migrations, the
  instance domain, federation through the public URL, the bot gateway, voice,
  push, email, disk, memory, backup age and versions, each with a fix.
- **Discord bridge hosting** on self-hosted instances: the `discord` profile
  runs communities' bridges once hosting is enabled in Admin, Instance.
- Prebuilt images on GHCR: `harmony-web`, `harmony-federation` and
  `harmony-bot-gateway` for amd64 and arm64.

### Notes for self-hosters

- `self-host/` runs Harmony's services from `ghcr.io/y4my4my4m/harmony-*`
  images instead of building them: `HARMONY_VERSION` in `.env` follows the
  checkout (`X.Y.Z` on a release tag, `edge` on master). `HARMONY_BUILD=1
  bash configure.sh` keeps building locally (`docker-compose.build.yml`).
- The web image reads its configuration at start (`/config.json` from the
  container environment): one image serves every instance, and a domain or
  key change needs `docker compose up -d`, no rebuild. `VITE_SUPABASE_URL`
  and `VITE_SUPABASE_ANON_KEY` leave `.env`; `SUPABASE_ANON_KEY` replaces them.
- Caddy strips `/api/federation` before the federation backend, as nginx
  does: user lookups, GIFs, server invites, instance probes and federation
  key generation failed on Caddy installs. Caddy also pins `Accept` on public
  image renders, and `harmony update` restarts Caddy when the Caddyfile
  changes.
- `update.sh` (behind `harmony update`) merges new configuration keys, pulls
  images, backs up the database, roles and configuration into
  `self-host/backups/` before migrating, then recreates containers. An install
  on a release tag updates to the newest release.
- A new install keeps sign-up disabled (`DISABLE_SIGNUP=true` in
  `supabase/.env`) until the installer has created the admin account, then
  applies `REGISTRATION` from `.env`. Existing installs keep their sign-up
  setting; `harmony registration` changes it.
- Docker Compose 2.24.4 or later is required. Python is no longer needed:
  `supabase-overrides.yml` replaces `trim-supabase.py`.
- The Supabase stack is pinned (`SUPABASE_REF_DEFAULT` in `configure.sh`,
  Postgres `15.8.1.060`). Installs made from master keep their current
  `self-host/supabase/` until `bash configure.sh --refresh-supabase`; take a
  backup first.
- `configure.sh` generates the Web Push (VAPID) keys, LiveKit keys and the
  internal API secret when absent, and accepts `admin@example.com` or
  `mailto:admin@example.com` as `VAPID_SUBJECT`.
- `bootstrap.sh` removes `app.settings.jwt_secret` and `app.settings.jwt_exp`
  from the database settings, where upstream Supabase's init stores the JWT
  secret for any session to read; nothing reads them there. It keeps them, with
  a warning, when a function body refers to them. `update.sh` runs it.
- `harmony doctor` checks for the traces of a known attack on exposed
  Postgres (unexpected event triggers, superusers and login roles, functions
  that manage roles or reach server files) and for database, Kong, Logflare
  and Redis ports published or reachable on the public address.
- Google, GitHub and Twitch sign-in are configured with
  `<PROVIDER>_ENABLED`, `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_SECRET` in
  `supabase/.env`.
- Images run Node 24; the federation and bot gateway images run as uid 1000
  (`node`): a volume mounted at the backend's `logs/` must be writable by it.

## [1.6.7] - 2026-10-02

### Added
- **Private calls and presence.** Voice, video and call events travel on
  private channels only the people in the room can join. Online status is
  visible only to people you share a server or conversation with and to
  followers; invisible means offline to everyone. DM calls work across
  instances.
- **QR device pairing.** Link a new device by scanning a code, in either
  direction, instead of typing the recovery phrase. A device can keep a copy of
  its keys so it can link more devices later (opt-in, removable in
  Settings › Encryption).
- **Reactions count as favourites.** Reacting to a post favourites it; removing
  your last reaction removes it. Up to 10 different reactions per person per
  post (instance setting) and 20 different emoji per chat message. Mastodon,
  Misskey and Pleroma each receive reactions in the form they understand.
- **Moderation.** Reports from messages and posts with evidence, forwarding to
  remote instances, a moderator queue; AutoMod rules per server; newcomer
  alerts for owners and moderators.
- **Bots** appear in the member list with a profile card; server owners choose
  which channels a bot may post in.
- **Onboarding.** A suggested welcome server at signup, server welcome screens
  with rules, and discovery categories chosen by the owner.
- **Two-factor authentication** enforced by the server, session management and
  data export.
- **Translations.** German, Spanish, French, Japanese, Korean and Chinese
  cover every string, including the new security, pairing and moderation
  screens.

### Changed
- **Attachments are private.** New chat and DM files are readable only by
  people in that room, through signed links; remote instances get links bound
  to them. Deleted messages' files are removed.
- **Uploads keep the original file**; only files over the size limit are
  shrunk. Images are displayed at the size shown.
- **Discover communities** opens on every click and reopens instantly from
  cache.
- **Unread counts** are computed on read: sending a message no longer slows
  down large servers, and switching servers is much faster.
- The funding heart shows only on phones; desktop uses the sidebar.

### Fixed
- Mentions of users on instances with subdomains, and email addresses turning
  into mentions.
- Chat video and audio uploads were refused.
- Chat jumping while reading history; jumps to a message landing above it.
- The composer and the feed, and the profile page's edges, no longer misalign.
- Ticking a checkbox in Voice & Video settings no longer slides the page.
- Many security fixes across the database, federation and the app.

## [1.6.2] - 2026-10-01

### Added
- **Desktop auto-updates.** The desktop app downloads new releases in the
  background and shows "Update ready" in the server rail; it restarts into the
  new version only when you click. Settings › Advanced shows the version, a
  check button and an auto-download toggle. The Android app shows a notice
  with a link when a new APK is published. This release is the last one to
  install by hand.
- **Voice and video, closer to Discord.** Per-user volume from 0 to 200% with
  a local mute that keeps the level, remembered per user. Screen share opens a
  Go live panel (720p, 1080p or source, 30 or 60 fps); stream audio is its own
  track, so viewers can turn a stream down separately from the voice. Watching
  a stream is opt-in. Tiles gain a menu button, hover volume, live and
  connection badges, grid and focus layouts, a call timer and a reconnecting
  state. Master and input volume sliders now work; master defaults to 100%.
- **Notifications inbox.** The bell opens All, Mentions and Social tabs with
  an unread filter, day groups, inline mark read and remove, and keyboard
  navigation.
- **Today**, rebuilt: announcements, mentions and replies, unread DMs, unread
  channels by server with mark read, active threads, live voice, follow
  requests and top posts from people you follow.
- **Media tab** on every profile, local and remote: a grid of photos and
  videos with sensitive media blurred.
- **Message search filters**, as in Discord: `from:`, `mentions:`, `has:`,
  `in:`, `before:`/`after:`/`during:` and `pinned:`, with suggestions, results
  grouped by channel and jump to message.

### Changed
- DM calls: the call buttons reflect only their own conversation, switching
  calls asks first, callers see ringing tiles, and missed calls say so.
- Spatial audio is off by default and remembers your choice.
- SDR-001 / Neo Kobe 1988 skin reworked: readable red and steel text, square
  frames, fixed icons, lighter scanlines. Existing users get the new
  background after picking the skin again.
- The instance funding window shows progress toward the goal and leads with
  the donation link.
- Double-click to react fires only on empty space in a message;
  double-clicking a word selects it.
- The code block copy button sits beside the language label, clear of the
  message toolbar.

### Fixed
- **@everyone and role mentions** notified everyone regardless of permission.
  @everyone now requires Mention @everyone, roles not marked mentionable need
  the same permission, and bots need it on their install.
- **Push notifications**: enabling push on one device removed it from others;
  replies, reactions and social pushes were never sent; clicks opened the
  wrong page; subscriptions that expired or rotated were never renewed. Push
  now repairs itself after sign-in without prompting again.
- A closed tab or a phone in the background kept notifications for its last
  channel suppressed indefinitely.
- Quiet hours dropped notifications instead of silencing them.
- Creating a server folder, including dragging one server onto another,
  failed.
- Desktop and Android apps: GIFs, federated server discovery and joining,
  user lookup and post links failed.
- Theme editor: the message box disappeared into the background while
  editing, and many colour swatches could not be clicked.
- The file drop overlay could stay on screen; folder tooltips could stay open;
  right-click menus did not close with Escape.
- Author names on posts showed a heavy highlight on hover; the Appearance
  dropdowns were unstyled.
- Code blocks had a blank line above and below.

### Notes for self-hosters
- Six migrations since 1.6.1 (`20261002000001` to `20261003500001`);
  `bootstrap.sh --migrations-only` applies them. Take a backup first.
  `20261003400001` changes who can ping @everyone and unmentionable roles;
  bots without `mention_everyone` on their install stop pinging @everyone.
- Rebuild the federation backend image (`docker compose up -d --build`); the
  push routes changed.
- Desktop auto-updates are signed with a key held in the release repository's
  secrets; forks that publish their own builds need their own key (see
  `docs/DEVELOPMENT.md`).

## [1.6.1] - 2026-09-30

### Added
- **Per-channel end-to-end encryption.** Channel managers (the owner, admins
  and roles with Manage Channels) turn encryption on per channel; the server
  policy (disabled, optional, required) is the floor. Encrypted channels show
  a lock, mentions still notify with "Encrypted message" as the preview, and
  voice encryption follows the channel. The database rejects unencrypted
  messages in encrypted channels, and encrypted channels do not federate.
- **Floating video player**: touch drag and resize, corner snapping clear of
  the composer and keyboard, docks back when its message scrolls into view,
  one video at a time.
- Pins and threads update immediately: the pin badge, pinned list and thread
  panel no longer wait on the server, and failures roll back with a message.
  The pinned-messages button is always in the channel header.

### Changed
- App-wide visual pass: the accent colour reaches every component, surfaces
  are flat, status colours follow the theme (light themes are readable), and
  column headers share one height. Floating surfaces keep their glass behind
  the Appearance blur toggle.
- Social: trending and suggested follows are compact lists; pinned posts line
  up with the feed.
- Private servers, and channels hidden from @everyone, are served over
  federation only to signed requests from accepted members who can view them.
  Harmony signs its reads of remote servers as the reading member, and retries
  signed when a remote instance requires authorized fetch.
- First load is half the size (1030 kB to 515 kB of JavaScript, gzipped); the
  voice library loads when joining a call.
- Server member lists and the home timeline query in milliseconds on large
  servers.
- Server privacy settings have one discovery choice instead of two controls
  for the same setting.

### Fixed
- **Federation authorization.** Undo, Accept/Reject and fetched documents are
  bound to the actor that signed them: remote servers could delete local
  posts, remove other users' follows, take over a remote actor's key, or
  attribute posts to anyone. Remote members can no longer post into channels
  they cannot view.
- **Database access.** Legacy access rules on existing installs let pending
  members read and post in every channel and let a blocked user keep posting
  in a DM; they are removed. Channel visibility is now enforced on messages,
  threads, reactions, search, live updates and notifications. Notification,
  pin and message-rewrite functions no longer trust caller-supplied identity.
- Message search returned nothing on installs created from the 1.6.0 schema.
- The federation backend retained memory for every authenticated request.
- The bot gateway could deliver the same event twice.
- GoToSocial activities were rejected; unlisted posts appeared
  followers-only elsewhere; Mastodon ignored edits; attachments and alt text
  did not federate.
- Light themes: unreadable toasts, grey dialogs and hashtag chips.

### Notes for self-hosters
- Eight migrations since 1.6.0 (`20260930000002` to `20261001200003`);
  `bootstrap.sh --migrations-only` applies them. Take a backup first.
  `20261001200001` converges RLS policies to the canonical set and prints each
  create, keep and drop. `20261001000001` turns encryption on for channels
  that already hold encrypted messages.
- Apply `20261001100001` before starting the new federation backend, and
  rebuild its image (`docker compose up -d --build`); `up -d` alone keeps the
  old image.

## [1.6.0] - 2026-09-30

### Added
- **Onboarding**: invite links survive login, registration and profile setup
  and open the invited server afterwards. Profile setup is a single form with
  the username prefilled from the email or OAuth profile. The no-servers page
  takes a pasted invite link or code, local or remote.
- **Bot developer panel**: bot ID, gateway and REST URLs, token reset with a
  shown-once dialog, and "Add to server". Bot creation and token rotation run
  as single server-side transactions (`create_bot`, `rotate_bot_token`).
- **Social**: alt text on attachments, an "N new posts" queue while scrolled,
  skeleton and error states, Requested/Unfollow follow states, and connected
  threads.
- Escape cancels the reply being composed.

### Changed
- Server discovery shows only real data: actual member counts, featured
  servers only when featured, no activity indicator on every card. Search
  matches the browse results and tolerates punctuation.
- Social timelines, tabs and post cards are flatter and labelled; one header
  per page; "Boost" throughout.
- Design-system buttons are flat fills; emoji used as icons are replaced with
  icons; auth and onboarding screens drop decorative animation.
- Server bot settings offer only the permissions the gateway enforces.
- Messages are delivered over Broadcast with authorised topics.

### Fixed
- **Profiles could be created with moderator or admin flags set.** The insert
  path accepted `is_admin` and related columns from the client; they are now
  forced to false on insert.
- **A bot could change the displayed author of other messages** in channels
  it could post in, through the message metadata route.
- The last server and channel were not remembered between sessions.
- Server custom emoji failed to load when the app opened on DMs or Social.
- On Android 15 and later the keyboard covered the message input.
- Server creation could produce a duplicate server after a partial failure.
- Invite previews showed 0 members to people outside the server.
- A temporary network error sent existing users into profile creation.
- Emoji reactions that federated back to their origin split into two chips;
  existing duplicates are repaired.
- Several listener, timer and media leaks; DM messages dropped by the
  conversation channel are recovered.

### Removed
- Settings that were marked "Coming soon" and did nothing, and an admin chart
  of hard-coded request numbers.
- The unreachable admin bot management page.

### Notes for self-hosters
- Four migrations since 1.5.0; `bootstrap.sh --migrations-only` applies them.
  `20260821000001` deletes federated duplicates of reactions and rewrites
  their shortcodes; take a backup first.
- The federation worker no longer inherits the image healthcheck, which
  reported it unhealthy while it processed jobs.

## [1.5.0] - 2026-08-06

### Added
- **Server and instance rules management**, plus follow requests and public
  instance settings backed by RLS policies.
- **ActivityPub favorites and reblogs** surfaced in notifications.
- Floating video placeholder and invite-modal settings.

### Changed
- Server icon cache invalidation and realtime server-update propagation.
- Comments across the codebase rewritten as terse declarative notes; emoji
  removed from log output.
- Documentation consolidated: `docs/FEDERATION.md` rewritten to describe the
  Node/Express federation backend it actually has, duplicate guides merged,
  `ROADMAP.md` reconciled against the open set in `BUGS.md`.
- `COPYRIGHT`, `TRADEMARK.md` and `LICENSE-ADDITIONAL-TERMS.md` completed and
  made consistent.
- `VERSION` corrected to match `package.json`.

### Fixed
- **MFA recovery codes were unusable.** Enrolment has produced 10-character
  codes since 1.2.0, but every entry field capped input at 8 characters, so
  the stored hash could never match. Anyone who enrolled after 2026-06-02 and
  lost their authenticator could not recover.

### Removed
- Deployment configs carrying real hostnames and certificate paths; only the
  `dev/*.template.conf` files ship now.

### Notes for self-hosters
- Android release APKs are signed again. The signing step decoded its keystore
  with `base64 -d`, which rejects the input outright on a stray carriage return
  or wrapped line, so every build since 1.4.0 silently fell back to a debug APK.

## [1.4.0] - 2026-07-06

Covers 1.2.0, 1.3.0 and 1.3.1, which shipped as GitHub releases without
changelog entries. Ninety-one commits since 1.1.0.

### Added
- **Tauri desktop and Android builds** from the same codebase, with release
  signing wired into CI and a version-stamping script.
- **Discord bridge**: attachment relay, bot gateway improvements, and
  puppeting via webhooks.
- **Klipy** GIF integration with attribution watermark.
- **Encryption v2 over LiveKit**, device approval and trust management,
  offline catch-up for fulfilled key requests, and session-share repair.
- `get_user_conversations`, `get_home_timeline_page` and `get_message_page`
  RPCs for paged loading.
- `FEDERATION.md` describing the ActivityPub implementation.

### Changed
- Video chat reworked.
- Design system and component styles reworked for theming; appearance context
  now resolves per route.
- `is_private` removed from the channel model.

### Fixed
- Federation no longer drops inbound activities; reactions and counters
  propagate in realtime.
- Optimistic update reconciliation, multi-span message rendering, thread
  reply realtime, mobile composer, and media error handling.
- Recovered stranded link-preview and media commits.

### Notes for self-hosters
- The federation backend surfaces its version via `/health` and
  `/.well-known/nodeinfo`.

## [1.1.0] - 2026-05-27

First post-public-release iteration. Focus: a new visual skin, mobile/PWA
polish, federation backend cleanup, and getting the documentation site
honest about the BullMQ migration.

### Added
- **SDR-001 skin** - a noir-cyberpunk visual theme with its own pixel-art
  icon set (MIT-licensed), CRT scanline / HUD-badge decorative toggles,
  dynamic accent-color system, and matching **Neo Kobe** audio theme
  (8 new sound assets: `camera_on`, `dm`, `invite`, `mic_off`, `reaction`,
  `reply`, `screenshare_on/off`).
- **Disable backdrop-blur** toggle in Appearance settings for low-end
  devices.
- **Per-skin decorative options** persisted across sessions.
- **NoRe Sans Pixel Pro v2** font family and specimen.
- **File size** for custom emojis: new `emojis.file_size` column, captured
  during upload, displayed conditionally in `ServerEmojiManagement`.
- **Quick reply queue** in the service worker - replies typed into push
  notifications are now persisted to IndexedDB and drained on auth /
  visibility, so they survive `postMessage` races and closed-tab scenarios.
- Inline formatting toggles (bold, italic) in the rich text editor.
- Image-specific context-menu actions (copy / save image).
- `COPYRIGHT`, `LICENSE-ADDITIONAL-TERMS.md`, `TRADEMARK.md` - explicit
  copyright statement, AGPL §7 attribution requirement, and common-law
  trademark policy for the "Harmony" name and polar-bear logo.
- Self-hosting documentation for instance-customizable assets
  (background images, additional emoji packs).
- **Self-hosting docs route**: `https://docs.mony.lol/self-hosting`
  (previously the website linked to a 404 path). The old
  `/HOW_TO_SELF_HOST` URL now meta-refresh redirects to the canonical
  route.

### Changed
- **MessageContextMenu** surfaces add-reaction, reply, edit, and
  start-thread as primary actions for better discoverability; destructive
  actions are grouped separately.
- **NotificationBell** moved into its own dedicated slot in
  `UserProfileComponent`, with outside-click suppression so the panel
  doesn't immediately close.
- **UserProfileComponent** shows the full ID-card profile bar at every
  width on the SDR-001 skin (improves mobile usability).
- **Push notifications** strip emoji shortcodes from sender names and
  resolve avatar URLs to absolute paths so they render correctly across
  all platforms.
- **Federation User-Agent** now reads from `config.VERSION` (single
  source of truth in `federation-backend/src/config/index.ts`). Previously
  the User-Agent was hard-coded to `Harmony/1.0.0` because
  `config.VERSION` was referenced but never declared in the env schema.
- `/health` and `/.well-known/nodeinfo` (2.0 + 2.1) now report
  `config.VERSION` instead of a hard-coded string.
- The repo now ships a small default set of background images
  (5 login, 2 404, 2 offline) instead of the full collection. Instance
  operators can drop more `.webp` files into
  `public/backgrounds/{login,404,offline}/` and the build picks them up.
- Standardized on `npm` as the package manager (removed `bun.lockb`).
- **CI workflow**: `e2e-tests` no longer references `secrets` in a job-level
  `if:` (GitHub Actions rejects this). Secret presence is hoisted into a
  job-level `env` and read via `env.HAS_TEST_SUPABASE` in each step's `if`.
- **Documentation cleanup**: all references to the legacy pg-boss queue
  backend in `docs-source/guide/`, `docker-compose.{prod,full}.yml`,
  `dev/docker-compose.yml`, and `scripts/install.sh` have been updated
  to reflect that **BullMQ (Redis-backed)** has been the actual job
  backend since the March 2026 migration. The `USE_PGBOSS_QUEUE`
  environment variable is still accepted as a backward-compat alias
  for `USE_BULLMQ_QUEUE` - old `.env` files continue to work.
- Service worker bumped to v3.3.

### Fixed
- **EmojiPopup z-index** raised to `99999` so it stacks above modals when
  triggered from inside one. `usePopupPositioning` now accepts a
  configurable `zIndex` option (default `1050`).
- **NotificationSettings** has a `min-height` so the panel doesn't jump
  around between tabs.
- 12 bug-bash items from the public-release polish pass: chat input bug,
  voice UI inconsistencies, Escape no longer failing to close settings,
  and others.
- **Docs build no longer fails on dead links**: `docs/bot-api.md` and
  `docs/DEVELOPMENT.md` referenced `../LICENSE`, `../COPYRIGHT`,
  `../TRADEMARK.md`, `../SECURITY.md`, `../ROADMAP.md`, `../BUGS.md`
  via VitePress relative links - VitePress can't render files outside
  `docs/`. Replaced with absolute GitHub URLs. (Without this fix,
  `npm run docs:build` exited non-zero and the docs site could not be
  redeployed.)

### Removed
- `db_schema/latest_dev_backup.sql` (reference dump no longer needed).
- `db_schema/archives/` (legacy migration folder; canonical history is
  `db_schema/init/` + `db_schema/migrations/`).

### Notes for self-hosters
- No data migration required.
- Existing `USE_PGBOSS_QUEUE=true` env vars continue to work via the
  backward-compat shim. Update to `USE_BULLMQ_QUEUE=true` at your
  convenience.
- Audio assets were updated; browsers will refetch on the service-worker
  version bump.

## [1.0.1] - 2026-05-25

### Initial public release

First tagged release. Development started in January 2024; commits before this
point are in this repository's history and predate any published release.

Key features at this snapshot:

- Discord-style servers with channels, categories, threads, roles, and permissions
- Direct messages, group DMs, and reactions
- ActivityPub federation: timelines, follows, posts, and inbox/outbox
- Multi-instance servers (members from different Harmony domains in one server)
- End-to-end encryption (Megolm-style) for chat, with cross-device key sharing
- LiveKit-based voice and video for both DMs and server channels
- Bot gateway and plugin system
- Tauri desktop app and web app from the same codebase
- Self-hosting via Docker Compose; install script under `scripts/install.sh`

[Unreleased]: https://github.com/y4my4my4m/harmony/compare/v1.9.8...HEAD
[1.9.8]: https://github.com/y4my4my4m/harmony/compare/v1.9.7...v1.9.8
[1.9.7]: https://github.com/y4my4my4m/harmony/compare/v1.9.6...v1.9.7
[1.9.6]: https://github.com/y4my4my4m/harmony/compare/v1.9.5...v1.9.6
[1.9.5]: https://github.com/y4my4my4m/harmony/compare/v1.6.21...v1.9.5
[1.6.21]: https://github.com/y4my4my4m/harmony/compare/v1.6.7...v1.6.21
[1.6.7]: https://github.com/y4my4my4m/harmony/compare/v1.6.2...v1.6.7
[1.6.2]: https://github.com/y4my4my4m/harmony/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/y4my4my4m/harmony/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/y4my4my4m/harmony/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/y4my4my4m/harmony/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/y4my4my4m/harmony/compare/v1.1.0...v1.4.0
[1.1.0]: https://github.com/y4my4my4m/harmony/releases/tag/v1.1.0

1.0.1 predates release tagging and has no tag to link to.
