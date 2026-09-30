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

const CIPHERTEXT = 'Q2lwaGVydGV4dENpcGhlcnRleHRDaXBoZXJ0ZXh0Q2lwaGVydGV4dA==';

function build(type: string, data: Record<string, any>) {
  return (PushNotificationService as any).buildPayloadFromNotification({
    id: 'n1',
    user_id: 'u1',
    type,
    data,
  });
}

describe('push body for encrypted messages', () => {
  it('uses the generic preview when the notification is flagged encrypted', () => {
    const payload = build('mention', {
      sender: { username: 'alice' },
      encrypted: true,
      message: { id: 'm1', content_preview: CIPHERTEXT, content: [{ type: 'text', text: CIPHERTEXT }] },
    });
    expect(payload.body).toBe('Encrypted message');
    expect(payload.message).toBe('Encrypted message');
  });

  it('uses the generic preview when only the message object is flagged', () => {
    const payload = build('dm', {
      sender: { username: 'alice' },
      message: { id: 'm1', encrypted: true, content: [{ type: 'text', text: CIPHERTEXT }] },
    });
    expect(payload.body).toBe('Encrypted message');
  });

  it('keeps plaintext previews for unencrypted messages', () => {
    const payload = build('mention', {
      sender: { username: 'alice' },
      message: { id: 'm1', content_preview: 'hello there' },
    });
    expect(payload.body).toBe('hello there');
  });
});
