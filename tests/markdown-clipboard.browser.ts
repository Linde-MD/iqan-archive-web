import { createApp, h, nextTick, reactive } from 'vue';
import { DOMSerializer } from 'prosemirror-model';
import MarkdownEditor from '../src/components/MarkdownEditor.vue';
import { clipboardContent, sanitizeClipboardHTML } from '../src/utils/markdown-clipboard';
import { renderMarkdown } from '../src/utils/markdown';
import { readRichMarkdown, richMarkdownSchema } from '../src/utils/rich-markdown';

const state = reactive({ rich: '', source: '' });
const result = document.querySelector<HTMLElement>('#result')!;
const app = createApp({
  render: () => h('div', [
    h(MarkdownEditor, { modelValue: state.rich, 'onUpdate:modelValue': (value: string) => { state.rich = value; }, textareaId: 'test-rich', label: '富文本' }),
    h(MarkdownEditor, { modelValue: state.source, 'onUpdate:modelValue': (value: string) => { state.source = value; }, textareaId: 'test-source', label: '源码' }),
  ]),
});
app.mount('#app');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function paste(target: HTMLElement, html: string, text: string) {
  const clipboard = new DataTransfer();
  if (html) clipboard.setData('text/html', html);
  if (text) clipboard.setData('text/plain', text);
  target.focus();
  const event = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function run() {
  await nextTick();
  const select = document.querySelector<HTMLSelectElement>('[aria-label="源码编辑方式"]')!;
  select.value = 'source';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  const rich = document.querySelector<HTMLElement>('#test-rich-rich')!;
  const source = document.querySelector<HTMLTextAreaElement>('#test-source')!;
  const original = '## 标题\n\n**加粗** *斜体* ++下划线++ ~~删除线~~ [链接](https://example.invalid)\n\n'
    + '- [x] 完成\n- [ ] 待办\n\n| 项目 | 值 |\n| --- | ---: |\n| 一 | 二 |\n\n```ts\nconst a = 1;\n```';
  const html = renderMarkdown(original);
  assert(paste(rich, html, '标题 加粗'), '富文本没有处理粘贴');
  assert(paste(source, html, '标题 加粗'), '源码没有处理粘贴');
  await nextTick();
  assert(renderMarkdown(state.rich) === renderMarkdown(original), '富文本格式未完整保留');
  assert(renderMarkdown(state.source) === renderMarkdown(original), '源码转换格式未完整保留');

  source.focus();
  source.value = '前 原文 后';
  source.dispatchEvent(new Event('input', { bubbles: true }));
  source.setSelectionRange(2, 4);
  paste(source, '<strong>替换</strong>', '替换');
  assert(source.value === '前 **替换** 后', '源码粘贴未替换选区');
  assert(document.execCommand('undo') && source.value.toString() === '前 原文 后', '源码粘贴无法撤销');

  const styled = clipboardContent('<p><span style="font-weight:700;font-style:italic;text-decoration:underline line-through">格式</span></p>', '格式', document).markdown;
  const styledHtml = renderMarkdown(styled);
  for (const tag of ['strong', 'em', 'ins', 's']) assert(styledHtml.includes(`<${tag}>`), `行内样式丢失：${tag}`);
  const copied = document.createElement('div');
  copied.append(DOMSerializer.fromSchema(richMarkdownSchema).serializeFragment(readRichMarkdown('- [x] 完成\n- [ ] 待办')!.content));
  const checklist = clipboardContent(copied.innerHTML, '完成\n待办', document).markdown;
  assert(checklist.includes('[x] 完成') && checklist.includes('[ ] 待办'), '富文本复制清单状态丢失');
  const rawMarkdown = '## 标题\n\n**版本说明**';
  const rawClipboard = clipboardContent('<div>## 标题<br><br>**版本说明**</div>', rawMarkdown, document);
  assert(rawClipboard.markdown === rawMarkdown && rawClipboard.html.includes('<strong>版本说明</strong>'), '节点里的 Markdown 文本未转换');
  const table = clipboardContent('<table><tr><th><p>标题</p></th><th><p>数量</p></th></tr><tr><td><p><strong>内容</strong></p><p>第二行</p></td><td>12</td></tr></table>', '', document).markdown;
  assert(table.includes('| 标题') && table.includes('**内容**') && table.includes('第二行') && table.includes('12')
    && table.split('\n').length === 3, '带段落的剪贴板表格未保留为单个表格');

  const unsafe = '<p>文本<img src="/clipboard-test-must-not-load" alt="图片"><script>evil()</script>'
    + '<a href="javascript:alert(1)" onclick="evil()">危险</a><a href="https://example.invalid">安全</a></p>';
  const clean = sanitizeClipboardHTML(unsafe, document);
  assert(!/<(?:img|script)|javascript:|onclick/i.test(clean), '不安全内容未清除');
  const safeMarkdown = clipboardContent(unsafe, '文本图片危险安全', document).markdown;
  assert(safeMarkdown.includes('图片') && safeMarkdown.includes('危险') && safeMarkdown.includes('[安全](https://example.invalid)'), '安全文本或链接丢失');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(!performance.getEntriesByName(`${location.origin}/clipboard-test-must-not-load`).length, '粘贴加载了远程图片');

  state.rich = '';
  await nextTick();
  let currentRich = document.querySelector<HTMLElement>('#test-rich-rich')!;
  paste(currentRich, '', rawMarkdown);
  await nextTick();
  assert(renderMarkdown(state.rich) === renderMarkdown(rawMarkdown), 'Markdown 纯文本粘贴到富文本失败');
  state.rich = '';
  await nextTick();
  currentRich = document.querySelector<HTMLElement>('#test-rich-rich')!;
  paste(currentRich, '', '普通文本\n第二行');
  await nextTick();
  assert(state.rich.includes('普通文本') && state.rich.includes('第二行'), '纯文本粘贴失败');
  assert(!paste(source, '', '普通文本'), '源码纯文本粘贴不应拦截浏览器默认行为');

  result.textContent = 'PASS：格式、源码、清单、安全和纯文本';
  result.dataset.passed = 'true';
  app.unmount();
}

run().catch((cause: unknown) => {
  result.textContent = `FAIL: ${cause instanceof Error ? cause.stack : String(cause)}`;
  result.dataset.passed = 'false';
});
