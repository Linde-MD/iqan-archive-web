import { Fragment } from 'prosemirror-model';
import { setBlockType } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { Selection, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { richMarkdownSchema as schema } from './rich-markdown';

const { bullet_list, list_item, table, table_head, table_body, table_row, table_header, table_cell, paragraph } = schema.nodes;

export function selectionAncestor(state: EditorState, name: string) {
  const { $from, $to } = state.selection;
  for (let depth = $from.sharedDepth($to.pos); depth > 0; depth--) {
    if ($from.node(depth).type.name === name) return depth;
  }
  return 0;
}

export const setMarkdownCodeBlock: Command = (state, dispatch) => {
  const codeBlock = schema.nodes.code_block!;
  if (!setBlockType(codeBlock)(state)) return false;
  if (dispatch) {
    const tr = state.tr;
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos, parent, index) => {
      if (!node.isTextblock) return;
      if (node.type !== codeBlock && parent?.canReplaceWith(index, index + 1, codeBlock)) {
        node.forEach((child, offset) => {
          if (child.type !== schema.nodes.mention) return;
          const from = tr.mapping.map(pos + 1 + offset);
          tr.replaceWith(from, from + child.nodeSize, schema.text(`@${child.attrs.name}`));
        });
      }
      return false;
    });
    dispatch(tr.setBlockType(tr.selection.from, tr.selection.to, codeBlock).scrollIntoView());
  }
  return true;
};

export const toggleChecklist: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const depth = selectionAncestor(state, 'list_item');
  if (depth && $from.node(depth - 1).type === bullet_list) {
    const item = $from.node(depth);
    dispatch?.(state.tr.setNodeMarkup($from.before(depth), undefined, {
      ...item.attrs, checked: item.attrs.checked === null ? false : null,
    }));
    return true;
  }
  const wrap = wrapInList(bullet_list!);
  if (!dispatch) return wrap(state);
  return wrap(state, tr => {
    const from = tr.selection.$from;
    for (let current = from.depth; current > 0; current--) {
      if (from.node(current).type !== list_item) continue;
      const start = tr.selection.from;
      const end = tr.selection.to;
      tr.doc.nodesBetween(start, end, (node, pos, parent) => {
        if (node.type === list_item && parent?.type === bullet_list) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
        }
      });
      break;
    }
    dispatch(tr);
  });
};

function makeRow(header: boolean, columns: number, alignments: (string | null)[] = []) {
  return table_row!.create(null, Array.from({ length: columns }, (_, index) =>
    (header ? table_header! : table_cell!).create({ align: alignments[index] ?? null })));
}

export const insertMarkdownTable: Command = (state, dispatch) => {
  if (selectionAncestor(state, 'table') || state.selection.$from.parent.type.spec.code) return false;
  const insert = table!.create(null, [table_head!.create(null, makeRow(true, 2)), table_body!.create(null, makeRow(false, 2))]);
  // Insert after the current top-level block to keep its text intact.
  const pos = state.selection.$to.depth ? state.selection.$to.after(1) : state.selection.to;
  if (dispatch) {
    const tr = state.tr.insert(pos, Fragment.fromArray([insert, ...(pos === state.doc.content.size ? [paragraph!.create()] : [])]));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 4)).scrollIntoView());
  }
  return true;
};

export const addMarkdownTableRow: Command = (state, dispatch) => {
  const depth = selectionAncestor(state, 'table');
  if (!depth) return false;
  const { $from } = state.selection;
  const node = $from.node(depth);
  const header = node.firstChild!.firstChild!;
  const alignments: (string | null)[] = [];
  header.forEach(cell => alignments.push(cell.attrs.align));
  const row = makeRow(false, header.childCount, alignments);
  if (dispatch) {
    const hasBody = node.childCount > 1;
    const pos = $from.end(depth) - (hasBody ? 1 : 0);
    const tr = state.tr.insert(pos, hasBody ? row : table_body!.create(null, row));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + (hasBody ? 2 : 3))).scrollIntoView());
  }
  return true;
};

export const addMarkdownTableColumn: Command = (state, dispatch) => {
  const depth = selectionAncestor(state, 'table');
  if (!depth) return false;
  const { $from } = state.selection;
  if (dispatch) {
    const tr = state.tr;
    state.doc.nodesBetween($from.start(depth), $from.end(depth), (node, pos) => {
      if (node.type !== table_row) return;
      const cell = node.firstChild?.type === table_header ? table_header! : table_cell!;
      tr.insert(tr.mapping.map(pos + node.nodeSize - 1), cell.create());
      return false;
    });
    dispatch(tr);
  }
  return true;
};

export const removeMarkdownTable: Command = (state, dispatch) => {
  const depth = selectionAncestor(state, 'table');
  if (!depth) return false;
  const { $from } = state.selection;
  if (dispatch) dispatch(state.tr.delete($from.before(depth), $from.after(depth)).scrollIntoView());
  return true;
};

export function moveMarkdownCell(direction: 1 | -1): Command {
  return (state, dispatch) => {
    const depth = selectionAncestor(state, 'table');
    const cell = selectionAncestor(state, 'table_cell') || selectionAncestor(state, 'table_header');
    if (!depth || !cell) return false;
    const { $from } = state.selection;
    const pos = direction === 1 ? $from.after(cell) : $from.before(cell);
    const next = Selection.findFrom(state.doc.resolve(pos), direction, true);
    if (!next) return false;
    dispatch?.(state.tr.setSelection(next).scrollIntoView());
    return true;
  };
}
