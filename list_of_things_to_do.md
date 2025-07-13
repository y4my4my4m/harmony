1. the sidebar profile view goes out of bound if the screen is too small
2. the profile view on clicking a username might be out of bound (if too close to top or bottom of the screen)
3. search
4. currently there's a bug where users can be invited and join the same server multiple times (should probably be fixed in the backend)
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
---

Please create a professional, clean, scalable and DRY code resembling what discord is doing.
You may refactor and change almost everything but don't lose functionality

---

I'd like to redo the following features: the profile view modal, a better invite system,
the one when you click on another user, it looks amateurish, I want it to have a professional and fun look, gamer/internaut ish, something modern that you'd see on dribbble.com or something, good UI/UX.

Please create a professional, clean, scalable and DRY code resembling what discord is doing.
You may refactor and change almost everything but don't lose functionality

Do not name things "discord"