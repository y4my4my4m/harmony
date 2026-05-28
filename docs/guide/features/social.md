# Social Features

Harmony integrates ActivityPub-based social features alongside its chat functionality, providing a federated microblogging experience similar to Mastodon.

## Timeline

The social timeline is managed by the `useActivityPub` Pinia store with three feed types:

| Feed | Description |
|------|-------------|
| **Home** | Posts from followed users, cached locally (30-minute TTL) |
| **Public** | Public and unlisted posts from local and federated instances |
| **Local** | Public posts from local users only |

Feed switching is done via `MonyHeader` with real-time updates for new posts.

## Posts

### Creating Posts

Posts are created through the `Composer` component, which supports:

- **Visibility levels**: `public`, `unlisted`, `followers`, `direct`
- **Content warnings** with spoiler text
- **Media attachments** via `MonyMediaUpload` (images, video, audio)
- **Replies** and **quote posts**
- **Language** selection
- **Emoji** picker with custom server emoji

The composer can appear as a modal or inline depending on context. Post creation flows through `CorePostService` which inserts locally, then database triggers queue federation delivery.

### Post Display

Each post is rendered by `MonyPost`, which handles:

- Rich content rendering with markdown
- Media galleries (`MonyMediaGallery`)
- Content warning expand/collapse
- Reply threading (`ThreadedPost`)
- Embed detection (links, server invites)

## Interactions

### Reactions

Posts support emoji reactions via `PostReactions`:

- Unicode and custom emoji
- Grouped reaction counts
- One-click to add/remove

### Standard Actions

Handled by `usePostInteractions` composable and `CoreInteractionService`:

| Action | Description |
|--------|-------------|
| **Favorite** | Like/star a post |
| **Reblog** | Boost a post to your followers |
| **Bookmark** | Save privately for later |
| **Reply** | Open composer in reply mode |
| **Quote** | Share with your own commentary |

All interactions are federated automatically through database triggers.

## Follows

- Follow/unfollow users via `CoreInteractionService.toggleFollow()`
- Follow requests with pending acceptance for locked accounts
- View followers/following lists in `FollowersView`
- Follow counts on user profiles

## Explore

`ExploreView` and `ExploreContent` provide discovery features:

- **Trending posts** from the public timeline
- **Trending hashtags** via `TrendingService`
- **Suggested users** for follow recommendations
- **Instance directory** with user/post counts and instance details (`InstanceDetailModal`)

## Hashtags

- Hashtag pages (`HashtagView`) show posts for a given tag
- Clicking a hashtag navigates to its feed
- Trending tags appear in Explore

## Lists

Mastodon-compatible lists (`ListsView`):

- Create and manage custom post lists
- `replies_policy`: control which replies appear
- `is_exclusive`: remove list members from home feed
- `is_public`: make lists visible to others

## Bookmarks

`BookmarksView` provides paginated access to bookmarked posts, stored privately per user.

## Blocking and Muting

- **Block**: Hides all content from a user, prevents interaction
- **Mute**: Hides posts from timeline without unfollowing
- Managed via `CoreInteractionService` and filtered in timeline queries
- Block/mute data loaded on login via `loadBlockingData()`

## Key Components

| Component | Purpose |
|-----------|---------|
| `MonyHeader` | Top bar with feed tabs, composer trigger, search |
| `MonyPost` | Single post display |
| `MonyFeed` | Scrollable post list |
| `Composer` | Post/reply/quote creation |
| `MonyContent` | Rich content renderer |
| `ExploreContent` | Discovery UI |
| `UserCard` | User info card in lists |
| `UserSearchModal` | Federated user search |

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/features/social.md` and run `npm run docs:generate-guide` to update.
