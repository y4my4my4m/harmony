// Journey: soundboard bursts. A member plays three sounds in quick succession and all three
// reach the other participant; the third starts a 3-second wait, during which the tiles are
// disabled and the bar under them runs; after it, a play goes out and arrives again. A fourth
// play forged inside the receive window, as a modified client would send it, is dropped by the
// listener.
//
// The stack has no LiveKit or realtime. Both voice stores are set as a joined call leaves them
// (soundboard-instant-play.spec.ts does the same), and the test carries each play the sender's
// store makes to the listener's store.receive, which applies the receiver rule. Built-in clips
// need no lookup on either side.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, addMember, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let voiceId: string

test.beforeAll(async () => {
  alice = await createUser(admin, 'sbba')
  bob = await createUser(admin, 'sbbb')
  server = await seedServer(admin, alice, `Bursts ${alice.username}`)
  await addMember(admin, bob, server.id)
  const { data, error } = await admin.from('channels').insert({ server_id: server.id, name: 'lounge', type: 1 }).select('id').single()
  if (error || !data) throw new Error(`voice channel: ${error?.message}`)
  voiceId = data.id
})

test.afterAll(async () => {
  await deleteUser(admin, alice)
  await deleteUser(admin, bob)
})

type Store = Record<string, any> & {
  $patch: (fn: (state: Record<string, any>) => void) => void
  $onAction: (fn: (context: { name: string; args: any[]; after: (cb: (result: unknown) => void) => void }) => void) => void
}

/** The voice store as a joined call leaves it, with `peerId` as the other participant. */
async function enterVoice(page: Page, userId: string, peerId: string) {
  await page.evaluate(({ serverId, channelId, userId, peerId }) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    voice.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'lounge'
      state.localState.userId = userId
      state.allUsers = [{
        userId: peerId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
        isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
      }]
    })
  }, { serverId: server.id, channelId: voiceId, userId, peerId })
}

/** Hands one play, as the wire carries it, to the listener's soundboard store. */
async function deliver(page: Page, from: string, soundId: string) {
  await page.evaluate(async ({ from, soundId, serverId }) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const soundboard = root.__vue_app__.config.globalProperties.$pinia._s.get('soundboard')
    if (!soundboard) throw new Error('soundboard store not created')
    await soundboard.receive({
      userId: from,
      message: { type: 'soundboard', v: 1, soundId, serverId, userId: from },
      granted: null,
    })
  }, { from, soundId, serverId: server.id })
}

/** Sound ids of the listener's play indicator, as the store holds them. */
async function shownPlays(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const soundboard = root.__vue_app__.config.globalProperties.$pinia._s.get('soundboard')
    return (soundboard?.recentPlays ?? []).map((play: { soundId: string }) => play.soundId)
  })
}

test('three quick plays go through, the fourth waits out the lockout', async ({ browser }) => {
  test.setTimeout(180_000)
  const aliceContext = await browser.newContext()
  const bobContext = await browser.newContext()
  const alicePage = await aliceContext.newPage()
  const bobPage = await bobContext.newPage()

  try {
    await signIn(alicePage, alice)
    await openChannel(alicePage, server.id, server.generalChannelId)
    await signIn(bobPage, bob)
    await openChannel(bobPage, server.id, server.generalChannelId)
    await enterVoice(alicePage, alice.id, bob.id)
    await enterVoice(bobPage, bob.id, alice.id)

    // Every play Alice's store sends is delivered to Bob as it goes out.
    const sent: string[] = []
    await alicePage.exposeFunction('__deliverSoundboardPlay', async (soundId: string) => {
      sent.push(soundId)
      await deliver(bobPage, alice.id, soundId)
    })
    await alicePage.evaluate(() => {
      const root = document.querySelector('#app') as unknown as {
        __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
      }
      const soundboard = root.__vue_app__.config.globalProperties.$pinia._s.get('soundboard')
      if (!soundboard) throw new Error('soundboard store not created')
      const w = window as unknown as { __deliverSoundboardPlay: (soundId: string) => Promise<void> }
      soundboard.$onAction(({ name, args, after }) => {
        if (name !== 'play') return
        after((ok) => {
          if (ok) void w.__deliverSoundboardPlay((args[0] as { id: string }).id)
        })
      })
    })

    const button = alicePage.locator('.unified-voice-dock .soundboard-btn')
    await expect(button).toBeVisible({ timeout: 30000 })
    await button.click()
    const popover = alicePage.locator('.sbp')
    await expect(popover).toBeVisible({ timeout: 10000 })
    const tile = (name: string) => popover.locator('[data-testid="soundboard-tile"]').filter({ hasText: name })
    const bar = popover.locator('.sbp-cooldown')
    await expect(tile('Ding')).toBeEnabled({ timeout: 10000 })

    await test.step('three quick plays all go out and reach the listener', async () => {
      await tile('Ding').click()
      await expect(tile('Tada')).toBeEnabled()
      await expect(bar).not.toHaveClass(/active/)
      await tile('Tada').click()
      await expect(bar).not.toHaveClass(/active/)
      await tile('Rimshot').click()
      await expect.poll(() => sent).toEqual(['default:ding', 'default:tada', 'default:rimshot'])
      const bobPlays = bobPage.locator('.sba-item')
      await expect(bobPlays).toHaveCount(3)
      await expect(bobPlays).toContainText(['Ding', 'Tada', 'Rimshot'])
    })

    await test.step('a forged fourth play inside the receive window is dropped by the listener', async () => {
      await deliver(bobPage, alice.id, 'default:quack')
      expect(await shownPlays(bobPage)).toEqual(['default:ding', 'default:tada', 'default:rimshot'])
      await expect(bobPage.locator('.sba-item')).toContainText(['Ding', 'Tada', 'Rimshot'])
      await expect(bobPage.locator('.sba-item').filter({ hasText: 'Quack' })).toHaveCount(0)
    })

    await test.step('the third starts the lockout: tiles disabled, the bar running', async () => {
      await expect(tile('Quack')).toBeDisabled()
      await expect(bar).toHaveClass(/active/)
      expect(Number(await bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
      await tile('Quack').click({ force: true })
      expect(sent).toHaveLength(3)
      await expect(alicePage.locator('.sba-item')).toContainText(['Ding', 'Tada', 'Rimshot'])
    })

    await test.step('after the lockout a play goes out and arrives', async () => {
      await expect(tile('Whoosh')).toBeEnabled({ timeout: 5000 })
      await expect(bar).not.toHaveClass(/active/)
      await tile('Whoosh').click()
      await expect.poll(() => sent).toHaveLength(4)
      await expect(bobPage.locator('.sba-item').filter({ hasText: 'Whoosh' })).toBeVisible({ timeout: 5000 })
      await expect(tile('Pop')).toBeEnabled()
    })
  } finally {
    await aliceContext.close()
    await bobContext.close()
  }
})
