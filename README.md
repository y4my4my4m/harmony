# Harmony

`bun install`

`bun dev` for web only
`bun tauri dev` for desktop dev

`bun tauri build` for desktop prod

## TODO

- [x] store messages
- [x] fetch messages
  - [x] lazy load
  - [x] load more messages on scroll
- [x] realtime messages
- [x] invites
- [x] settings
- [x] login
- [x] register
- [x] logout
- [x] server settings
- [x] profile picture
- [x] servers
- [x] channels
- [x] channel categories
- [x] channel type
- [x] channel drag & drop
- [x] channel order
- [x] category order
  - [x] has or
  - [x] reorganize order
- [x] realtime status
  - [x] changes
  - [x] bug in self status display
- [ ] app
  - [x] mobile web
  - [x] PWA mobile
    - [x] service worker for notifications
  - [x] PWA desktop
  - [ ] desktop app using Tauri necssary?
- [x] uuid for filenames
  - [x] profile pictures
  - [x] server icons
  - [x] user media

- [x] file uploads
- [x] files upload
- [x] emojis
  - [x] server emojis
  - [x] cross server emojis
  - [x] emoji display
  - [x] emoji picker
  - [x] emoji in textarea
  - [x] emoji search  
- [x] tenor implementation
- [ ] media embeds
  - [x] images
  - [x] videos
  - [x] links
  - [~] url previews
  - [ ] audio
  - [ ] files/binaries
- [x] markdown
- [x] profile changes
- [ ] server order
- [ ] forgot password
- [ ] reset password
- [x] notifications
- [x] mentions
- [x] reactions
- [ ] threads
- [ ] personal drive
- [ ] personal pages
- [ ] activitypub
- [ ] spaces
- [x] public/private
- [x] voice
  - [ ] e2ee
- [ ] voice positioning
  - [x] voice positioning UI
  - [ ] functionality
- [x] video
  - [ ] e2ee
  - [x] screen share
  - [ ] video filters
  - [ ] video backgrounds
- [ ] federation
- [ ] e2e encryption
- [ ] permissions
  - [x] db somewhat
- [ ] moderation
- [ ] admin
- [ ] smart fetching
- [x] smart caching
- [ ] search
- [ ] crypto transfers
- [x] remote db
- [x] remote storage

--- DB Functions

-- Check current system health
SELECT get_trending_maintenance_stats();

-- Run full maintenance manually
SELECT run_trending_maintenance();

-- Just clean up hashtags
SELECT cleanup_inactive_hashtags();

-- Stop CRON for trending
SELECT pause_trending_cron_jobs();

-- Start CRON for trending
SELECT resume_trending_cron_jobs();
