// Journey: a member who joins an encrypted channel after messages were sent reads them,
// pinned ones included, while their author is offline. Any current member holding a
// session key answers the newcomer's key request (20261028100001_megolm_key_relay.sql); the
// channel shows newcomers all earlier messages, the default
// (20261028200001_megolm_history_visibility.sql).
//
// Ava posts and pins while Ben is in the channel, so Ben holds Ava's session. Ben posts too.
// Both go offline. Cleo joins and asks for both sessions. Ben comes back; his unlock sweep
// answers his own session's request as before and relays Ava's. Cleo reloads and reads
// both messages and the pin. Ava never comes back.
//
// A member who answers with a key that does not decrypt the session is refused: the
// newcomer imports a relayed key only after it decrypts a signed ciphertext of that session.

import { test, expect } from '@playwright/test'
import { addMember, adminClient, dismissAnnouncements, openChannel, signIn, userClient } from './harness'
import { setUpEncryption } from './encryption'
import { Cast, comeBack, historyBeforeJoin, item, openPins, requestsOf } from './encryptedHistory'

const admin = adminClient()
const cast = new Cast(admin)

test.afterAll(async () => {
  await cast.cleanup()
})

test('a newcomer reads history and pins sent before they joined, the author offline', async ({ browser }) => {
  test.setTimeout(300_000)
  const { ava, ben, cleo, avaTexts, benText, benProfile, cleoPage } = await historyBeforeJoin(admin, cast, browser, 'kr', { benPosts: true })

  await test.step("Ben comes back; his sweep answers his own session and relays Ava's", async () => {
    await comeBack(benProfile)
    await expect
      .poll(
        async () => (await requestsOf(admin, cleo)).filter((r) => r.status !== 'pending').map((r) => r.sender_user_id).sort(),
        { timeout: 60000 },
      )
      .toEqual([ava.id, ben.id].sort())
    const relayed = (await requestsOf(admin, cleo)).find((r) => r.sender_user_id === ava.id)
    expect(relayed?.fulfilled_by_user_id).toBe(ben.id)
    expect(relayed?.key_scope).toBe('session')
  })

  await test.step('Cleo reads both messages after a reload', async () => {
    await cleoPage.reload()
    await dismissAnnouncements(cleoPage)
    await expect(item(cleoPage, avaTexts[0])).toHaveCount(1, { timeout: 30000 })
    await expect(item(cleoPage, benText!)).toHaveCount(1, { timeout: 30000 })
    await expect
      .poll(async () => (await requestsOf(admin, cleo)).find((r) => r.sender_user_id === ava.id)?.status, { timeout: 30000 })
      .toBe('received')
  })

  await test.step("Cleo reads Ava's pin", async () => {
    const pins = await openPins(cleoPage, 1)
    await expect(pins.getByText(avaTexts[0])).toBeVisible({ timeout: 30000 })
  })
})

test('a relayed key that does not decrypt the session is refused; a holder\'s key is taken', async ({ browser }) => {
  test.setTimeout(300_000)
  const { server, ava, ben, cleo, avaTexts, benProfile, cleoPage } = await historyBeforeJoin(admin, cast, browser, 'krx')
  const mal = await cast.actor('krxmal')
  let forged = ''

  await test.step('Mal, a member without the key, answers first with a key of his own', async () => {
    await addMember(admin, mal, server.id)
    const malPage = await (await cast.profile(browser)).newPage()
    await signIn(malPage, mal)
    await openChannel(malPage, server.id, server.generalChannelId)
    await setUpEncryption(malPage, mal)

    const { data: cleoKey, error: keyError } = await admin
      .from('user_key_pairs')
      .select('identity_public_key')
      .eq('user_id', cleo.id)
      .eq('is_active', true)
      .single()
    if (keyError) throw new Error(`cleo key: ${keyError.message}`)
    const wrapped = await malPage.evaluate(async (recipientKey) => {
      const served = performance.getEntriesByType('resource').map((e) => e.name)
        .find((name) => name.includes('/src/services/encryption/MegolmKeyBackupService.ts'))
      const url = served ?? '/src/services/encryption/MegolmKeyBackupService.ts'
      const service = (await import(/* @vite-ignore */ url)).megolmKeyBackupService as any
      const random = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      return service.encryptSessionKeyForUser(random, recipientKey) as Promise<string>
    }, cleoKey.identity_public_key as string)

    forged = (await requestsOf(admin, cleo)).find((r) => r.sender_user_id === ava.id && r.status === 'pending')!.id
    const asMal = await userClient(mal)
    const { data, error } = await asMal.rpc('fulfill_megolm_key_request', {
      p_request_id: forged,
      p_encrypted_key: wrapped,
    })
    if (error) throw new Error(`forged answer: ${error.message}`)
    expect(data).toBe(true)
  })

  await test.step("Cleo refuses Mal's key and asks again", async () => {
    await cleoPage.reload()
    await dismissAnnouncements(cleoPage)
    await expect
      .poll(async () => (await requestsOf(admin, cleo)).find((r) => r.id === forged)?.status, { timeout: 30000 })
      .toBe('expired')
    await expect(item(cleoPage, avaTexts[0])).toHaveCount(0)
    // The new request follows the refusal: the client first tries to recover the session's
    // share, then asks again.
    await expect
      .poll(async () => (await requestsOf(admin, cleo)).some((r) => r.sender_user_id === ava.id && r.status === 'pending'), { timeout: 30000 })
      .toBe(true)
  })

  await test.step("Ben comes back and relays Ava's session; Cleo reads it", async () => {
    await comeBack(benProfile)
    await expect
      .poll(
        async () => (await requestsOf(admin, cleo)).some((r) => r.fulfilled_by_user_id === ben.id),
        { timeout: 60000 },
      )
      .toBe(true)
    await cleoPage.reload()
    await dismissAnnouncements(cleoPage)
    await expect(item(cleoPage, avaTexts[0])).toHaveCount(1, { timeout: 30000 })
  })
})
