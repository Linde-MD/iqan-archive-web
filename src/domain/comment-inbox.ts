import { requireCondition } from './model';

export interface InboxSummary {
  revision: number;
  unreadCount: number;
}

export interface CommentNotification {
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  commentId: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  reply: boolean;
  mention: boolean;
  read: boolean;
}

function inboxRecord(value: unknown): Record<string, unknown> {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'INBOX_RESPONSE', '消息数据格式无效。');
  return Object.fromEntries(Object.entries(value));
}

export function parseInboxSummary(value: unknown): InboxSummary {
  const row = inboxRecord(value);
  requireCondition(typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0
    && typeof row.unreadCount === 'number' && Number.isSafeInteger(row.unreadCount) && row.unreadCount >= 0,
  'INBOX_RESPONSE', '消息摘要格式无效。');
  return { revision: row.revision, unreadCount: row.unreadCount };
}

export function parseInboxList(value: unknown): InboxSummary & { items: CommentNotification[] } {
  const row = inboxRecord(value);
  const summary = parseInboxSummary(row);
  requireCondition(Array.isArray(row.items), 'INBOX_RESPONSE', '消息列表格式无效。');
  const ids = new Set<string>();
  const items = row.items.map(value => {
    const item = inboxRecord(value);
    const text = (key: string) => {
      const field = item[key];
      requireCondition(typeof field === 'string' && !!field.trim(), 'INBOX_RESPONSE', '消息文本或身份无效。');
      return field;
    };
    const id = text('id');
    const createdAt = text('createdAt');
    requireCondition(!ids.has(id) && Number.isFinite(Date.parse(createdAt))
      && new Date(createdAt).toISOString() === createdAt, 'INBOX_RESPONSE', '消息身份重复或时间无效。');
    ids.add(id);
    requireCondition(typeof item.reply === 'boolean' && typeof item.mention === 'boolean' && typeof item.read === 'boolean'
      && (item.reply || item.mention), 'INBOX_RESPONSE', '消息类型或已读状态无效。');
    return {
      id, projectId: text('projectId'), projectName: text('projectName'), taskId: text('taskId'),
      taskName: text('taskName'), commentId: text('commentId'), actorId: text('actorId'), actorName: text('actorName'),
      createdAt, reply: item.reply, mention: item.mention, read: item.read,
    };
  });
  return { ...summary, items };
}
