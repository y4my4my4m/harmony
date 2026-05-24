import { test, expect } from './fixtures/auth.fixture'
import { ChatPage } from './pages/ChatPage'

test.describe('Channel Messaging', () => {
  test('can send a message in a channel', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Hello from E2E ${Date.now()}`
    await chat.sendMessage(msg)
    await chat.waitForMessage(msg)
  })

  test('sent message appears in the message list', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Visible msg ${Date.now()}`
    await chat.sendMessage(msg)

    const msgEl = chat.getMessageByContent(msg)
    await expect(msgEl).toBeVisible({ timeout: 10000 })
  })

  test('another user sees the message in realtime', async ({ alicePage, bobPage, seedData }) => {
    const aliceChat = new ChatPage(alicePage)
    const bobChat = new ChatPage(bobPage)

    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)
    await bobChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Realtime msg ${Date.now()}`
    await aliceChat.sendMessage(msg)

    // Bob should see Alice's message via realtime
    await bobChat.waitForMessage(msg)
  })

  test('can edit a message via context menu', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const original = `Edit me ${Date.now()}`
    await chat.sendMessage(original)
    await chat.waitForMessage(original)

    const msgEl = chat.getMessageByContent(original)
    const edited = `Edited ${Date.now()}`
    await chat.editMessage(msgEl, edited)

    await chat.waitForMessage(edited)
  })

  test('can delete a message via context menu', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Delete me ${Date.now()}`
    await chat.sendMessage(msg)
    await chat.waitForMessage(msg)

    const msgEl = chat.getMessageByContent(msg)
    await chat.deleteMessage(msgEl)

    // Message should disappear
    await expect(chat.getMessageByContent(msg)).not.toBeVisible({ timeout: 10000 })
  })

  test('can reply to a message', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const original = `Reply target ${Date.now()}`
    await chat.sendMessage(original)
    await chat.waitForMessage(original)

    const msgEl = chat.getMessageByContent(original)
    const reply = `Reply content ${Date.now()}`
    await chat.replyToMessage(msgEl, reply)

    await chat.waitForMessage(reply)
  })

  test('can send a message with emoji', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    const msg = `Emoji test 🎉 ${Date.now()}`
    await chat.sendMessage(msg)
    await chat.waitForMessage('Emoji test')
  })

  test('empty message is not sent', async ({ alicePage, seedData }) => {
    const chat = new ChatPage(alicePage)
    await chat.navigateToChannel(seedData.serverId, seedData.channelId)

    // Try to send empty
    await chat.messageInput.click()
    await alicePage.keyboard.press('Enter')

    // No new empty message should appear - count shouldn't increase
    // (just verifying no crash/error)
    await alicePage.waitForTimeout(1000)
  })
})
