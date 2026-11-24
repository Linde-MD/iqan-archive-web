import { expect, it } from 'vitest';
import { parseInboxList, parseInboxSummary } from '../src/domain/comment-inbox';

const notice = {
  id: 'notice', projectId: 'project', projectName: '工程', taskId: 'task', taskName: '任务',
  commentId: 'comment', actorId: 'account', actorName: '成员', createdAt: '2026-11-23T00:00:00.000Z',
  reply: true, mention: true, read: false,
};

it('消息解码保留回复/@及已读状态，拒绝损坏列表与摘要', () => {
  expect(parseInboxList({ revision: 1, unreadCount: 1, items: [notice] }).items).toEqual([notice]);
  for (const invalid of [
    { ...notice, createdAt: '无效日期' }, { ...notice, commentId: '' },
    { ...notice, read: 'false' }, { ...notice, reply: false, mention: false },
    { ...notice, actorName: null },
  ]) expect(() => parseInboxList({ revision: 1, unreadCount: 1, items: [invalid] })).toThrow();
  expect(() => parseInboxList({ revision: 1, unreadCount: 1, items: [notice, notice] })).toThrow('身份重复');
  expect(() => parseInboxList({ revision: 1, unreadCount: 1, items: {} })).toThrow();
  for (const invalid of [{ revision: -1, unreadCount: 0 }, { revision: 0, unreadCount: 0.5 }, []]) {
    expect(() => parseInboxSummary(invalid)).toThrow();
  }
});
