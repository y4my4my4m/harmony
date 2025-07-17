1. the sidebar profile view goes out of bound if the screen is too small
2. the profile view on clicking a username might be out of bound (if too close to top or bottom of the screen)
3. search
5. system messages aren't real time
6. "accepting invitation" is bugged
7. re-instore context based notifications so that you don't get a notification if currently viewing the channel or dm or whatever
8. message display has it's own "fetchUserProfile" logic, the cache system is good but we should definitely use the useUserState or whatever to ensure we have one source of truth, currently components that arent from that do not properly show "created_at/member since". However we must ensure that the cache system in useUserState (or whatever we call it) is solid.
9. do we still need that? "fetchMultipleUserProfiles"
10. these appear twice, maybe route watching and prop watching?
  - 🔍 UserSidebar: Server 9895ae8a-b25a-475b-b2f1-3bd3e2dffeab users from context: 9 
  - 🔄 Subscribing to server context: 9895ae8a-b25a-475b-b2f1-3bd3e2dffeab (9 users)
  - 👋 User joined server 9895ae8a-b25a-475b-b2f1-3bd3e2dffeab: poring

11. we're saving mentions (and other places) the domain as a text string, we should use the instance's UUID instead (even if remote) to ensure consistency and avoid issues with domain changes
12. we have many files using useProfileStore, we should refactor to use the new userDataService and ensure all components use the same source of truth for user data
13. we need to have rate limits so that users don't spam updates, don't want people creating scripts that rainbows their color or something
14. cleanup posts, we have metadata for "reblog_of/original_author" but we have all that info in reblog and reblog_author already...
15. ~~we should simply be creating posts and let the backend handle if is_local false to do the federation (create the ap_activities and properly send via http for direct or fallback to federation queue)~~ handle_post_federation and handle_post_federation_trigger
16. our self signing implementation was wrong, we NEED sha-rsa256 not just sha256, i'm currently using an edge-function to do the signing but this is very bad and slow, must do something about that.
17. same with the public/private keys, now its all edge functions lol
18. implement "update" to announce when a user updates their profile, this is needed for federation and to update the user profile in other instances, both incoming and outgoing updates

19. reactions should be federated to be compatible with misskey reactions 
{
  "type": "EmojiReaction",
  "actor": "https://misskey.io/users/example",
  "object": "https://misskey.io/notes/xxxx",
  "content": ":smile:"
}
 ^^ above might be wrong, see how misskey does it, but we should be able to do this with our current federation system

20. change all federation to be "Always Queue, Trigger Delivery ASAP, Fallback to Cron", right now a bunch of them are "attempt to deliver, if fail bring to queue" which could fail

21. our home/federated timeline/views aren't aggregating ap_activities properly, we need to ensure that all activities are fetched and displayed correctly, including reblogs, likes, and follows

22. delete events return old.id and it seems to be bugging post_interactions

23. replies don't work in activitypub (should investigate this)

24. implement "collections" for posts, this is a way to group posts together, similar to how threads work but more flexible, see https://www.w3.org/TR/activitypub/#collections (probably reowrk conversations to be collections, both DMs and threads maybe?)

25. rework loadUsersData() so that it's efficient and also probably use whatever the solution to know if the user is local on the activitypub, DRY approach

26.
> https://codeberg.org/fediverse/fep/src/branch/main/fep
> important site to see suggested protocols and features for the fediverse
> could add stuff you need or self implement in regards to voicechat/videochat, reactions, etc.

27.   .social-sidebar-container and .channel-sidebar-container should be consolidated into the same styling

28. implement rollUp build so that vendor (vite/vue other libraries) get bundled into the same chunks and my own components into others, so caching for libraries will remain longer, meaning faster loadings for users when i change stuff in components

29. improve the PWA scroll-up to refresh data-chat-messages/data-timeline

30. fix RLS for server privacy (select is all? should be owner/admin/members if private)

31. the user search is bad now, it's doing full queries every time. Instead we ought to prioritize cache, then if nothing is found do a fetch. Need a global cache for the user (all the servers/users encountered), then use that cache by context. Then fetch. We also need to use supabase vector search for better results. Don't forget about federation users, they should be cached too and we can search for them too when a domain is entered, only then.

32. ok, make sure it's fully compatible with both mastodon and misskey
misskey has stuff like status updates (online/away/offline) which we could embed with our own profiles.status
they also have reactions on posts, which we should embed with our own reactions logic to messages and posts (since we plan to federate messages (we already do for DMs!))

