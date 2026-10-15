import { describe, expect, it } from 'vitest'
import { grantsFromPermission, grantsFromRolePermissions, moderationFromMetadata, OPEN_GRANTS } from '../voiceGrants'

// @livekit/protocol TrackSource: CAMERA 1, MICROPHONE 2, SCREEN_SHARE 3, SCREEN_SHARE_AUDIO 4.

describe('grantsFromPermission', () => {
  it('reads the source list the server grants', () => {
    expect(grantsFromPermission({ canPublish: true, canPublishSources: [2], canSubscribe: true }))
      .toEqual({ speak: true, stream: false, hear: true })
    expect(grantsFromPermission({ canPublish: true, canPublishSources: [1, 3, 4], canSubscribe: false }))
      .toEqual({ speak: false, stream: true, hear: false })
  })

  it('treats an empty list as every source, and no publish as none', () => {
    expect(grantsFromPermission({ canPublish: true, canPublishSources: [] })).toEqual(OPEN_GRANTS)
    expect(grantsFromPermission({ canPublish: false, canPublishSources: [2, 3] })).toMatchObject({ speak: false, stream: false })
  })

  it('withholds nothing before a permission is known', () => {
    expect(grantsFromPermission(undefined)).toEqual(OPEN_GRANTS)
  })
})

describe('moderationFromMetadata', () => {
  it('reads serverMuted and serverDeafened, false otherwise', () => {
    expect(moderationFromMetadata('{"serverMuted":true,"serverDeafened":false}')).toEqual({ muted: true, deafened: false })
    expect(moderationFromMetadata('{"profileId":"p"}')).toEqual({ muted: false, deafened: false })
    expect(moderationFromMetadata('not json')).toEqual({ muted: false, deafened: false })
    expect(moderationFromMetadata(undefined)).toEqual({ muted: false, deafened: false })
  })
})

describe('grantsFromRolePermissions', () => {
  it('follows SPEAK and STREAM; ADMINISTRATOR holds both', () => {
    expect(grantsFromRolePermissions({ SPEAK: true, STREAM: false })).toEqual({ speak: true, stream: false, hear: true })
    expect(grantsFromRolePermissions({ ADMINISTRATOR: true })).toEqual({ speak: true, stream: true, hear: true })
    expect(grantsFromRolePermissions({})).toEqual({ speak: false, stream: false, hear: true })
  })
})
