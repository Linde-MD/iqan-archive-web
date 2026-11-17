export type TaskStatusIconName =
  | 'status-not-started'
  | 'status-pending'
  | 'status-in-progress'
  | 'status-release-pending'
  | 'status-done'
  | 'status-default';

export interface TaskStatusPresentation {
  icon: TaskStatusIconName;
  color: string;
}

export function taskStatusPresentation(statusName: string | null | undefined): TaskStatusPresentation {
  const name = (statusName ?? '').trim().toLocaleLowerCase().replace(/[\s_-]+/g, ' ');
  if (/(release.*pending|pending.*release|发布.*待|待.*发布)/.test(name)) {
    return { icon: 'status-release-pending', color: '#93c5fd' };
  }
  if (/\b(done|complete(?:d)?|closed|finished)\b|已完成|完成|结束/.test(name)) {
    return { icon: 'status-done', color: '#6ee7b7' };
  }
  if (/\b(in progress|doing|ongoing)\b|进行中/.test(name)) {
    return { icon: 'status-in-progress', color: '#fcd34d' };
  }
  if (/\b(pending|waiting)\b|待处理|待办/.test(name)) {
    return { icon: 'status-pending', color: '#60a5fa' };
  }
  if (/\b(backlog|not started|unstarted)\b|未开始|未分组/.test(name)) {
    return { icon: 'status-not-started', color: '#fca5a5' };
  }
  return { icon: 'status-default', color: '#afbdd2' };
}
