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

<div role="textbox" aria-multiline="true" spellcheck="true" aria-haspopup="listbox" aria-invalid="false" aria-autocomplete="list" class="markup__75297 editor__1b31f slateTextArea_ec4baf" autocorrect="off" data-can-focus="true" aria-label="Message @ar53n" data-slate-editor="true" data-slate-node="value" contenteditable="true" zindex="-1" style="position: relative; outline: none; white-space: pre-wrap; overflow-wrap: break-word;"><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true" class=""><span data-slate-string="true">test emoji </span></span></span><span data-slate-node="element" data-slate-inline="true" data-slate-void="true" contenteditable="false" class="inlineElement__1464f inlineVoid__1464f"><img aria-label=":Nice:" class="emoji" data-type="emoji" data-id="997991793104793640" alt=":Nice:" draggable="false" src="https://cdn.discordapp.com/emojis/997991793104793640.webp?size=44"><span style="display: none;"></span><span data-slate-spacer="true" style="height: 0px; color: transparent; outline: none; position: absolute;"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-zero-width="z" data-slate-length="0">﻿</span></span></span></span></span><span data-slate-node="text"><span data-slate-leaf="true" class=""><span data-slate-string="true"> </span></span></span></div><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true" class="codeBlockSyntax_ada32f" spellcheck="false"><span data-slate-string="true">```</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true">json</span></span></span></div><div data-slate-node="element" class="codeLine_ada32f" spellcheck="false"><span data-slate-node="text"><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">{</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true"> </span></span><span data-slate-leaf="true" class="hljs-attr"><span data-slate-string="true">"test"</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">:</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true"> </span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">[</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">{</span></span><span data-slate-leaf="true" class="hljs-attr"><span data-slate-string="true">"yo"</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">:</span></span><span data-slate-leaf="true" class="hljs-string"><span data-slate-string="true">"yo"</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">}</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">,</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">{</span></span><span data-slate-leaf="true" class="hljs-attr"><span data-slate-string="true">"abc"</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">:</span></span><span data-slate-leaf="true" class="hljs-number"><span data-slate-string="true">3</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">}</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">]</span></span><span data-slate-leaf="true" class="hljs-punctuation"><span data-slate-string="true">}</span></span></span></div><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true" class="codeBlockSyntax_ada32f" spellcheck="false"><span data-slate-string="true">```</span></span></span></div><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true" class="emptyText__1464f"><span data-slate-zero-width="n" data-slate-length="0">﻿<br></span></span></span></div><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true" class=""><span data-slate-string="true">and some inlined </span></span><span data-slate-leaf="true" class="syntaxBefore_ada32f before_inlineCode_ada32f"><span data-slate-string="true">`</span></span><span data-slate-leaf="true" class="inlineCode_ada32f"><span data-slate-string="true">yo dude</span></span><span data-slate-leaf="true" class="syntaxAfter_ada32f after_inlineCode_ada32f"><span data-slate-string="true">`</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true"> and some </span></span><span data-slate-leaf="true" class="syntaxBefore_ada32f"><span data-slate-string="true">**</span></span><span data-slate-leaf="true" class="bold_ada32f"><span data-slate-string="true">bold text</span></span><span data-slate-leaf="true" class="syntaxAfter_ada32f"><span data-slate-string="true">**</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true">  and here's some </span></span><span data-slate-leaf="true" class="syntaxBefore_ada32f before_em_ada32f"><span data-slate-string="true">*</span></span><span data-slate-leaf="true" class="italics_ada32f"><span data-slate-string="true">italic</span></span><span data-slate-leaf="true" class="syntaxAfter_ada32f after_em_ada32f"><span data-slate-string="true">*</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true"> and i know we can do</span></span></span></div><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true" class="syntaxBefore_ada32f before_u_ada32f"><span data-slate-string="true">__</span></span><span data-slate-leaf="true" class="underline_ada32f"><span data-slate-string="true">underline</span></span><span data-slate-leaf="true" class="syntaxAfter_ada32f after_u_ada32f"><span data-slate-string="true">__</span></span><span data-slate-leaf="true" class=""><span data-slate-string="true">  or </span></span><span data-slate-leaf="true" class="syntaxBefore_ada32f before_s_ada32f"><span data-slate-string="true">~~</span></span><span data-slate-leaf="true" class="strikethrough_ada32f"><span data-slate-string="true">strikethrough</span></span><span data-slate-leaf="true" class="syntaxAfter_ada32f after_s_ada32f"><span data-slate-string="true">~~</span></span></span></div></div>

handle rich text and codeblock and inline (probably best to make a utility for coding languages syntax highlight or make use of an available one)

Please create a professional, clean, scalable and DRY code resembling what discord is doing.
You may refactor and change almost everything but don't lose functionality

Do not name things "discord"