1. avatar is full URL instead of just path when creating a new profile, that's wrong
2. avatars are not cropped and aspect ratioed correctly almosts everywhere but the voice overlay stuff... fix it, make it DRY too.
3. allow emoji renaming (if admin/server owner/permissions)
4. allow multi emoji upload
5. allow multi emoji deletion (selection mode)
6. allow emojis to appear in the message input field, make the message multiline if needed just like in discord (right now its multiline but the height is fixed, so it doesn't expand, needs to be fixed)
7. allow user settings to be URL to the actual settings tab, for example settings/notifications, that way when we click the gear icon in the notifications it will open the correct settings tab

I'd like to complete the above 7 tasks. I want it to have a professional and fun look, gamer/internaut ish, something modern that you'd see on dribbble.com or something, good UI/UX.

Please create a professional, clean, scalable and DRY code resembling what discord is doing.
You may refactor and change almost everything but don't lose functionality

Do not name things "discord"

---

1. still cant rename the emojis
2. multiline doesnt reset after sending a message, so if you type a long message and send it, the input field will still be long, it should reset to single line after sending
3. the emoji are not displayed in the message input field, they should be, like in discord
4. make the avatars use the new avatar util in the userprofilecomponent and the message lists (and in DMs too i guess, and notifications!!)
5. direct access to a server url like http://localhost:5173/server/9895ae8a-b25a-475b-b2f1-3bd3e2dffeab doesnt seem to grab permissions (like if im logged in as the server owner it should show the server owner controls, but it doesn't)

---

1. the message wont have new lines in it, it'll be a single line, but the input field is multiline, we need to fix that so that the message contains the new lines as well, just as we typed it.
2. the emojis are not displayed in the message input field, they should be, like in discord (right now we just see the emoji code, like :smile: instead of the actual emoji)
3. the input field's content when a single line isnt properly vertically centered, it should be vertically centered like in discord

Please create a professional, clean, scalable and DRY code resembling what discord is doing.
You may refactor and change almost everything but don't lose functionality

Do not name things "discord"

---

1. the userlist bar doesn't look good and professional, it looks amateurish, it should look more like the userlist in discord, with proper spacing and alignment and details
2. the userlist bar should have a search input at the top, like in discord,
3. the userlist bar should have a button to toggle the userlist visibility, like in discord,
4. the userlist bar should have a button to toggle the server settings visibility, like in discord,
5. the userlist bar should have a button to toggle the server roles visibility,

Please create a professional, clean, scalable and DRY code resembling what discord is doing.
You may refactor and change almost everything but don't lose functionality

Do not name things "discord"


---

1. server owner should be able to edit/delete messages, channels, categories
2. server owner should be able to rename/delete categories and channels
3. can't join voice chat on mobile because it automatically starts the channel dragging feature


---

I'd like to add a new dimension to my webapp.
It's a chatapp like discord, but I want to add a federated activitypub so that users can follow each other across different instances, like Mastodon or Pleroma. There should be a whole "tweeting" system where users can post short messages, images, and videos, and others can follow them, just like other federated platforms. In the serverbar, there should be a button to enter the activitypub feed, which will show the posts from users you follow, and you can also post your own messages there. Notifications should be unified.

Currently, we're saving the username as @username@domain (IE: @y4my4m@harmony.com), but i want to change it so that username is saved as just username (IE: y4my4m) and we have a new column that's domain (IE: harmony.com) that will be used to create the full identity.

Make full use of supabase's realtime features to ensure that the activitypub feed updates in real-time when actions are performed.
Make sure everything is professional, scalable, clean, and DRY.

Harmony (the app/brand)
mony (the action, pronounced “MO-nee”)
monyverse (community/universe idea)

I want it to have a professional and fun look, gamer/internaut ish, something modern that you'd see on dribbble.com or something, good UI/UX.

Please create a professional, clean, scalable and DRY code resembling what discord and federated activitypub are doing.
You may refactor and change almost everything but don't lose functionality

Do not name things "discord"