import { describe, it, expect, vi, beforeEach } from 'vitest'

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast }) }))

import { i18n } from '@/i18n'
import en from '@/locales/en.json'
import { noticeKeyShareFailures } from '../keyShareNotice'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  showToast.mockClear()
  i18n.global.setLocaleMessage('en', en as any)
  i18n.global.locale.value = 'en'
})

describe('noticeKeyShareFailures', () => {
  it('tells the sender how many members may not read the message', async () => {
    noticeKeyShareFailures(2)
    await flush()
    expect(showToast).toHaveBeenCalledTimes(1)
    const [type, title, body] = showToast.mock.calls[0]
    expect(type).toBe('server_update')
    expect(title).toBe(en.encryption.keyShareFailed.title)
    expect(body).toContain('2 members')
  })

  it('names one member in the singular', async () => {
    noticeKeyShareFailures(1)
    await flush()
    expect(showToast.mock.calls[0][2]).toContain('reach 1 member.')
  })

  it('stays silent when the key reached everyone', async () => {
    noticeKeyShareFailures(0)
    noticeKeyShareFailures(undefined)
    await flush()
    expect(showToast).not.toHaveBeenCalled()
  })
})
