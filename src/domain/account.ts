export interface AccountAvatarTheme {
  background: string;
  foreground: string;
  border: string;
}

export const ACCOUNT_AVATAR_THEMES = [
  { background: '#193B67', foreground: '#EAF3FF', border: '#86BDFF' },
  { background: '#134C4B', foreground: '#E5FFF8', border: '#75DCC8' },
  { background: '#3D2B63', foreground: '#F2ECFF', border: '#B99AF8' },
  { background: '#5A2D3B', foreground: '#FFEAF0', border: '#F4A4BA' },
  { background: '#57421E', foreground: '#FFF5D6', border: '#F0CC71' },
  { background: '#244D35', foreground: '#E9FFEF', border: '#8FDAA3' },
  { background: '#1C4560', foreground: '#E8F7FF', border: '#8CCFEA' },
  { background: '#3B4658', foreground: '#F0F4FA', border: '#B5C4D8' },
  { background: '#4B3030', foreground: '#FFF0EA', border: '#F0A899' },
  { background: '#30435C', foreground: '#F0F6FF', border: '#A6C8F0' },
  { background: '#433254', foreground: '#F7ECFF', border: '#D0A8F0' },
  { background: '#254A4A', foreground: '#E8FFFA', border: '#94DED4' },
] as const satisfies readonly AccountAvatarTheme[];

export function accountAvatarTheme(identity: string | null | undefined): AccountAvatarTheme {
  const seed = identity?.trim() || 'guest';
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193);
  }
  const index = (hash >>> 0) % ACCOUNT_AVATAR_THEMES.length;
  return ACCOUNT_AVATAR_THEMES[index] ?? ACCOUNT_AVATAR_THEMES[0];
}

export function accountInitials(displayName: string | null | undefined, username?: string | null): string {
  const name = displayName?.trim() || username?.trim() || '访客';
  const characters = Array.from(name);
  if (/^\p{Script=Han}+$/u.test(name)) return characters.slice(-2).join('');
  return characters.slice(0, 2).join('');
}
