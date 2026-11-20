import { MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer, schema } from 'prosemirror-markdown';
import { Schema, type DOMOutputSpec } from 'prosemirror-model';
import { createMarkdownTokenizer, renderMarkdown } from './markdown';
import { mentionMarkdown } from './markdown-mentions';

const alignment = (style: string | null) => /^text-align:(left|center|right)$/.exec(style ?? '')?.[1] ?? null;
const cellDOM = (tag: string, align: string | null): DOMOutputSpec =>
  [tag, align ? { style: `text-align:${align}` } : {}, 0];

export const richMarkdownSchema = new Schema({
  nodes: schema.spec.nodes.update('list_item', {
    ...schema.nodes.list_item!.spec,
    attrs: { checked: { default: null } },
    parseDOM: [{ tag: 'li', getAttrs: dom => {
      const checked = (dom as HTMLElement).getAttribute('data-checked');
      return { checked: checked === 'true' ? true : checked === 'false' ? false : null };
    } }],
    toDOM: node => ['li', node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked) }, 0],
  }).append({
    mention: {
      group: 'inline', inline: true, atom: true,
      attrs: { id: {}, name: {} },
      toDOM: node => ['span', { class: 'markdown-mention', 'data-account-id': node.attrs.id }, `@${node.attrs.name}`],
      leafText: node => `@${node.attrs.name}`,
    },
    table: { group: 'block', content: 'table_head table_body?', parseDOM: [{ tag: 'table' }], toDOM: () => ['div', { class: 'markdown-table-scroll' }, ['table', 0]] },
    table_head: { content: 'table_row', parseDOM: [{ tag: 'thead' }], toDOM: () => ['thead', 0] },
    table_body: { content: 'table_row+', parseDOM: [{ tag: 'tbody' }], toDOM: () => ['tbody', 0] },
    table_row: { content: 'table_header+ | table_cell+', parseDOM: [{ tag: 'tr' }], toDOM: () => ['tr', 0] },
    table_header: { content: 'inline*', attrs: { align: { default: null } }, parseDOM: [{ tag: 'th', getAttrs: dom => ({ align: alignment((dom as HTMLElement).getAttribute('style')) }) }], toDOM: node => cellDOM('th', node.attrs.align) },
    table_cell: { content: 'inline*', attrs: { align: { default: null } }, parseDOM: [{ tag: 'td', getAttrs: dom => ({ align: alignment((dom as HTMLElement).getAttribute('style')) }) }], toDOM: node => cellDOM('td', node.attrs.align) },
  }),
  marks: schema.spec.marks
    .addBefore('code', 'underline', { parseDOM: [{ tag: 'ins' }, { tag: 'u' }, { style: 'text-decoration', getAttrs: value => /\bunderline\b/.test(value) && null }], toDOM: () => ['ins', 0] })
    .addBefore('code', 'strike', { parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration', getAttrs: value => /\bline-through\b/.test(value) && null }], toDOM: () => ['s', 0] }),
});

const tokenizer = createMarkdownTokenizer(true);
const parser = new MarkdownParser(richMarkdownSchema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  softbreak: { node: 'hard_break' },
  ins: { mark: 'underline' },
  s: { mark: 'strike' },
  list_item: { block: 'list_item', getAttrs: token => ({ checked: token.meta?.checked ?? null }) },
  archive_mention: { node: 'mention', getAttrs: token => ({ id: token.meta.id, name: token.meta.name }) },
  table: { block: 'table' },
  thead: { block: 'table_head' },
  tbody: { block: 'table_body' },
  tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: token => ({ align: alignment(token.attrGet('style')) }) },
  td: { block: 'table_cell', getAttrs: token => ({ align: alignment(token.attrGet('style')) }) },
});

const alignmentMarker: Record<string, string> = { left: ':---', center: ':---:', right: '---:' };
export const richMarkdownSerializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  mention(state, node) { state.write(mentionMarkdown(node.attrs.id, node.attrs.name)); },
  list_item(state, node) {
    if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ');
    state.renderContent(node);
  },
  table(state, table) {
    const header = table.firstChild!.firstChild!;
    const renderRow = (row: typeof header) => {
      state.write('|');
      row.forEach(cell => {
        const paragraph = richMarkdownSchema.nodes.paragraph!.create(null, cell.content);
        const content = richMarkdownSerializer.serialize(richMarkdownSchema.topNodeType.create(null, paragraph));
        state.write(` ${content.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')} |`);
      });
    };
    renderRow(header);
    state.write('\n|');
    header.forEach(cell => state.write(` ${alignmentMarker[cell.attrs.align] ?? '---'} |`));
    table.maybeChild(1)?.forEach(row => {
      state.write('\n');
      renderRow(row);
    });
    state.closeBlock(table);
  },
}, {
  ...defaultMarkdownSerializer.marks,
  underline: { open: '++', close: '++', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
}, { escapeExtraCharacters: /[+~]/g });

export function readRichMarkdown(source: string) {
  const env: NonNullable<Parameters<typeof tokenizer.parse>[1]> = {};
  const tokens = tokenizer.parse(source, env);
  const unsupported = (token: (typeof tokens)[number]): boolean =>
    ['image', 'html_inline', 'html_block'].includes(token.type) || !!token.children?.some(unsupported);
  if (env.references || tokens.some(unsupported)) return null;
  const doc = parser.parse(source);
  return renderMarkdown(source) === renderMarkdown(richMarkdownSerializer.serialize(doc)) ? doc : null;
}
