import MarkdownIt from 'markdown-it';
import ins from 'markdown-it-ins';
import { findMentionQuery, mentionIdFromHref } from './markdown-mentions';

export function createMarkdownTokenizer(html = false) {
  const tokenizer = new MarkdownIt({ breaks: true, html, linkify: false, typographer: false }).use(ins);
  tokenizer.core.ruler.after('inline', 'archive_checklist', ({ tokens, md, env }) => {
    tokens.forEach((token, index) => {
      const inline = tokens[index + 2];
      if (token.type !== 'list_item_open' || !/^[-+*]$/.test(token.markup)
        || tokens[index + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') return;
      const marker = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
      if (!marker) return;
      token.meta = { checked: marker[1] !== ' ' };
      inline.content = inline.content.slice(marker[0].length);
      inline.children = [];
      md.inline.parse(inline.content, md, env, inline.children);
    });
  });
  tokenizer.core.ruler.after('text_join', 'archive_mentions', ({ tokens }) => {
    for (const token of tokens) {
      const children = token.children;
      if (!children) continue;
      for (let index = 0; index < children.length - 2; index++) {
        const open = children[index]!;
        const text = children[index + 1]!;
        const close = children[index + 2]!;
        const id = open.type === 'link_open' ? mentionIdFromHref(open.attrGet('href')) : undefined;
        if (!id || text.type !== 'text' || !text.content.startsWith('@') || text.content.length < 2
          || close.type !== 'link_close' || open.attrGet('title')) continue;
        open.type = 'archive_mention';
        open.nesting = 0;
        open.content = text.content.slice(1);
        open.meta = { id, name: open.content };
        children.splice(index + 1, 2);
      }
    }
  });
  return tokenizer;
}

const markdown = createMarkdownTokenizer();

export function normalizeEditorLink(input: string): string | null {
  const url = input.trim();
  if (!url || /[\s\\<>"\u0000-\u001f\u007f]/u.test(url)) return null;
  const normalized = markdown.normalizeLink(url);
  return markdown.validateLink(normalized) ? normalized : null;
}

markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]!.content);
markdown.renderer.rules.archive_mention = (tokens, index) =>
  `<span class="markdown-mention">@${markdown.utils.escapeHtml(tokens[index]!.content)}</span>`;
markdown.renderer.rules.list_item_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!;
  if (typeof token.meta?.checked !== 'boolean') return renderer.renderToken(tokens, index, options);
  return `<li class="markdown-task-item"><input type="checkbox" class="markdown-task-check" aria-label="清单项" disabled${token.meta.checked ? ' checked' : ''}>`;
};
markdown.renderer.rules.table_open = (tokens, index, options, _env, renderer) =>
  `<div class="markdown-table-scroll">${renderer.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = (tokens, index, options, _env, renderer) =>
  `${renderer.renderToken(tokens, index, options)}</div>`;

export function renderMarkdown(source: string): string {
  return markdown.render(source);
}

export function markdownMentionIds(source: string): string[] {
  return [...new Set(markdown.parse(source, {}).flatMap(token => (token.children ?? [])
    .flatMap(child => child.type === 'archive_mention' && typeof child.meta?.id === 'string' ? [child.meta.id] : [])))];
}

export function sourceMentionQuery(source: string, caret: number) {
  const query = findMentionQuery(source, caret);
  if (!query) return;
  let marker = '\uE000archive-mention-caret\uE001';
  while (source.includes(marker)) marker += '_';
  const marked = source.slice(0, query.from) + marker + source.slice(query.from);
  for (const token of markdown.parse(marked, {})) {
    let linkDepth = 0;
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') linkDepth++;
      if (child.type === 'link_close') linkDepth--;
      if (child.type === 'text' && !linkDepth && child.content.includes(marker)) return query;
    }
  }
}
