import { describe, expect, it } from 'vitest';
import { EditorState, type Command } from 'prosemirror-state';
import { history, undo } from 'prosemirror-history';
import { markdownMentionIds, normalizeEditorLink, renderMarkdown, sourceMentionQuery } from '../src/utils/markdown';
import { findMentionQuery, mentionMarkdown } from '../src/utils/markdown-mentions';
import { readRichMarkdown, richMarkdownSerializer } from '../src/utils/rich-markdown';
import { addMarkdownTableColumn, addMarkdownTableRow, insertMarkdownTable, setMarkdownCodeBlock, toggleChecklist } from '../src/utils/markdown-editor-commands';

describe('rich Markdown round trip', () => {
  it('round-trips an atomic account mention with escaped labels and removes its recipient when deleted', () => {
    const id = 'a62529ce-9359-40af-84b2-685d5e51d55c';
    const name = '同名 [A] <img src=x> _测试_';
    const source = mentionMarkdown(id, name);
    const doc = readRichMarkdown(source)!;
    expect(doc).not.toBeNull();
    expect(doc.firstChild!.firstChild).toMatchObject({ type: { name: 'mention' }, attrs: { id, name } });
    expect(markdownMentionIds(richMarkdownSerializer.serialize(doc))).toEqual([id]);
    expect(renderMarkdown(source)).toContain('&lt;img src=x&gt;');
    expect(renderMarkdown(source)).not.toContain('<img');
    expect(renderMarkdown(source)).not.toContain('<a ');
    const state = EditorState.create({ doc });
    const deleted = state.apply(state.tr.delete(1, 2));
    expect(markdownMentionIds(richMarkdownSerializer.serialize(deleted.doc))).toEqual([]);
  });

  it('keeps same-name recipients separate, deduplicates repeated mentions and ignores code or plain @ text', () => {
    const first = 'a62529ce-9359-40af-84b2-685d5e51d55c';
    const second = 'c0bf8244-c2ce-4a14-9f4f-4d3e6ee4640f';
    const a = mentionMarkdown(first, '同名');
    const b = mentionMarkdown(second, '同名');
    const source = `${a} ${b} ${a} @普通文字\n\n\`${b}\`\n\n\`\`\`\n${a}\n\`\`\``;
    expect(markdownMentionIds(source)).toEqual([first, second]);
    expect(markdownMentionIds('@同名 `@同名` [@同名](https://example.invalid)')).toEqual([]);
    expect(markdownMentionIds('[@同名](#archive-mention-not-an-account)')).toEqual([]);
  });

  it('keeps mention labels as plain text when converting a paragraph to code, with atomic undo', () => {
    const first = 'a62529ce-9359-40af-84b2-685d5e51d55c';
    const second = 'c0bf8244-c2ce-4a14-9f4f-4d3e6ee4640f';
    const doc = readRichMarkdown(`${mentionMarkdown(first, '成员一')} 说明\n\n${mentionMarkdown(second, '成员二')}`)!;
    let state = EditorState.create({ doc, plugins: [history()] });
    expect(setMarkdownCodeBlock(state, tr => { state = state.apply(tr); })).toBe(true);
    const source = richMarkdownSerializer.serialize(state.doc);
    expect(source).toContain('```\n@成员一 说明\n```');
    expect(markdownMentionIds(source)).toEqual([second]);
    expect(undo(state, tr => { state = state.apply(tr); })).toBe(true);
    expect(state.doc.eq(doc)).toBe(true);
  });

  it('keeps multiline formatting and serializes edits back to Markdown', () => {
    const source = '## 调整说明\n\n首行 **加粗**\n第二行\n\n- 一\n- 二\n\n> 引用\n\n```ts\nconst a = 1;\n```';
    const doc = readRichMarkdown(source)!;
    expect(doc).not.toBeNull();
    expect(renderMarkdown(richMarkdownSerializer.serialize(doc))).toBe(renderMarkdown(source));
    const heading = doc.firstChild!;
    const edited = doc.copy(doc.content.replaceChild(0, heading.copy(heading.content.replaceChild(0, doc.type.schema.text('修改后')))));
    expect(richMarkdownSerializer.serialize(edited)).toContain('## 修改后');
  });

  describe('comment mention completion', () => {
    it('uses the active @ query and caret range without treating email addresses as mentions', () => {
      expect(findMentionQuery('@', 1)).toEqual({ from: 0, to: 1, query: '' });
      expect(findMentionQuery('请@张三', 4)).toEqual({ from: 1, to: 4, query: '张三' });
      expect(findMentionQuery('请 @张三 后续文本', 5)).toEqual({ from: 2, to: 5, query: '张三' });
      expect(findMentionQuery('回复，@zhang', 9)).toEqual({ from: 3, to: 9, query: 'zhang' });
      expect(findMentionQuery('name@example.com', 16)).toBeUndefined();
      expect(findMentionQuery('@张 三', 4)).toBeUndefined();
    });

    it('does not open source suggestions inside code, links or images', () => {
      for (const [source, caret] of [
        ['`@张`', 3],
        ['```\n@张\n```', 6],
        ['    @张', 6],
        ['[@张](https://example.invalid)', 3],
        ['![@张](image.png)', 4],
      ] as const) expect(sourceMentionQuery(source, caret), source).toBeUndefined();
      expect(sourceMentionQuery('**检查** @张', 9)).toEqual({ from: 7, to: 9, query: '张' });
    });
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
