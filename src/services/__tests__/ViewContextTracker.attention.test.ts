import { describe, it, expect } from 'vitest'
import { ViewContextTracker } from '@/services/ViewContextTracker'

const dm = { conversation_id: 'c1', type: 'dm' }

describe('view context suppression needs a seen view', () => {
  it('suppresses alerts for the conversation on screen', () => {
    const tracker = new ViewContextTracker()
    tracker.updateContext({ view_type: 'dm', conversation_id: 'c1' })
    expect(tracker.shouldShowNotificationUI(dm).showDesktop).toBe(false)
  })

  it('alerts while the tab is hidden, even on the same conversation', () => {
    const tracker = new ViewContextTracker()
    tracker.updateContext({ view_type: 'dm', conversation_id: 'c1' })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      expect(tracker.shouldShowNotificationUI(dm)).toMatchObject({ showToast: true, showDesktop: true, playSound: true })
    } finally {
      delete (document as any).visibilityState
    }
  })

  it('alerts while the tab is idle', () => {
    const tracker = new ViewContextTracker()
    tracker.updateContext({ view_type: 'dm', conversation_id: 'c1' })
    tracker.setAttentive(false)
    expect(tracker.shouldShowNotificationUI(dm).showDesktop).toBe(true)
    tracker.reset()
    tracker.updateContext({ view_type: 'dm', conversation_id: 'c1' })
    expect(tracker.shouldShowNotificationUI(dm).showDesktop).toBe(false)
  })
})
