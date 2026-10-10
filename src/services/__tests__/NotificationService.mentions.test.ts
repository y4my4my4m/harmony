// The Mentions view retries a failed read on the next visibility tick; that needs the
// failure to reach it.
import { describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { NotificationService } from '@/services/NotificationService'

function chain(result: unknown) {
  const proxy: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject)
      return () => proxy
    },
  })
  return proxy
}

describe('NotificationService.markMentionNotificationsForPostsAsRead', () => {
  it('resolves true when the rows are updated', async () => {
    vi.mocked(supabase.from).mockReturnValue(chain({ error: null }))
    await expect(NotificationService.getInstance().markMentionNotificationsForPostsAsRead('me', ['p1'])).resolves.toBe(true)
  })

  it('rejects when the update fails', async () => {
    vi.mocked(supabase.from).mockReturnValue(chain({ error: { message: 'permission denied' } }))
    await expect(NotificationService.getInstance().markMentionNotificationsForPostsAsRead('me', ['p1']))
      .rejects.toMatchObject({ code: 'UPDATE_FAILED', message: 'permission denied' })
  })
})
