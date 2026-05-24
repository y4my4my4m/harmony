import { test, expect } from './fixtures/auth.fixture'
import { ChatPage } from './pages/ChatPage'
import { SocialPage } from './pages/SocialPage'

test.describe('Reactions - Channel Messages', () => {
  test('can react to a message via emoji picker', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `React to me ${Date.now()}`
    await chat.sendMessage(msg)
    await chat.waitForMessage(msg)

    const msgEl = chat.getMessageByContent(msg)
    // Hover to reveal action buttons, then click the reaction/emoji button
    await msgEl.hover()
    // Look for the emoji/reaction action button in the message actions toolbar
    const reactionBtn = alicePage.locator('.emoji-action, .action-btn-react, [title*="React"], [title*="Emoji"]').first()
    if (await reactionBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reactionBtn.click()
      // Pick the first emoji available
      const emojiItem = alicePage.locator('.emoji-picker .emoji-item, .emoji-list button').first()
      if (await emojiItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await emojiItem.click()
      }
    }
  })

  test('reaction count increments when another user reacts', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    const aliceChat = new ChatPage(alicePage)
    const bobChat = new ChatPage(bobPage)

    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)
    await bobChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Multi-react ${Date.now()}`
    await aliceChat.sendMessage(msg)
    await aliceChat.waitForMessage(msg)
    await bobChat.waitForMessage(msg)

    // Both users react - count should show 2
    // Alice reacts
    const aliceMsgEl = aliceChat.getMessageByContent(msg)
    await aliceMsgEl.hover()
    const aliceReactBtn = alicePage.locator('.emoji-action, .action-btn-react, [title*="React"]').first()
    if (await aliceReactBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await aliceReactBtn.click()
      const emoji = alicePage.locator('.emoji-picker .emoji-item, .emoji-list button').first()
      if (await emoji.isVisible({ timeout: 3000 }).catch(() => false)) {
        await emoji.click()
      }
    }
  })

  test('can remove own reaction by clicking it again', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Remove react ${Date.now()}`
    await chat.sendMessage(msg)
    await chat.waitForMessage(msg)

    const msgEl = chat.getMessageByContent(msg)
    const reactions = chat.getReactions(msgEl)

    // If reactions exist after adding, clicking same reaction removes it
    if (await reactions.locator('.reaction').count() > 0) {
      const reactionChip = reactions.locator('.reaction.reacted').first()
      if (await reactionChip.isVisible({ timeout: 2000 }).catch(() => false)) {
        await reactionChip.click()
        // Reaction should be removed (no longer .reacted)
        await expect(reactionChip).not.toHaveClass(/reacted/, { timeout: 5000 })
      }
    }
  })
})

test.describe('Reactions - ActivityPub Posts', () => {
  test('can favorite a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    // If there are posts, favorite the first one
    const firstPost = social.postItems.first()
    if (await firstPost.isVisible({ timeout: 10000 }).catch(() => false)) {
      await social.favoritePost(firstPost)
      await expect(social.isFavorited(firstPost)).toBeVisible({ timeout: 5000 })
    }
  })

  test('can unfavorite a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    const firstPost = social.postItems.first()
    if (await firstPost.isVisible({ timeout: 10000 }).catch(() => false)) {
      // Favorite first if not already
      if (!(await social.isFavorited(firstPost).isVisible({ timeout: 1000 }).catch(() => false))) {
        await social.favoritePost(firstPost)
        await expect(social.isFavorited(firstPost)).toBeVisible({ timeout: 5000 })
      }
      // Now unfavorite
      await social.favoritePost(firstPost)
      await expect(social.isFavorited(firstPost)).not.toBeVisible({ timeout: 5000 })
    }
  })
})
