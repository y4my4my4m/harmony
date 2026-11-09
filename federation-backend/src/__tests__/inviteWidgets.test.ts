import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'chat.example', INSTANCE_NAME: 'Harmony', PUBLIC_SUPABASE_URL: 'https://db.example' },
}));

import { badgeStyle, renderInviteBadge, renderInviteCard, textWidth, widgetTheme } from '../services/inviteWidgets.js';

const preview = {
  code: 'ABCD1234',
  name: 'Evening <Lounge> & "friends"',
  description: null,
  icon: null,
  banner: null,
  memberCount: 1234,
  onlineCount: 56,
};

describe('renderInviteBadge', () => {
  it('escapes the name and shows the online count', () => {
    const svg = renderInviteBadge(preview);
    expect(svg).toContain('&lt;Lounge&gt; &amp; &quot;friends&quot;');
    expect(svg).not.toContain('<Lounge>');
    expect(svg).toContain('56 online');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('falls back to the member count', () => {
    expect(renderInviteBadge({ ...preview, onlineCount: 0 })).toContain('1,234 members');
    expect(renderInviteBadge({ ...preview, onlineCount: null, memberCount: 1 })).toContain('1 member<');
  });

  it('removes characters XML refuses', () => {
    expect(renderInviteBadge({ ...preview, name: 'a\u0001b\u0008c' })).toContain('>abc<');
  });

  it('drops custom emoji shortcodes and truncates a long name', () => {
    const svg = renderInviteBadge({ ...preview, name: `:blob: ${'x'.repeat(60)}` });
    expect(svg).not.toContain(':blob:');
    expect(svg).toContain(`${'x'.repeat(27)}…`);
  });

  it('draws the icon style square, and the join style in the locale', () => {
    expect(renderInviteBadge(preview, { style: 'icon' })).toContain('width="28" height="28"');
    expect(renderInviteBadge(preview, { style: 'join', lang: 'ja' })).toContain('Harmonyで参加');
  });

  it('draws a dead invite without naming a server', () => {
    const svg = renderInviteBadge(null);
    expect(svg).toContain('Invite no longer valid');
    expect(svg).not.toContain('Lounge');
  });

  it('sizes wide script wider than latin', () => {
    expect(textWidth('ひらがな', 12)).toBeGreaterThan(textWidth('abcd', 12));
  });

  it('ignores unknown query values', () => {
    expect(widgetTheme('<x>')).toBe('dark');
    expect(badgeStyle('<x>')).toBe('full');
    expect(renderInviteBadge(preview, { lang: '__proto__' })).toContain('56 online');
  });
});

describe('renderInviteCard', () => {
  it('links to the invite in a new context and runs no script', () => {
    const html = renderInviteCard(preview);
    expect(html).toContain('href="https://chat.example/invite/ABCD1234"');
    expect(html).toContain('target="_blank" rel="noopener"');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;Lounge&gt;');
  });

  it('uses the instance icon when the server has none', () => {
    expect(renderInviteCard(preview)).toContain('https://chat.example/img/app_icon_square.png');
  });

  it('names no server on a dead invite', () => {
    const html = renderInviteCard(null, { lang: 'fr' });
    expect(html).toContain('invitation');
    expect(html).not.toContain('Lounge');
  });
});
