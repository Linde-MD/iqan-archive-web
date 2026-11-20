<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { baseKeymap, chainCommands, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { normalizeEditorLink, renderMarkdown, sourceMentionQuery } from '../utils/markdown';
import { findMentionQuery, mentionMarkdown } from '../utils/markdown-mentions';
import { accountAvatarTheme, accountInitials } from '../domain/account';
import type { TaskAssignee } from '../domain/model';
import { addMarkdownTableColumn, addMarkdownTableRow, insertMarkdownTable, moveMarkdownCell, removeMarkdownTable, selectionAncestor, setMarkdownCodeBlock, toggleChecklist } from '../utils/markdown-editor-commands';
import AppIcon from './AppIcon.vue';
import { readRichMarkdown, richMarkdownSchema as schema, richMarkdownSerializer } from '../utils/rich-markdown';
import { clipboardContent } from '../utils/markdown-clipboard';
import 'prosemirror-view/style/prosemirror.css';

const props = withDefaults(defineProps<{
  modelValue: string;
  textareaId: string;
  label: string;
  rows?: number;
  disabled?: boolean;
  readonly?: boolean;
  compactToolbar?: boolean;
  inspectorToolbar?: boolean;
  composer?: boolean;
  placeholder?: string;
  mentionOptions?: TaskAssignee[];
}>(), { rows: 8 });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const activeText = ref(props.modelValue);
const source = computed({
  get: () => activeText.value,
  set: (value: string) => {
    activeText.value = value;
    emit('update:modelValue', value);
  },
});
const mode = ref<'rich' | 'source' | 'preview'>(readRichMarkdown(props.modelValue) ? 'rich' : 'source');
const unsupported = ref(mode.value === 'source');
const expanded = ref(false);
const richHost = ref<HTMLElement>();
const sourceInput = ref<HTMLTextAreaElement>();
const editorState = shallowRef<EditorState>();
const characterCount = computed(() => {
  const doc = editorState.value?.doc ?? readRichMarkdown(source.value);
  return Array.from(doc ? doc.textBetween(0, doc.content.size, '\n') : source.value).length;
});
const editable = computed(() => !props.disabled && !props.readonly);
const helpId = computed(() => `${props.textareaId}-help`);
const linkPanel = ref<{ from: number; to: number; text: string; url: string; existing: boolean }>();
const linkTextInput = ref<HTMLInputElement>();
const linkUrlInput = ref<HTMLInputElement>();
const linkError = ref('');
const pasteError = ref('');
let view: EditorView | undefined;
const mentionMenu = ref<HTMLElement>();
const mentionTarget = shallowRef<{
  from: number; to: number; query: string; mode: 'rich' | 'source';
  left: number; top: number; bottom: number;
}>();
const mentionIndex = ref(0);
const mentionMenuStyle = ref<Record<string, string>>({});
const mentionMenuId = computed(() => `${props.textareaId}-mentions`);
const mentionCandidates = computed(() => {
  const query = mentionTarget.value?.query.toLocaleLowerCase() ?? '';
  return (props.mentionOptions ?? []).filter(option => !option.disabled
    && `${option.displayName} ${option.username}`.toLocaleLowerCase().includes(query));
});
const activeMentionId = computed(() => mentionTarget.value && mentionCandidates.value.length
  ? `${mentionMenuId.value}-${mentionIndex.value}` : undefined);
let dismissedMention = '';
let composing = false;

function closeMention() {
  const wasOpen = !!mentionTarget.value;
  mentionTarget.value = undefined;
  mentionMenu.value?.hidePopover();
  if (wasOpen) view?.updateState(view.state);
}

function positionMentionMenu() {
  const target = mentionTarget.value;
  const menu = mentionMenu.value;
  if (!target || !menu) return;
  const below = window.innerHeight - target.bottom - 8;
  const above = target.top - 8;
  const height = Math.min(264, Math.max(above, below), window.innerHeight - 16);
  mentionMenuStyle.value = { maxHeight: `${Math.max(44, height)}px` };
  void nextTick(() => {
    if (mentionTarget.value !== target || !menu.isConnected) return;
    if (!menu.matches(':popover-open')) menu.showPopover();
    const rect = menu.getBoundingClientRect();
    mentionMenuStyle.value = {
      ...mentionMenuStyle.value,
      left: `${Math.max(8, Math.min(target.left, window.innerWidth - rect.width - 8))}px`,
      top: `${Math.max(8, Math.min(below >= rect.height ? target.bottom + 4 : target.top - rect.height - 4,
        window.innerHeight - rect.height - 8))}px`,
    };
  });
}

function showMention(target: NonNullable<typeof mentionTarget.value>) {
  const key = `${target.mode}:${target.from}:${target.to}:${target.query}`;
  if (dismissedMention === key) return;
  dismissedMention = '';
  const previous = mentionTarget.value;
  if (!previous || previous.query !== target.query || previous.from !== target.from) mentionIndex.value = 0;
  mentionTarget.value = target;
  positionMentionMenu();
  view?.updateState(view.state);
}

function updateRichMention() {
  if (!props.mentionOptions || !view || mode.value !== 'rich' || !editable.value || composing || view.composing) {
    closeMention();
    return;
  }
  const { selection } = view.state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.type === code_block
    || $from.marks().some(mark => mark.type === code || mark.type === link)) {
    closeMention();
    return;
  }
  const query = findMentionQuery($from.parent.textBetween(0, $from.parentOffset, '\n', '\uFFFC'), $from.parentOffset);
  if (!query) { closeMention(); dismissedMention = ''; return; }
  const from = $from.start() + query.from;
  const rect = view.coordsAtPos(from);
  showMention({ ...query, from, to: selection.from, mode: 'rich', left: rect.left, top: rect.top, bottom: rect.bottom });
}

