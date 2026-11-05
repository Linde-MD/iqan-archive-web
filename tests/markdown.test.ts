import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/utils/markdown';

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
