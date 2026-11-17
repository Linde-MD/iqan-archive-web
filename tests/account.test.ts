import { describe, expect, it } from 'vitest';
import { ACCOUNT_AVATAR_THEMES, accountAvatarTheme, accountInitials } from '../src/domain/account';

function luminance(color: string) {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

describe('accountInitials', () => {
  it('uses the last two characters for a Chinese-only name', () => {
    expect(accountInitials('  李小明  ')).toBe('小明');
  });

  it('uses the first two Unicode characters for other names', () => {
    expect(accountInitials('A😀bc')).toBe('A😀');
  });

  it('falls back to the username and then a visitor label', () => {
    expect(accountInitials('', 'operator')).toBe('op');
    expect(accountInitials(null, '')).toBe('访客');
  });
});

describe('accountAvatarTheme', () => {
  it('assigns a stable theme from the account identity', () => {
    expect(accountAvatarTheme('user-123')).toEqual(accountAvatarTheme('user-123'));
    expect(accountAvatarTheme('user-123')).not.toEqual(accountAvatarTheme('user-456'));
    expect(accountAvatarTheme(null)).toEqual(accountAvatarTheme(''));
  });

  it('keeps initials readable on every theme', () => {
    for (const theme of ACCOUNT_AVATAR_THEMES) {
      const foreground = luminance(theme.foreground);
      const background = luminance(theme.background);
      expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