function sourceCaretRect(input: HTMLTextAreaElement, offset: number) {
  const style = getComputedStyle(input);
  const mirror = document.createElement('div');
  for (const property of ['font', 'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-align',
    'tab-size', 'padding', 'direction']) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed', left: '0', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word', boxSizing: 'border-box', width: `${input.clientWidth}px`,
  });
  mirror.textContent = input.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '\u200B';
  mirror.append(marker);
  document.body.append(mirror);
  try {
    const rect = marker.getBoundingClientRect();
    const field = input.getBoundingClientRect();
    return {
      left: field.left + rect.left - input.scrollLeft,
      top: field.top + rect.top - input.scrollTop,
      bottom: field.top + rect.bottom - input.scrollTop,
    };
  } finally { mirror.remove(); }
}

function updateSourceMention() {
  const input = sourceInput.value;
  if (!props.mentionOptions || !input || !editable.value || composing || input.selectionStart !== input.selectionEnd) {
    closeMention();
    return;
  }
  const query = sourceMentionQuery(input.value, input.selectionStart);
  if (!query) { closeMention(); dismissedMention = ''; return; }
  showMention({ ...query, mode: 'source', ...sourceCaretRect(input, query.from) });
}

function selectMention(option: TaskAssignee) {
  const target = mentionTarget.value;
  if (!target || !editable.value || option.disabled) return;
  closeMention();
  if (target.mode === 'rich' && view) {
    const node = schema.nodes.mention!.create({ id: option.id, name: option.displayName });
    const tr = view.state.tr.replaceWith(target.from, target.to, [node, schema.text(' ')]);
    tr.setSelection(TextSelection.create(tr.doc, target.from + node.nodeSize + 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  } else if (target.mode === 'source' && sourceInput.value) {
    const input = sourceInput.value;
    input.setRangeText(`${mentionMarkdown(option.id, option.displayName)} `, target.from, target.to, 'end');
    const caret = input.selectionEnd;
    source.value = input.value;
    void nextTick(() => { input.focus(); input.setSelectionRange(caret, caret); });
  }
}

function mentionKeydown(event: KeyboardEvent) {
  if (!mentionTarget.value || event.isComposing || composing || event.ctrlKey || event.metaKey || event.altKey) return false;
  const count = mentionCandidates.value.length;
  if (event.key === 'Escape') {
    const target = mentionTarget.value;
    dismissedMention = `${target.mode}:${target.from}:${target.to}:${target.query}`;
    closeMention();
  } else if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    mentionIndex.value = (mentionIndex.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    void nextTick(() => document.getElementById(activeMentionId.value!)?.scrollIntoView({ block: 'nearest' }));
  } else if (count && (event.key === 'Enter' || event.key === 'Tab')) {
    selectMention(mentionCandidates.value[mentionIndex.value]!);
  } else return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function closeMentionOutside(event: Event) {
  if (event.target instanceof Node && mentionMenu.value?.contains(event.target)) return;
  closeMention();
}

watch(mentionCandidates, () => {
  mentionIndex.value = Math.min(mentionIndex.value, Math.max(0, mentionCandidates.value.length - 1));
  positionMentionMenu();
  view?.updateState(view.state);
});
watch(activeMentionId, () => view?.updateState(view.state));

function startComposition() {
  composing = true;
  closeMention();
}

function endComposition() {
  composing = false;
  void nextTick(() => mode.value === 'rich' ? updateRichMention() : updateSourceMention());
}

function focusEnd() {
  if (mode.value === 'rich' && view) {
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.focus();
  } else if (sourceInput.value) {
    const input = sourceInput.value;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}
defineExpose({ focusEnd });

function hideMentionAvatar(event: Event) {
  if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.hidden = true;
}

const paragraph = schema.nodes.paragraph!;
const heading = schema.nodes.heading!;
const blockquote = schema.nodes.blockquote!;
const bullet_list = schema.nodes.bullet_list!;
const ordered_list = schema.nodes.ordered_list!;
const list_item = schema.nodes.list_item!;
const code_block = schema.nodes.code_block!;
const hard_break = schema.nodes.hard_break!;
const strong = schema.marks.strong!;
const em = schema.marks.em!;
const code = schema.marks.code!;
const underline = schema.marks.underline!;
const strike = schema.marks.strike!;
const link = schema.marks.link!;
const activeMark = (mark: typeof strong, state: EditorState) => state.selection.empty
  ? !!mark.isInSet(state.storedMarks ?? state.selection.$from.marks())
  : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark);
const inside = (name: string, state: EditorState) => !!selectionAncestor(state, name);
const toggleBlock = (name: string, apply: Command, remove: Command): Command =>
  (state, dispatch, editor) => (inside(name, state) ? remove : apply)(state, dispatch, editor);
function selectionHasMention(state: EditorState) {
  let found = false;
  state.doc.nodesBetween(state.selection.from, state.selection.to, node => {
    if (node.type === schema.nodes.mention) found = true;
  });
  return found;
}
type FormatTool = { label: string; icon: string; command: Command; active?: (state: EditorState) => boolean }
  | { label: string; icon: string; command?: never; active?: never };
const tools: FormatTool[][] = [
  [
    { label: '粗体', icon: 'M6 4h7a4 4 0 0 1 0 8H6z M6 12h8a4 4 0 0 1 0 8H6z', command: toggleMark(strong), active: state => activeMark(strong, state) },
    { label: '斜体', icon: 'M11 4h8 M5 20h8 M15 4 9 20', command: toggleMark(em), active: state => activeMark(em, state) },
    { label: '下划线', icon: 'M6 4v7a6 6 0 0 0 12 0V4 M4 21h16', command: toggleMark(underline), active: state => activeMark(underline, state) },
    { label: '删除线', icon: 'M17 7c-1-2-3-3-5-3-3 0-5 1-5 4 0 1 1 3 4 4 M17 14c1 1 1 2 1 3 0 2-2 3-5 3-3 0-5-1-6-3 M3 12h18', command: toggleMark(strike), active: state => activeMark(strike, state) },
  ],
  [
    { label: '行内代码', icon: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 4l-4 16', command: (state, dispatch, editor) => !selectionHasMention(state) && toggleMark(code)(state, dispatch, editor), active: state => activeMark(code, state) },
    { label: '代码块', icon: 'M4 4h16v16H4z M9 9l-3 3 3 3 M15 9l3 3-3 3', command: toggleBlock('code_block', setMarkdownCodeBlock, setBlockType(paragraph)), active: state => inside('code_block', state) },
  ],
  [
    { label: '无序列表', icon: 'M9 5h12 M9 12h12 M9 19h12 M3 5h1 M3 12h1 M3 19h1', command: toggleBlock('bullet_list', wrapInList(bullet_list), liftListItem(list_item)), active: state => inside('bullet_list', state) },
    { label: '编号列表', icon: 'M9 5h12 M9 12h12 M9 19h12 M2 4l2-1v5 M2 8h4 M2 14a2 2 0 1 1 3 2l-3 3h4', command: toggleBlock('ordered_list', wrapInList(ordered_list), liftListItem(list_item)), active: state => inside('ordered_list', state) },
  ],
  [
    { label: '复选清单', icon: 'M3 5h7v7H3z M5 8l2 2 4-5 M14 8h7 M3 16h7v5H3z M14 18h7', command: toggleChecklist,
      active: state => { const depth = selectionAncestor(state, 'list_item'); return !!depth && state.selection.$from.node(depth).attrs.checked !== null; } },
    { label: '引用', icon: 'M10 6a6 6 0 0 0-5 6v5h5v-5H5 M21 6a6 6 0 0 0-5 6v5h5v-5h-5', command: toggleBlock('blockquote', wrapIn(blockquote), lift), active: state => inside('blockquote', state) },
  ],
  [
    { label: '插入表格', icon: 'M3 4h18v16H3z M3 9h18 M3 14h18 M12 4v16', command: insertMarkdownTable },
    { label: '插入或编辑链接', icon: 'M10 14l4-4 M8 16l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0 M16 8l1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0' },
  ],
];
const compactTools = [...tools[0]!, tools[4]![1]!, ...tools[2]!, ...tools[3]!, ...tools[1]!, tools[4]![0]!];
const inspectorTools = [tools[0]![0]!, tools[0]![1]!, ...tools[2]!, tools[4]![1]!,
  tools[0]![2]!, tools[0]![3]!, ...tools[3]!, ...tools[1]!, tools[4]![0]!];
const compactOrder = computed(() => props.inspectorToolbar ? inspectorTools : compactTools);
const toolbar = ref<HTMLElement>();
const blockSelect = ref<HTMLSelectElement>();
const moreFormats = ref<HTMLElement>();
const availableToolWidth = ref(0);
const compactToolSize = ref(44);
const visibleToolCount = computed(() => {
  const slots = Math.floor(availableToolWidth.value / compactToolSize.value);
  if (props.inspectorToolbar) return Math.min(5, Math.max(0, slots - 1));
  return !props.composer && slots >= compactTools.length ? compactTools.length : Math.max(0, slots - 1);
});
const toolbarGroups = computed(() => props.compactToolbar ? [compactOrder.value.slice(0, visibleToolCount.value)] : tools);
const overflowTools = computed(() => props.compactToolbar ? compactOrder.value.slice(visibleToolCount.value) : []);
const overflowId = computed(() => `${props.textareaId}-more-formats`);

watch([toolbar, blockSelect, () => props.compactToolbar], ([element, select, compact], _old, onCleanup) => {
  if (!compact || !element || !select) return;
  const measure = () => {
    const style = getComputedStyle(element);
    compactToolSize.value = parseFloat(style.getPropertyValue('--compact-tool-size')) || 44;
    availableToolWidth.value = element.getBoundingClientRect().width - select.getBoundingClientRect().width
      - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  observer.observe(select);
  measure();
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });

const inTable = computed(() => !!editorState.value && inside('table', editorState.value));
const canLink = computed(() => {
  const state = editorState.value;
  const selection = state?.selection;
  return !!state && !!selection && selection.$from.sameParent(selection.$to)
    && selection.$from.parent.type.allowsMarkType(link) && !selectionHasMention(state);
});
const blockLevel = computed(() => {
  const selection = editorState.value?.selection;
  return selection?.$from.parent.type === heading ? Number(selection.$from.parent.attrs.level) : 0;
});

function changeBlock(event: Event) {
  const select = event.target as HTMLSelectElement;
  const level = Number(select.value);
  run(level ? setBlockType(heading, { level }) : setBlockType(paragraph));
  select.value = String(blockLevel.value);
}

function run(command: Command) {
  if (!view || !editable.value) return;
  command(view.state, view.dispatch, view);
  view.focus();
}

function canUse(tool: FormatTool) {
  const state = editorState.value;
  return editable.value && !!state && (tool.command ? tool.command(state) : canLink.value);
}

function dismissMoreFormats(event: KeyboardEvent) {
  if (!moreFormats.value?.matches(':popover-open')) return;
  event.preventDefault();
  event.stopPropagation();
  moreFormats.value.hidePopover();
  toolbar.value?.querySelector<HTMLButtonElement>('.markdown-more-trigger')?.focus();
}

function useTool(tool: FormatTool) {
  moreFormats.value?.hidePopover();
  if (tool.command) run(tool.command);
  else openLink();
}

function openLink() {
  if (!view || !editable.value || !canLink.value) return;
  if (linkPanel.value) { closeLink(); return; }
  const { state } = view;
  const { $from, $to } = state.selection;
  let { from, to } = state.selection;
  const mark = link.isInSet($from.marks()) ?? link.isInSet($from.nodeAfter?.marks ?? []);
  let existing = false;
  if (mark) {
    let start = -1;
    $from.parent.forEach((node, offset) => {
      const pos = $from.start() + offset;
      if (!mark.isInSet(node.marks)) { start = -1; return; }
      if (start === -1) start = pos;
      if (start <= from && to <= pos + node.nodeSize) {
        from = start;
        to = pos + node.nodeSize;
        existing = true;
      }
    });
  }
  linkPanel.value = { from, to, text: state.doc.textBetween(from, to, ' '), url: existing ? mark?.attrs.href : '', existing };
  linkError.value = '';
  void nextTick(() => (linkPanel.value?.text ? linkUrlInput.value : linkTextInput.value)?.focus());
}

function closeLink(focus = true) {
  linkPanel.value = undefined;
  linkError.value = '';
  if (focus) view?.focus();
}

function applyLink(remove = false) {
  const panel = linkPanel.value;
  if (!view || !panel || !editable.value) return;
  const url = remove ? null : normalizeEditorLink(panel.url);
  const text = panel.text.trim() ? panel.text : panel.url.trim();
  if (!remove && (!url || !text)) {
    linkError.value = '请输入有效的链接地址。';
    linkUrlInput.value?.focus();
    return;
  }
  const { from, to } = panel;
  const { state } = view;
  const tr = state.tr.removeMark(from, to, link);
  if (url) {
    const mark = link.create({ href: url, title: panel.existing ? link.isInSet(state.doc.resolve(from).nodeAfter?.marks ?? [])?.attrs.title : null });
    if (from !== to && text === state.doc.textBetween(from, to)) tr.addMark(from, to, mark);
    else tr.replaceWith(from, to, schema.text(text, [mark]));
  }
  view.dispatch(tr.scrollIntoView());
  closeLink();
}

function destroyEditor() {
  closeMention();
  closeLink(false);
  view?.destroy();
  view = undefined;
  editorState.value = undefined;
}

function mountEditor() {
  destroyEditor();
  if (!richHost.value) return;
  const original = activeText.value;
  const baseline = readRichMarkdown(original);
  if (!baseline) {
    unsupported.value = true;
    mode.value = 'source';
    return;
  }
  const state = EditorState.create({
    doc: baseline,
    plugins: [
      history(),
      keymap({
        'Mod-b': toggleMark(strong), 'Mod-i': toggleMark(em), 'Mod-u': toggleMark(underline),
        'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
        Tab: moveMarkdownCell(1), 'Shift-Tab': moveMarkdownCell(-1),
        Enter: chainCommands(moveMarkdownCell(1), (state, dispatch) => {
          const depth = selectionAncestor(state, 'list_item');
          const checked = depth ? state.selection.$from.node(depth).attrs.checked : null;
          return splitListItem(list_item, { checked: checked === null ? null : false })(state, dispatch);
        }, baseKeymap.Enter!),
        'Shift-Enter': (state, dispatch) => {
          if (inside('table', state)) return moveMarkdownCell(1)(state, dispatch);
          if (!state.selection.$from.parent.type.contentMatch.matchType(hard_break)) return false;
          if (dispatch) dispatch(state.tr.replaceSelectionWith(hard_break.create()).scrollIntoView());
          return true;
        },
      }),
      keymap(baseKeymap),
    ],
  });
  const editor = new EditorView(richHost.value, {
    state,
    editable: () => editable.value,
    attributes: state => ({
      id: `${props.textareaId}-rich`,
      class: 'markdown-content markdown-rich-input',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': props.label,
      'aria-readonly': String(!editable.value),
      tabindex: props.disabled ? '-1' : '0',
      'data-empty': String(state.doc.childCount === 1 && state.doc.firstChild?.type === paragraph && !state.doc.firstChild.content.size),
      'data-placeholder': props.placeholder || `填写${props.label}…`,
      ...(props.mentionOptions ? {
        'aria-autocomplete': 'list',
        'aria-haspopup': 'listbox',
        ...(mentionTarget.value ? { 'aria-controls': mentionMenuId.value, 'aria-activedescendant': activeMentionId.value ?? '' } : {}),
      } : {}),
    }),
    nodeViews: {
      list_item(node, editor, getPos) {
        const dom = document.createElement('li');
        const contentDOM = document.createElement('div');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'markdown-task-check';
        input.contentEditable = 'false';
        input.setAttribute('aria-label', '完成此清单项');
        const update = (item: typeof node) => {
          dom.classList.toggle('markdown-task-item', item.attrs.checked !== null);
          input.hidden = item.attrs.checked === null;
          input.disabled = !editable.value;
          input.checked = !!item.attrs.checked;
        };
        dom.append(input, contentDOM);
        update(node);
        input.addEventListener('change', () => {
          const pos = getPos();
          const item = typeof pos === 'number' ? editor.state.doc.nodeAt(pos) : null;
          if (!editable.value || !item || typeof pos !== 'number') return;
          editor.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: input.checked }));
        });
        return {
          dom, contentDOM,
          update(item) { if (item.type !== list_item) return false; update(item); return true; },
          stopEvent: event => event.target === input,
          ignoreMutation: mutation => mutation.target === input || mutation.target === dom,
        };
      },
    },
    handleDOMEvents: {
      click(_editor, event) {
        if (!(event.target instanceof Element) || !event.target.closest('a')) return false;
        event.preventDefault();
        return true;
      },
      paste(editor, event) {
        event.preventDefault();
        pasteError.value = '';
        try {
          const text = event.clipboardData?.getData('text/plain');
          const html = event.clipboardData?.getData('text/html');
          const sanitized = (html || text) && !inside('table', editor.state) && !inside('code_block', editor.state)
            ? clipboardContent(html ?? '', text ?? '', document).html : '';
          if (editable.value && sanitized) {
            editor.pasteHTML(sanitized);
          } else if (editable.value && text) {
            if (inside('table', editor.state)) editor.dispatch(editor.state.tr.insertText(text.replace(/[\r\n]+/g, ' ')));
            else editor.pasteText(text);
          }
        } catch (cause) {
          pasteError.value = `粘贴失败，请检查内容后重试或以纯文本粘贴。${cause instanceof Error ? cause.message : String(cause)}`;
        }
        return true;
      },
    },
    handleDrop: () => true,
    dispatchTransaction(transaction) {
      const next = editor.state.apply(transaction);
      editor.updateState(next);
      editorState.value = next;
      if (transaction.docChanged) {
        if (linkPanel.value) closeLink(false);
        source.value = next.doc.eq(baseline) ? original : richMarkdownSerializer.serialize(next.doc);
      }
      updateRichMention();
    },
  });
  view = editor;
  editorState.value = state;
}

function pasteSource(event: ClipboardEvent) {
  const html = event.clipboardData?.getData('text/html');
  const input = sourceInput.value;
  if (!html || !input || !editable.value) return;
  event.preventDefault();
  pasteError.value = '';
  try {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const markdown = clipboardContent(html, text, document).markdown || text;
    if (!markdown) return;
    if (!document.execCommand('insertText', false, markdown))
      input.setRangeText(markdown, input.selectionStart, input.selectionEnd, 'end');
    source.value = input.value;
    updateSourceMention();
  } catch (cause) {
    pasteError.value = `粘贴失败，请检查内容后重试或以纯文本粘贴。${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

function switchMode(event: Event) {
  closeMention();
  const select = event.target as HTMLSelectElement;
  const next = select.value;
  if (next !== 'rich' && next !== 'source' && next !== 'preview') return;
  if (next === 'rich' && !readRichMarkdown(activeText.value)) {
    unsupported.value = true;
    mode.value = 'source';
    select.value = 'source';
    return;
  }
  unsupported.value = false;
  mode.value = next;
}

watch(richHost, mountEditor, { flush: 'post' });
watch(() => props.modelValue, value => {
  if (value === activeText.value) return;
  activeText.value = value;
  unsupported.value = false;
  if (view) mountEditor();
});
watch([editable, () => props.disabled], () => {
  if (!editable.value) {
    closeMention();
    closeLink(false);
    moreFormats.value?.hidePopover();
  }
  view?.updateState(view.state);
  view?.dom.querySelectorAll<HTMLInputElement>('.markdown-task-check').forEach(input => { input.disabled = !editable.value; });
});
onMounted(() => {
  if (!props.mentionOptions) return;
  window.addEventListener('pointerdown', closeMentionOutside, true);
  window.addEventListener('scroll', closeMentionOutside, true);
  window.addEventListener('resize', closeMentionOutside);
});
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', closeMentionOutside, true);
  window.removeEventListener('scroll', closeMentionOutside, true);
  window.removeEventListener('resize', closeMentionOutside);
  destroyEditor();
});
</script>

<template>
  <div class="markdown-editor" :class="{ 'is-expanded': expanded, 'is-composer': composer }" @change.stop
    @keydown.capture="mentionKeydown" @focusout="closeMention"
    @compositionstart.capture="startComposition" @compositionend="endComposition">
    <div v-if="!composer" class="markdown-editor-header">
      <label v-if="mode === 'source'" class="markdown-editor-label" :for="textareaId">{{ label }}</label>
      <span v-else class="markdown-editor-label">{{ label }}</span>
      <div class="markdown-editor-actions">
        <select class="markdown-editor-select" :aria-label="`${label}编辑方式`" :value="mode" :disabled="disabled" @change="switchMode">
          <option value="rich">富文本模式</option>
          <option value="source">Markdown 源码</option>
          <option value="preview">预览</option>
        </select>
        <button type="button" class="markdown-editor-icon" :aria-label="expanded ? '收起编辑区' : '扩大编辑区'"
          :title="expanded ? '收起编辑区' : '扩大编辑区'" :aria-expanded="expanded" :aria-controls="`${textareaId}-body`"
          @click="expanded = !expanded"><AppIcon :name="expanded ? 'collapse' : 'fit'" /></button>
      </div>
    </div>
    <div class="markdown-editor-surface">
      <div v-if="(mode === 'rich' || composer) && !readonly" ref="toolbar" class="markdown-editor-toolbar"
        :class="{ 'is-compact': compactToolbar }"
        role="group" aria-label="文本格式" @keydown.esc="dismissMoreFormats">
        <select ref="blockSelect" class="markdown-editor-select markdown-block-select" aria-label="段落样式" :value="blockLevel"
          :disabled="!editable || !editorState" @change="changeBlock">
          <option :value="0">正文</option>
          <option v-for="level in 6" :key="level" :value="level">标题 {{ level }}</option>
        </select>
        <div v-for="group in toolbarGroups" :key="group[0]?.label" class="markdown-format-group">
          <button v-for="tool in group" :key="tool.label" type="button" class="markdown-editor-icon"
            :aria-label="tool.label" :title="tool.label" :aria-pressed="editorState ? tool.active?.(editorState) : undefined"
            :aria-expanded="tool.command ? undefined : !!linkPanel"
            :aria-controls="!tool.command && linkPanel ? `${textareaId}-link-panel` : undefined"
            :disabled="!canUse(tool)" @mousedown.prevent @click="useTool(tool)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path :d="tool.icon" />
            </svg>
          </button>
        </div>
        <template v-if="overflowTools.length || composer">
          <button type="button" class="markdown-editor-icon markdown-more-trigger" title="更多格式" aria-label="更多格式"
            :popovertarget="overflowId" :disabled="!editable" @mousedown.prevent>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          <div :id="overflowId" ref="moreFormats" class="markdown-more-formats" popover="auto" role="group" aria-label="更多格式">
            <label v-if="composer">编辑方式
              <select class="markdown-editor-select" :aria-label="`${label}编辑方式`" :value="mode" :disabled="disabled" @change="switchMode">
                <option value="rich">富文本模式</option><option value="source">Markdown 源码</option><option value="preview">预览</option>
              </select>
            </label>
            <button v-for="tool in overflowTools" :key="tool.label" type="button" class="markdown-more-option"
              :aria-pressed="editorState ? tool.active?.(editorState) : undefined" :disabled="!canUse(tool)"
              @mousedown.prevent @click="useTool(tool)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="tool.icon" />
              </svg>
              {{ tool.label }}
            </button>
          </div>
        </template>

      </div>
      <div v-if="linkPanel" :id="`${textareaId}-link-panel`" class="markdown-link-panel" role="group" aria-label="编辑链接"
        @keydown.esc.stop.prevent="closeLink()">
        <label>文本<input ref="linkTextInput" v-model="linkPanel.text" placeholder="显示文本" @keydown.enter.stop.prevent="applyLink()" /></label>
        <label>链接<input ref="linkUrlInput" v-model="linkPanel.url" placeholder="https://…" inputmode="url"
          :aria-invalid="!!linkError" :aria-describedby="linkError ? `${textareaId}-link-error` : undefined"
          @input="linkError = ''" @keydown.enter.stop.prevent="applyLink()" /></label>
        <p v-if="linkError" :id="`${textareaId}-link-error`" class="markdown-link-error" role="alert">{{ linkError }}</p>
        <div class="markdown-inline-actions">
          <button v-if="linkPanel.existing" type="button" class="secondary" @click="applyLink(true)">移除链接</button>
          <button type="button" class="secondary" @click="closeLink()">取消</button>
          <button type="button" @click="applyLink()">应用</button>
        </div>
      </div>
      <div :id="`${textareaId}-body`" class="markdown-editor-body" :style="{ '--markdown-rows': rows }">
        <div v-if="mode === 'rich'" ref="richHost"></div>
        <textarea v-else-if="mode === 'source'" :id="textareaId" ref="sourceInput" v-model="source"
          :aria-label="label" :aria-describedby="helpId" :disabled="disabled" :readonly="readonly"
          :rows="rows" :placeholder="placeholder || '输入 Markdown 源码'"
          :aria-autocomplete="mentionOptions ? 'list' : undefined"
          :aria-haspopup="mentionOptions ? 'listbox' : undefined"
          :aria-controls="mentionTarget ? mentionMenuId : undefined" :aria-activedescendant="activeMentionId"
          @paste="pasteSource" @input="updateSourceMention" @keyup="updateSourceMention" @click="updateSourceMention" @select="updateSourceMention"></textarea>
        <div v-else class="markdown-content markdown-editor-preview" role="region" :aria-label="`${label}预览`">
          <div v-if="source.trim()" v-html="renderMarkdown(source)"></div>
          <p v-else class="markdown-empty">暂无内容。</p>
        </div>
        <div v-if="inTable && editable && !linkPanel" class="markdown-inline-actions markdown-table-actions" aria-label="表格操作" role="group">
          <button type="button" class="secondary" @mousedown.prevent @click="run(addMarkdownTableRow)">添加行</button>
          <button type="button" class="secondary" @mousedown.prevent @click="run(addMarkdownTableColumn)">添加列</button>
          <button type="button" class="secondary" @mousedown.prevent @click="run(removeMarkdownTable)">删除表格</button>
        </div>
      </div>
    </div>
    <div v-if="composer" class="markdown-composer-count">{{ characterCount }} 字</div>
    <div v-if="$slots.actions" class="markdown-inline-actions markdown-save-actions">
      <slot name="actions" />
    </div>
    <p v-if="unsupported" class="form-help markdown-editor-help" role="status">此内容包含富文本模式不能无损编辑的格式，请使用 Markdown 源码编辑。原文已保留。</p>
    <p v-if="pasteError" class="form-help markdown-editor-help" role="alert">{{ pasteError }}</p>
    <p :id="helpId" class="form-help markdown-editor-help" :hidden="mode !== 'source'">原始 HTML 不执行，图片不加载。</p>
    <div v-if="mentionOptions" ref="mentionMenu" class="markdown-mention-menu" popover="manual" :style="mentionMenuStyle">
      <div class="markdown-mention-heading">项目成员</div>
      <div :id="mentionMenuId" class="markdown-mention-options" role="listbox" aria-label="选择提及成员">
        <button v-for="(option, index) in mentionCandidates" :id="`${mentionMenuId}-${index}`" :key="option.id"
          type="button" class="markdown-mention-option" role="option" tabindex="-1" :aria-selected="mentionIndex === index"
          @mousedown.prevent @pointermove="mentionIndex = index" @click="selectMention(option)">
          <span class="markdown-mention-avatar" aria-hidden="true"
            :style="{ background: accountAvatarTheme(option.id).background, color: accountAvatarTheme(option.id).foreground }">
            {{ accountInitials(option.displayName) }}
            <img v-if="option.avatar" :src="option.avatar" alt="" @error="hideMentionAvatar">
          </span>
          <span class="markdown-mention-name">{{ option.displayName }} <span>（{{ option.username }}）</span></span>
        </button>
        <p v-if="!mentionCandidates.length" class="markdown-mention-empty" role="status">没有匹配的成员</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.markdown-editor.is-composer { display: grid; grid-template-columns: minmax(44px, 1fr) auto; gap: 0 4px; }
.is-composer .markdown-editor-surface { display: contents; }
.is-composer .markdown-editor-body { grid-column: 1 / -1; grid-row: 1; position: relative; }
.is-composer .markdown-editor-toolbar { grid-column: 1; grid-row: 3; min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; }
.is-composer .markdown-block-select { display: none; }
.is-composer .markdown-save-actions { grid-column: 2; grid-row: 3; display: flex; flex-wrap: nowrap; gap: 2px; margin: 0; }
.markdown-composer-count { grid-column: 1 / -1; grid-row: 2; color: #afbdd2; font-size: 11px; text-align: right; padding: 4px 0; }
.is-composer .markdown-link-panel { grid-column: 1 / -1; grid-row: 4; }
.is-composer .markdown-editor-help { grid-column: 1 / -1; }
.is-composer .markdown-editor-body :deep(.markdown-rich-input) { min-height: 112px; max-height: 220px; background: transparent; }
.is-composer .markdown-editor-body textarea { min-height: 112px; max-height: 220px; border: 0; background: transparent; }
.is-composer .markdown-more-formats label { display: grid; gap: 4px; padding: 8px; }
.is-composer .markdown-editor-icon.markdown-more-trigger { margin-inline-start: 0; }
.markdown-mention-menu { position: fixed; inset: auto; margin: 0; width: min(280px, calc(100vw - 16px)); padding: 4px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-raised); color: var(--ink); box-shadow: 0 8px 26px #02061799; overflow: hidden; }
.markdown-mention-menu:popover-open { display: flex; flex-direction: column; }
.markdown-mention-heading { flex: 0 0 auto; padding: 8px 12px; color: #afbdd2; font-size: 12px; }
.markdown-mention-options { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.markdown-editor .markdown-mention-option { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; margin: 0; padding: 6px 12px; border: 0; border-radius: 3px; background: transparent; color: var(--ink); box-shadow: none; text-align: left; font-size: 13px; font-weight: 400; }
.markdown-editor .markdown-mention-option[aria-selected="true"] { background: #263d5a; }
.markdown-mention-avatar { position: relative; display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; overflow: hidden; border-radius: 50%; font-size: 10px; }
.markdown-mention-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.markdown-mention-name { min-width: 0; overflow-wrap: anywhere; }
.markdown-mention-name span { color: #afbdd2; font-size: 12px; }
.markdown-mention-empty { margin: 0; padding: 12px; color: #afbdd2; font-size: 12px; }
@media (hover: hover) and (pointer: fine) {
  .is-composer .markdown-editor-toolbar { --compact-tool-size: 28px; }
  .is-composer .markdown-editor-toolbar .markdown-editor-icon { min-width: 28px; min-height: 28px; height: 28px; }
}
</style>
