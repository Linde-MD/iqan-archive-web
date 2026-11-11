import { describe, expect, it } from 'vitest';
import { parseWorkspaceLocation, projectOverlayPath, projectPath } from '../src/workspace-routes';

describe('工作区路由', () => {
  it('编码项目和子页面段，并可还原任务详情路由', () => {
    const path = projectPath('project/one', 'tasks', 'detail', 'task one');

    expect(path).toBe('/projects/project%2Fone/tasks/detail/task%20one');
    expect(parseWorkspaceLocation(path)).toEqual({
      projectId: 'project/one',
      view: 'tasks',
      child: ['detail', 'task one'],
      overlay: null,
    });
  });

  it('解析项目编辑与删除覆盖层', () => {
    const editPath = projectOverlayPath('project-1', 'graph', 'edit');
    const deletePath = projectOverlayPath('project-1', 'graph', 'delete');

    expect(parseWorkspaceLocation(editPath)).toEqual({
      projectId: 'project-1', view: 'graph', child: [], overlay: 'edit',
    });
    expect(parseWorkspaceLocation(deletePath)).toEqual({
      projectId: 'project-1', view: 'graph', child: [], overlay: 'delete',
    });
  });

  it('对未知视图或格式错误的路径回退到工作区首页', () => {
    expect(parseWorkspaceLocation('/projects/project-1/unknown')).toEqual({
      projectId: '', view: 'files', child: [], overlay: null,
    });
    expect(parseWorkspaceLocation('/projects/%E0%A4%A/tasks')).toEqual({
      projectId: '', view: 'files', child: [], overlay: null,
    });
  });
});