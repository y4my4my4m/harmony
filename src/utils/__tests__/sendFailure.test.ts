import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

import { classifySendFailure, permissionRefusalMessage, refusedPermission } from '@/utils/sendFailure'

describe('send failure: permission', () => {
  const external = { code: 'INSERT_FAILED', message: 'Missing permission: USE_EXTERNAL_EMOJIS' }
  const attach = { code: 'INSERT_FAILED', message: 'Missing permission: ATTACH_FILES' }

  it('classifies a refused channel permission', () => {
    expect(classifySendFailure(external)).toBe('permission')
    expect(classifySendFailure(attach)).toBe('permission')
    expect(classifySendFailure({ message: 'network down' })).toBe('other')
  })

  it('names the permission', () => {
    expect(refusedPermission(external)).toBe('USE_EXTERNAL_EMOJIS')
    expect(refusedPermission({ message: 'other' })).toBeNull()
  })

  it('words the external emoji rule and passes other refusals through', () => {
    expect(permissionRefusalMessage(external)).toBe('emoji.externalNotAllowed')
    expect(permissionRefusalMessage(attach)).toBe('Missing permission: ATTACH_FILES')
  })
})
