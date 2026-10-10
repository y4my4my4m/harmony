import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_URL: 'http://localhost:54321',
  },
}));

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PushNotificationService } from '../services/PushNotificationService.js';

describe('push body for a poll', () => {
  it('previews the question, not the spelled-out answers', () => {
    const payload = (PushNotificationService as any).buildPayloadFromNotification({
      id: 'n1',
      user_id: 'u1',
      type: 'dm',
      data: {
        sender: { username: 'alice' },
        message: {
          id: 'm1',
          content: [
            { type: 'poll', pollId: 'p1', question: 'Lunch?', options: ['Pizza', 'Sushi'] },
            { type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Sushi' },
          ],
        },
      },
    });
    expect(payload.body).toBe('📊 Lunch?');
  });
});