- `[{"text": "No!... ", "type": "text"}, {"type": "emoji", "emoji": {...}}]` → HTML + Emoji tags
- `[{"url": "https://media.tenor.com/...", "type": "file", "fileType": "image"}]` → Document attachments  
- `[{"type": "mention", "userId": "...", "mention": "@user@domain"}]` → Mention tags + HTML
- `[{"url": "https://text-adventure.ai", "type": "url", "preview": true}]` → HTML links
- `[{"text": "test", "type": "text"}
- ...more...

33. is_pinned post should be added to posts table, make work with outbox function


34. sometimes it's called federated_id (like in profiles table), sometimes it's ap_id, rename to ap_id and stay standardized

35. eventually i want to display tiny 2 or 4px indicators when the message is locally send, then federated read, and then slowly fade out... that way we can insta-display (optimistic update) and show if failed and have the user retry themselves


36. 
supabase-edge-functions  | [Info] Received activity: {
supabase-edge-functions  |   "@context": [
supabase-edge-functions  |     "https://www.w3.org/ns/activitystreams",
supabase-edge-functions  |     "https://w3id.org/security/v1",
supabase-edge-functions  |     {
supabase-edge-functions  |       "Key": "sec:Key",
supabase-edge-functions  |       "manuallyApprovesFollowers": "as:manuallyApprovesFollowers",
supabase-edge-functions  |       "sensitive": "as:sensitive",
supabase-edge-functions  |       "Hashtag": "as:Hashtag",
supabase-edge-functions  |       "quoteUrl": "as:quoteUrl",
supabase-edge-functions  |       "toot": "http://joinmastodon.org/ns#",
supabase-edge-functions  |       "Emoji": "toot:Emoji",
supabase-edge-functions  |       "featured": "toot:featured",
supabase-edge-functions  |       "discoverable": "toot:discoverable",
supabase-edge-functions  |       "schema": "http://schema.org#",
supabase-edge-functions  |       "PropertyValue": "schema:PropertyValue",
supabase-edge-functions  |       "value": "schema:value",
supabase-edge-functions  |       "misskey": "https://misskey-hub.net/ns#",
supabase-edge-functions  |       "_misskey_content": "misskey:_misskey_content",
supabase-edge-functions  |       "_misskey_quote": "misskey:_misskey_quote",
supabase-edge-functions  |       "_misskey_reaction": "misskey:_misskey_reaction",
supabase-edge-functions  |       "_misskey_votes": "misskey:_misskey_votes",
supabase-edge-functions  |       "_misskey_summary": "misskey:_misskey_summary",
supabase-edge-functions  |       "isCat": "misskey:isCat",
supabase-edge-functions  |       "vcard": "http://www.w3.org/2006/vcard/ns#"
supabase-edge-functions  |     }
supabase-edge-functions  |   ],
supabase-edge-functions  |   "type": "Like",
supabase-edge-functions  |   "id": "https://misskey.io/likes/aa9i60nva32r0euc",
supabase-edge-functions  |   "actor": "https://misskey.io/users/aa9hh3eoz0kz0apv",
supabase-edge-functions  |   "object": "https://misskey.io/notes/aa9i52dts1jw06ev",
supabase-edge-functions  |   "content": "👍",
supabase-edge-functions  |   "_misskey_reaction": "👍"
supabase-edge-functions  | }
supabase-edge-functions  | 



^ make these misskey reactions work for messages and posts


38. profileService is probably not needed anymore, we should use the new userDataService and ensure all components use the same source of truth for user, it's doing weird things like signing avatar URLs, and its not using the optmized versions, no cache either? etc...

39. add a limit of "unique" reactions per post/message, like max 20 different reactions (with unlimited counters on each)

40. notification should be smart in case a user spams a reaction, it should only show the first one and then ignore the rest, so that we don't spam the user with notifications, until a time threshold is reached (like  2min) and then it can show the next one, but not more than 3 in a row or something like that


41. send_accept_activity_for_follow is still using the automatic and returning http_sign_ stuff with edge functions, clean up.

42. we have ap_activities and federation_delivery_queue, we should merge them into one table, federation_delivery_queue should be the main table and ap_activities should be a view or something, so that we can have all activities in one place and not have to query two tables for federation

43. should federation_delivery_queue have a "federation_type" column to indicate if it's a post, follow, like, etc. so that we can filter and handle them accordingly?

44. clean console.logs in edge-functions, add debug environment variable to enable/disable them

45. editing removes mentions

46. fix mention parsing in posts, it's kinda broken for receiving messages

47. fix mention parsing in incoming DMs, it's adding two mentions but it shouldn't.

48. improve the richtexteditor

49. fix the autosuggestion focus on the input, it's not working properly