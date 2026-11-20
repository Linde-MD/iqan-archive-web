import { DOMParser as ProseMirrorDOMParser, type Node as ProseMirrorNode } from 'prosemirror-model';
import { normalizeEditorLink, renderMarkdown } from './markdown';
import { readRichMarkdown, richMarkdownSchema, richMarkdownSerializer } from './rich-markdown';

const allowed = new Set([
  'p', 'div', 'span', 'br', 'strong', 'b', 'em', 'i', 'ins', 'u', 's', 'del', 'strike',
  'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li',
  'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const discarded = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'video', 'audio']);

export function sanitizeClipboardHTML(html: string, document: Document): string {
  const input = document.createElement('template');
  input.innerHTML = html;
  const output = document.createElement('div');

  function copy(node: Node, parent: Node) {
    if (node.nodeType === 3) {
      parent.appendChild(document.createTextNode(node.textContent ?? ''));
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    const tag = element.localName.toLowerCase();
    if (discarded.has(tag) || tag === 'input') return;
    if (tag === 'img') {
      parent.appendChild(document.createTextNode(element.getAttribute('alt') ?? ''));
      return;
    }
    if (!allowed.has(tag)) {
      for (const child of element.childNodes) copy(child, parent);
      return;
    }
    const clean = document.createElement(tag);
    if (tag === 'a') {
      const href = normalizeEditorLink(element.getAttribute('href') ?? '');
      if (href) clean.setAttribute('href', href);
      const title = element.getAttribute('title');
      if (href && title) clean.setAttribute('title', title);
    }
    if (tag === 'ol' && /^\d{1,6}$/.test(element.getAttribute('start') ?? ''))
      clean.setAttribute('start', element.getAttribute('start')!);
    if (tag === 'ul' || tag === 'ol') {
      const items = [...element.children].filter(child => child.localName === 'li');
      if (element.hasAttribute('data-tight') || (items.length && items.every(item => !item.querySelector(':scope > p'))))
        clean.setAttribute('data-tight', 'true');
    }
    if (tag === 'li') {
      const checkbox = element.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p:first-child > input[type="checkbox"]');
      const checked = checkbox ? String(checkbox.checked) : element.getAttribute('data-checked');
      if (checked === 'true' || checked === 'false') clean.setAttribute('data-checked', checked);
    }
    if (tag === 'pre') {
      const language = element.getAttribute('data-params') ?? element.querySelector('code')?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1];
      if (language && /^[\w+-]+$/.test(language)) clean.setAttribute('data-params', language);
    }
    let destination: Node = clean;
    if (tag === 'th' || tag === 'td') {
      const align = element.style.textAlign || element.getAttribute('align');
      if (align && /^(left|center|right)$/.test(align)) clean.setAttribute('style', `text-align:${align}`);
    } else {
      const styles: string[] = [];
      if (/^(bold|bolder|[5-9]00)$/.test(element.style.fontWeight)) styles.push(`font-weight:${element.style.fontWeight}`);
      if (element.style.fontStyle === 'italic') styles.push('font-style:italic');
      const decoration = element.style.textDecorationLine || element.style.textDecoration;
      const lines = ['underline', 'line-through'].filter(value => decoration.split(/\s+/).includes(value));
      if (styles.length) clean.setAttribute('style', styles.join(';'));
      for (const line of lines) {
        const mark = document.createElement(line === 'underline' ? 'u' : 's');
        destination.appendChild(mark);
        destination = mark;
      }
    }
    parent.appendChild(clean);
    for (const child of element.childNodes) copy(child, destination);
    if (tag === 'pre') {
      const walker = document.createTreeWalker(clean, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      while (walker.nextNode()) last = walker.currentNode;
      if (last?.textContent?.endsWith('\n')) last.textContent = last.textContent.slice(0, -1);
    }
  }

  for (const node of input.content.childNodes) copy(node, output);
  for (const table of output.querySelectorAll('table')) {
    const rows = [...table.rows];
    if (!rows.length) {
      table.replaceWith(document.createTextNode(table.textContent ?? ''));
      continue;
    }
    const width = Math.max(...rows.map(row => row.cells.length));
    if (!width) {
      table.remove();
      continue;
    }
    const head = document.createElement('thead');
    const body = document.createElement('tbody');
    rows.forEach((row, rowIndex) => {
      const cleanRow = document.createElement('tr');
      const cells = [...row.cells];
      for (let index = 0; index < width; index++) {
        const cell = cells[index];
        const cleanCell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        const style = cell?.getAttribute('style');
        if (style) cleanCell.setAttribute('style', style);
        if (cell) {
          for (const block of [...cell.querySelectorAll('p,div,blockquote,ul,ol,li,pre,h1,h2,h3,h4,h5,h6,br')].reverse())
            block.replaceWith(...block.childNodes, document.createTextNode(' '));
          cleanCell.append(...cell.childNodes);
        }
        cleanRow.append(cleanCell);
      }
      (rowIndex === 0 ? head : body).append(cleanRow);
    });
    table.replaceChildren(head);
    if (body.children.length) table.append(body);
  }
  return output.innerHTML;
}

function parseClipboardHTML(html: string, document: Document) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return ProseMirrorDOMParser.fromSchema(richMarkdownSchema).parse(container);
}

function hasFormatting(doc: ProseMirrorNode) {
  let formatted = false;
  doc.descendants(node => {
    if (node.marks.length || !['paragraph', 'text', 'hard_break'].includes(node.type.name)) formatted = true;
  });
  return formatted;
}

export function clipboardContent(html: string, text: string, document: Document): { html: string; markdown: string } {
  const clean = sanitizeClipboardHTML(html, document);
  const htmlDoc = parseClipboardHTML(clean, document);
  const markdownDoc = text ? readRichMarkdown(text) : null;
  if (markdownDoc && hasFormatting(markdownDoc) && !hasFormatting(htmlDoc))
    return { html: sanitizeClipboardHTML(renderMarkdown(text), document), markdown: text };
  if (!htmlDoc.textContent && !hasFormatting(htmlDoc)) return { html: '', markdown: '' };
  return { html: clean, markdown: richMarkdownSerializer.serialize(htmlDoc) };
}
