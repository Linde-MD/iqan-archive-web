import MarkdownIt from 'markdown-it';
import ins from 'markdown-it-ins';

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
