import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/utils/debug', () => ({
  debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { ViewContextTracker } from '../ViewContextTracker'

describe('ViewContextTracker', () => {
  let tracker: ViewContextTracker

  beforeEach(() => {
    tracker = new ViewContextTracker()
  })

  describe('updateContext / getCurrentContext', () => {
    it('starts with home context by default', () => {
      const ctx = tracker.getCurrentContext()
      expect(ctx.view_type).toBe('home')
      expect(ctx.server_id).toBeUndefined()
      expect(ctx.channel_id).toBeUndefined()
      expect(ctx.conversation_id).toBeUndefined()
    })

    it('updates to a server channel context', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-1',
      })
      const ctx = tracker.getCurrentContext()
      expect(ctx.view_type).toBe('server_channel')
      expect(ctx.server_id).toBe('srv-1')
      expect(ctx.channel_id).toBe('ch-1')
    })

    it('updates to a DM conversation context', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-123',
      })
      const ctx = tracker.getCurrentContext()
      expect(ctx.view_type).toBe('dm')
      expect(ctx.conversation_id).toBe('conv-123')
    })

    it('returns a copy, not a reference', () => {
      tracker.updateContext({ view_type: 'dm', conversation_id: 'conv-1' })
      const ctx1 = tracker.getCurrentContext()
      const ctx2 = tracker.getCurrentContext()
      expect(ctx1).toEqual(ctx2)
      expect(ctx1).not.toBe(ctx2)
    })
  })

  describe('isViewingChannel', () => {
    it('returns true when viewing the exact channel', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-1',
      })
      expect(tracker.isViewingChannel('srv-1', 'ch-1')).toBe(true)
    })

    it('returns false for different channel in same server', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-1',
      })
      expect(tracker.isViewingChannel('srv-1', 'ch-2')).toBe(false)
    })

    it('returns false for same channel in different server', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-1',
      })
      expect(tracker.isViewingChannel('srv-2', 'ch-1')).toBe(false)
    })

    it('returns false when viewing a DM', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })
      expect(tracker.isViewingChannel('srv-1', 'ch-1')).toBe(false)
    })

    it('returns false when on home', () => {
      expect(tracker.isViewingChannel('srv-1', 'ch-1')).toBe(false)
    })
  })

  describe('isViewingConversation', () => {
    it('returns true when viewing the exact conversation', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-abc',
      })
      expect(tracker.isViewingConversation('conv-abc')).toBe(true)
    })

    it('returns false for different conversation', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-abc',
      })
      expect(tracker.isViewingConversation('conv-xyz')).toBe(false)
    })

    it('returns false when viewing a channel', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-1',
      })
      expect(tracker.isViewingConversation('conv-abc')).toBe(false)
    })
  })

  describe('shouldShowNotificationUI (the bug-critical logic)', () => {
    it('suppresses notification when user is viewing the source DM conversation', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-123',
      })

      const decision = tracker.shouldShowNotificationUI({
        conversation_id: 'conv-123',
        type: 'dm',
      })

      expect(decision.showToast).toBe(false)
      expect(decision.showDesktop).toBe(false)
      expect(decision.playSound).toBe(false)
      expect(decision.reason).toContain('conversation')
    })

    it('shows notification for DM when viewing a DIFFERENT conversation', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-other',
      })

      const decision = tracker.shouldShowNotificationUI({
        conversation_id: 'conv-123',
        type: 'dm',
      })

      expect(decision.showToast).toBe(true)
      expect(decision.showDesktop).toBe(true)
      expect(decision.playSound).toBe(true)
    })

    it('shows DM notification when user is on home page', () => {
      // Default context is home
      const decision = tracker.shouldShowNotificationUI({
        conversation_id: 'conv-123',
        type: 'dm',
      })

      expect(decision.showToast).toBe(true)
    })

    it('suppresses notification when user is viewing the source channel', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-general',
      })

      const decision = tracker.shouldShowNotificationUI({
        server_id: 'srv-1',
        channel_id: 'ch-general',
        type: 'mention',
      })

      expect(decision.showToast).toBe(false)
      expect(decision.showDesktop).toBe(false)
      expect(decision.playSound).toBe(false)
    })

    it('shows channel notification when viewing a different channel in the same server', () => {
      tracker.updateContext({
        view_type: 'server_channel',
        server_id: 'srv-1',
        channel_id: 'ch-general',
      })

      const decision = tracker.shouldShowNotificationUI({
        server_id: 'srv-1',
        channel_id: 'ch-random',
        type: 'mention',
      })

      expect(decision.showToast).toBe(true)
    })

    it('shows channel notification when viewing a DM', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })

      const decision = tracker.shouldShowNotificationUI({
        server_id: 'srv-1',
        channel_id: 'ch-1',
        type: 'mention',
      })

      expect(decision.showToast).toBe(true)
    })

    it('shows notification when context has no location data', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })

      const decision = tracker.shouldShowNotificationUI({
        type: 'activitypub_follow',
      })

      expect(decision.showToast).toBe(true)
    })

    it('shows toast for DM with undefined conversation_id when no fallback provided', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })

      const decision = tracker.shouldShowNotificationUI({
        conversation_id: undefined,
        type: 'dm',
      })

      expect(decision.showToast).toBe(true)
    })

    it('suppresses DM with undefined conversation_id when activeConversationId matches', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })

      const decision = tracker.shouldShowNotificationUI(
        { conversation_id: undefined, type: 'dm' },
        'conv-1' // fallback from DM store
      )

      expect(decision.showToast).toBe(false)
      expect(decision.reason).toContain('fallback')
    })

    it('shows toast for DM with undefined conversation_id when activeConversationId differs', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })

      const decision = tracker.shouldShowNotificationUI(
        { conversation_id: undefined, type: 'dm' },
        'conv-other'
      )

      expect(decision.showToast).toBe(true)
    })
  })

  describe('reset', () => {
    it('resets context back to home', () => {
      tracker.updateContext({
        view_type: 'dm',
        conversation_id: 'conv-1',
      })
      tracker.reset()
      expect(tracker.getCurrentContext().view_type).toBe('home')
      expect(tracker.isViewingConversation('conv-1')).toBe(false)
    })
  })
})
