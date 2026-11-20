const mentionPrefix = '#archive-mention-';
const mentionAddress = /^#archive-mention-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function mentionIdFromHref(href: unknown) {
  return typeof href === 'string' ? href.match(mentionAddress)?.[1] : undefined;
}

export function mentionMarkdown(id: string, name: string) {
  const label = name.replace(/[\r\n]/g, ' ').replace(/[!-/:-@[-`{-~]/g, '\\$&');
  return `[@${label}](${mentionPrefix}${id})`;
}

export function findMentionQuery(text: string, caret: number) {
  const from = text.lastIndexOf('@', caret - 1);
  if (from < 0 || from >= caret || (from > 0 && /[a-z0-9_.%+-]/i.test(text[from - 1]!))) return;
  const query = text.slice(from + 1, caret);
  if (/[\s@]/u.test(query)) return;
  return { from, to: caret, query };
}
