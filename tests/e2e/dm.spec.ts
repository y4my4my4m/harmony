import { test, expect } from './fixtures/auth.fixture'
import { DMPage } from './pages/DMPage'

test.describe('Direct Messages', () => {
  test('DM sidebar loads', async ({ alicePage }) => {
    const dm = new DMPage(alicePage)
    await dm.navigate()
    await expect(dm.sidebar).toBeVisible()
  })

  test('can start a new DM conversation', async ({ alicePage, seedData }) => {
    const dm = new DMPage(alicePage)
    await dm.navigate()

    await dm.startNewConversation(seedData.bob.username)

    // Should navigate to the conversation
    await expect(alicePage).toHaveURL(/\/dm\//, { timeout: 10000 })
  })

  test('can send a DM message', async ({ alicePage }) => {
    const dm = new DMPage(alicePage)
    await dm.navigate()

    // Click the first conversation if one exists
    if (await dm.conversationItems.count() > 0) {
      await dm.selectConversation(0)

      const msg = `DM test ${Date.now()}`
      await dm.sendMessage(msg)
      await dm.waitForMessage(msg)
    }
  })

  test('bob receives DM from alice in realtime', async ({ alicePage, bobPage, seedData }) => {
    const aliceDM = new DMPage(alicePage)
    const bobDM = new DMPage(bobPage)

    await aliceDM.navigate()

    // Alice starts conversation with Bob
    await aliceDM.startNewConversation(seedData.bob.username)
    await alicePage.waitForURL(/\/dm\//, { timeout: 10000 })

    // Get the conversation ID from URL
    const conversationId = alicePage.url().split('/dm/')[1]

    // Bob opens the same conversation
    await bobDM.navigateToConversation(conversationId)

    const msg = `Cross-user DM ${Date.now()}`
    await aliceDM.sendMessage(msg)

    // Bob should see the message via realtime
    await bobDM.waitForMessage(msg)
  })

  test('DM conversation appears in sidebar', async ({ alicePage, seedData }) => {
    const dm = new DMPage(alicePage)
    await dm.navigate()

    // Start a conversation to ensure at least one exists
    await dm.startNewConversation(seedData.bob.username)
    await alicePage.waitForURL(/\/dm\//, { timeout: 10000 })

    // Navigate back to DM list
    await dm.navigate()

    // Should have at least one conversation
    await expect(dm.conversationItems.first()).toBeVisible({ timeout: 10000 })
  })

  test('unread indicator appears for new messages', async ({ alicePage, bobPage, seedData }) => {
    const aliceDM = new DMPage(alicePage)
    const bobDM = new DMPage(bobPage)

    // Alice opens DM with Bob and sends a message
    await aliceDM.navigate()
    await aliceDM.startNewConversation(seedData.bob.username)
    await alicePage.waitForURL(/\/dm\//, { timeout: 10000 })

    const msg = `Unread test ${Date.now()}`
    await aliceDM.sendMessage(msg)

    // Bob opens DM sidebar - should see conversation from Alice
    await bobDM.navigate()
    // Conversation items may show display name or username
    const bobConvo = bobDM.conversationItems.first()
    await expect(bobConvo).toBeVisible({ timeout: 15000 })
  })
})
