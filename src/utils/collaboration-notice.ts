interface CollaborationNoticeState {
  restoring: boolean;
  connected: boolean;
  authenticated: boolean;
  source: string;
  message: string;
  conflictMessage: string;
  pending: boolean;
  draftCount: number;
}

const routineMessages = new Set([
  '共享数据已更新到本机副本。',
  '当前项目已同步最新共享数据。',
  '共享提交及本机副本更新已完成。',
]);

export function getCollaborationNotice(state: CollaborationNoticeState, blocked: string, refreshError: string) {
  if (state.restoring) return null;
  const message = state.message && !routineMessages.has(state.message) ? state.message : '';
  if (!message && !refreshError && !state.conflictMessage && !blocked && !state.pending && !state.draftCount) return null;
  return {
    title: state.pending ? '共享提交待确认' : !state.connected ? (state.source ? '本机缓存视图 · 未连接后端' : '历史单人数据 · 只读')
      : !state.authenticated ? '后端可达 · 需要登录或重新验证' : '协作状态提醒',
    message, refreshError, conflict: state.conflictMessage, blocked,
    pending: state.pending, draftCount: state.draftCount,
  };
}
