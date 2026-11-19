import { describe, expect, it } from 'vitest';
import { EditorState, type Command } from 'prosemirror-state';
import { normalizeEditorLink, renderMarkdown } from '../src/utils/markdown';
import { readRichMarkdown, richMarkdownSerializer } from '../src/utils/rich-markdown';
import { addMarkdownTableColumn, addMarkdownTableRow, insertMarkdownTable, toggleChecklist } from '../src/utils/markdown-editor-commands';

describe('rich Markdown round trip', () => {
  it('keeps multiline formatting and serializes edits back to Markdown', () => {
    const source = '## 调整说明\n\n首行 **加粗**\n第二行\n\n- 一\n- 二\n\n> 引用\n\n```ts\nconst a = 1;\n```';
    const doc = readRichMarkdown(source)!;
    expect(doc).not.toBeNull();
    expect(renderMarkdown(richMarkdownSerializer.serialize(doc))).toBe(renderMarkdown(source));
    const heading = doc.firstChild!;
    const edited = doc.copy(doc.content.replaceChild(0, heading.copy(heading.content.replaceChild(0, doc.type.schema.text('修改后')))));
    expect(richMarkdownSerializer.serialize(edited)).toContain('## 修改后');
  });

  it.each([
    '![图片](https://example.invalid/image.png)',
    '<div>保留 HTML 源文</div>',
    '[链接][ref]\n\n[ref]: https://example.invalid/',
  ])('keeps unsupported content in source mode: %s', source => {
    expect(readRichMarkdown(source)).toBeNull();
  });

  it('round-trips extended formats, aligned tables, and escaped pipes', () => {
    const source = '++下划线++ 和 ~~删除线~~ ~~`a*b`~~ [链接](https://example.invalid/a)\n\n- [x] **完成**\n- [ ] 待办\n\n'
      + '| 状态 | 数值 |\n| :---: | ---: |\n| `a\\|b` | 50\\|100 |\n\n```ts\nconst a = 1;\n```';
    const doc = readRichMarkdown(source);
    expect(doc).not.toBeNull();
    const html = renderMarkdown(source);
    expect(html).toContain('<ins>下划线</ins>');
    expect(html).toContain('<s>删除线</s>');
    expect(html).toContain('<s><code>a*b</code></s>');
    expect(html).toContain('disabled checked');
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain('<code>a|b</code>');
    expect(renderMarkdown(richMarkdownSerializer.serialize(doc!))).toBe(html);
  });

  it('creates a checklist and writes changes in a new table row as Markdown', () => {
    let state = EditorState.create({ doc: readRichMarkdown('草稿')! });
    const run = (command: Command) => expect(command(state, tr => { state = state.apply(tr); })).toBe(true);
    run(toggleChecklist);
    expect(richMarkdownSerializer.serialize(state.doc)).toMatch(/^[*-] \[ \] 草稿$/);
    run(insertMarkdownTable);
    expect(state.selection.$from.parent.type.name).toBe('table_header');
    state = state.apply(state.tr.insertText('标题'));
    run(addMarkdownTableRow);
    expect(state.selection.$from.parent.type.name).toBe('table_cell');
    run(addMarkdownTableColumn);
    state = state.apply(state.tr.insertText('a|b'));
    const source = richMarkdownSerializer.serialize(state.doc);
    expect(source).toContain('| 标题 |  |  |');
    expect(source).toContain('| a\\|b |  |  |');
    expect(readRichMarkdown(source)).not.toBeNull();
  });

  it('does not turn a literal checkbox marker into a checklist on a round trip', () => {
    const source = '- \\[x] 普通文本';
    const doc = readRichMarkdown(source);
    expect(doc).not.toBeNull();
    const html = renderMarkdown(richMarkdownSerializer.serialize(doc!));
    expect(html).toContain('[x] 普通文本');
    expect(html).not.toContain('type="checkbox"');
  });
});

it('validates rich-editor link addresses without enabling raw HTML', () => {
  expect(normalizeEditorLink(' https://example.invalid/a_(b) ')).toBe('https://example.invalid/a_(b)');
  expect(normalizeEditorLink('JaVaScRiPt:alert(1)')).toBeNull();
  expect(normalizeEditorLink('https://example.invalid/a b')).toBeNull();
  expect(renderMarkdown('<ins>原始 HTML</ins>')).toContain('&lt;ins&gt;');
});

describe('renderMarkdown', () => {
  it('renders Markdown formatting, line breaks, and tables', () => {
    const html = renderMarkdown([
      '## 调整说明',
      '',
      '首行 **加粗**',
      '第二行',
      '',
      '| 状态 | 数值 |',
      '| --- | ---: |',
      '| 低 | 500mA |',
    ].join('\n'));

    expect(html).toContain('<h2>调整说明</h2>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<br>');
    expect(html).toContain('<table>');
    expect(html).toContain('500mA');
  });

  it('escapes raw HTML, rejects unsafe link protocols, and does not render remote images', () => {
    const html = renderMarkdown([
      '<script>alert(1)</script>',
      '[危险链接](javascript:alert(1))',
      '![远程图片](https://example.invalid/image.png)',
    ].join('\n'));

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://example.invalid/image.png');
    expect(html).toContain('远程图片');
  });
});
