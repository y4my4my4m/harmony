import { describe, expect, it } from 'vitest'
import { accountCopyFor, pickLook } from '@/utils/appearanceScope'

describe('appearanceScope', () => {
  it('picks the look keys only', () => {
    expect(pickLook({ theme: 'light', fontSize: 18, greentextEnabled: false, activeSkinId: null }))
      .toEqual({ theme: 'light', fontSize: 18, activeSkinId: null })
  })

  it('writes the device settings under the account look', () => {
    const device = { theme: 'midnight' as const, fontSize: 18, greentextEnabled: true, savedAt: 9 }
    const account = { theme: 'light' as const, greentextEnabled: false, customCssOverrides: { '--x': '#fff' } }
    expect(accountCopyFor(device, account)).toEqual({
      theme: 'light',
      customCssOverrides: { '--x': '#fff' },
      greentextEnabled: true,
      savedAt: 9,
    })
  })

  it('keeps the device look without an account copy', () => {
    const device = { theme: 'midnight' as const, fontSize: 18 }
    expect(accountCopyFor(device, null)).toBe(device)
  })
})
