import { describe, expect, it } from 'vitest';
import { taskStatusPresentation } from '../src/utils/task-status-presentation';

describe('任务状态图标映射', () => {
  it.each([
    ['Backlog', 'status-not-started'],
    ['Pending', 'status-pending'],
    ['In Progress', 'status-in-progress'],
    ['release pending', 'status-release-pending'],
    ['Done', 'status-done'],
    ['未分组', 'status-not-started'],
  ])('为 %s 选择语义图标', (statusName, icon) => {
    expect(taskStatusPresentation(statusName).icon).toBe(icon);
  });

  it('为用户自定义状态提供中性图标', () => {
    expect(taskStatusPresentation('QA Review').icon).toBe('status-default');
  });
});
