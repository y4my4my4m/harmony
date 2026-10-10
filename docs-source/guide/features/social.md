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
- Fediverse polls (`RemotePollCard`): answers with vote shares, voters and time left, as last reported by the origin server, which sends `Update(Question)` as votes arrive. Votes are cast on the original post.
- Counts of a federated post: the replies, boosts and favorites its origin server reports, read when the post arrives and again when it is shown, plus boosts, favorites and replies made here since that read
- **Fetch replies** in the post menu reads the post's replies collection from its origin server, page by page (at most 5 pages and 200 replies), and imports each reply; Misskey posts are read through Misskey's own API. A server that publishes no replies is reported as such

## Interactions

### Reactions

Posts support emoji reactions via `PostReactions`:

- Unicode and custom emoji
- Grouped reaction counts
- One-click to add/remove
- ❤ is the favorite: picking it fills the heart and counts as a favorite, never as a chip
- Any other reaction also fills the heart: one favorite per person, however many reactions.
  Removing the last reaction empties a heart the reactions filled; a heart clicked first stays
- Unfavoriting removes your reactions on the post as well
- At most 10 different emoji per person on a post (instance setting), and 20 different emoji
  on a chat message

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
- Follow counts on user profiles. A remote account shows its own server's post, follower and
  following totals, re-read when older than six hours; a total that server withholds shows as
  `–`. Its following and followers lists hold the accounts this instance knows, with a link to
  the full list on its server

## Explore

`ExploreView` hosts two tabs of the social header:

- **Trending** (`TrendingContent`), with three sections:
  - **Posts**: public top-level posts with at least one reply, boost or favorite, ranked by
    `get_trending_posts` with a time decay whose half-life is half the chosen window. Filters:
    time range (last hour to last month), source (all instances, this instance, or one domain)
    and **With media**, which keeps posts carrying an image or video either as an upload or as a
    file part of a federated note.
  - **Hashtags**: `get_trending_hashtags`, ranked by distinct authors in the window.
  - **People**: discoverable accounts by follower count, filtered by source.
  Tab and filters live in the URL (`?tab=hashtags&range=7d&media=1&source=local`).
- **Instances** (`InstancesContent`): instance directory with user/post counts and instance
  details (`InstanceDetailModal`)

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
| `TrendingContent` | Trending posts, hashtags and people |
| `InstancesContent` | Instance directory |
| `UserCard` | User info card in lists |
| `UserSearchModal` | Federated user search |

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/features/social.md` and run `npm run docs:generate-guide` to update.
