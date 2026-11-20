import { describe, expect, it } from 'vitest';
import { getCollaborationNotice } from '../src/utils/collaboration-notice';

const connected = {
  restoring: false, connected: true, authenticated: true, source: 'source', message: '',
  conflictMessage: '', pending: false, draftCount: 0,
};

describe('协作状态悬浮提示', () => {
  it('恢复期间和普通同步成功不显示提示', () => {
    expect(getCollaborationNotice({ ...connected, restoring: true }, '正在恢复', '')).toBeNull();
    for (const message of ['共享数据已更新到本机副本。', '当前项目已同步最新共享数据。', '共享提交及本机副本更新已完成。']) {
      expect(getCollaborationNotice({ ...connected, message }, '', '')).toBeNull();
    }
  });

  it('断线、登录失效及写入限制仍提供原因', () => {
    const offline = getCollaborationNotice({ ...connected, connected: false, message: '连接失败' }, '仅可读取副本', '');
    expect(offline).toMatchObject({ title: '本机缓存视图 · 未连接后端', message: '连接失败', blocked: '仅可读取副本' });
    expect(getCollaborationNotice({ ...connected, authenticated: false }, '请重新登录', '')?.title)
      .toBe('后端可达 · 需要登录或重新验证');
  });

  it('未确认提交、草稿冲突及刷新失败不会被普通成功信息掩盖', () => {
    expect(getCollaborationNotice({
      ...connected, pending: true, draftCount: 2, conflictMessage: '草稿冲突', message: '共享数据已更新到本机副本。',
    }, '写入暂停', '网络错误')).toMatchObject({
      title: '共享提交待确认', message: '', pending: true, draftCount: 2,
      conflict: '草稿冲突', blocked: '写入暂停', refreshError: '网络错误',
    });
    expect(getCollaborationNotice(connected, '', '网络错误')?.refreshError).toBe('网络错误');
  });
});
