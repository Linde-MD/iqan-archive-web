import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { deleteTask as removeTask, updateTaskOptions, validateGraph } from '../src/domain/graph';
import { matchesTaskIdSearch, moveTaskInBoard, parseTaskIdSearch, tasksInLane } from '../src/domain/task-board';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

function fixture() {
  const graph = createProject('看板测试', '1479');
  const projectId = graph.project.id;
  const [backlog, pending] = graph.project.statusOptions;
  graph.tasks = [
    { id: 'b', projectId, name: 'B', description: '', externalTaskId: null, statusOptionId: backlog!.id, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 1, comments: [] },
    { id: 'a', projectId, name: 'A', description: '', externalTaskId: null, statusOptionId: backlog!.id, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [] },
    { id: 'c', projectId, name: 'C', description: '', externalTaskId: null, statusOptionId: pending!.id, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [] },
    { id: 'u', projectId, name: 'Unassigned', description: '', externalTaskId: null, statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [] },
  ];
  return graph;
}

describe('任务看板顺序变换', () => {
  it('按 Task ID 精确值或含端点的数字范围筛选，支持 16 位 ID', () => {
    const exact = parseTaskIdSearch('0007');
    expect(matchesTaskIdSearch('0007', exact)).toBe(true);
    expect(matchesTaskIdSearch('7', exact)).toBe(false);

    const range = parseTaskIdSearch('9007199254740990 - 9007199254740992');
    expect(range).toEqual({ kind: 'range', start: '9007199254740990', end: '9007199254740992' });
    expect(matchesTaskIdSearch('9007199254740991', range)).toBe(true);
    expect(matchesTaskIdSearch('9007199254740993', range)).toBe(false);
    expect(matchesTaskIdSearch(null, range)).toBe(false);
  });

  it('拒绝非法 ID 查询和逆序范围', () => {
    expect(parseTaskIdSearch('12345678901234567')).toMatchObject({ kind: 'invalid' });
    expect(parseTaskIdSearch('200-100')).toMatchObject({ kind: 'invalid', message: 'ID 范围的起始值不能大于结束值。' });
    expect(matchesTaskIdSearch('150', parseTaskIdSearch('200-100'))).toBe(false);
  });

  it('拒绝无效的 priority 感叹号数量和颜色', () => {
    const graph = createProject('优先级测试', '1479');
    graph.project.priorityOptions[0]!.indicatorCount = 0;
    expect(() => validateGraph(graph)).toThrow('感叹号数量必须为 1–3');
    graph.project.priorityOptions[0]!.indicatorCount = 2;
    graph.project.priorityOptions[0]!.indicatorColor = 'red';
    expect(() => validateGraph(graph)).toThrow('颜色无效');
  });

  it('priority 名称、感叹号数量和颜色经 revision 事务持久化', async () => {
    const db = new ArchiveDatabase(`priority-options-${crypto.randomUUID()}`);
    try {
      const repo = new ArchiveRepository(db);
      const graph = await repo.create('优先级选项测试', '1479');
      const options = graph.project.priorityOptions.map((option, index) => index === 0
        ? { ...option, name: '紧急', indicatorCount: 1, indicatorColor: '#123456' }
        : option);
      const updated = await repo.saveTaskOptions(graph.project.id, graph.project.revision, {
        statusOptions: graph.project.statusOptions,
        typeOptions: graph.project.typeOptions,
        priorityOptions: options,
        assigneeOptions: graph.project.assigneeOptions,
      });
      expect(updated.project.revision).toBe(graph.project.revision + 1);
      db.close();
      await db.open();
      const restored = await repo.get(graph.project.id);
      expect(restored.project.priorityOptions).toHaveLength(5);
      expect(restored.project.priorityOptions[0]).toMatchObject({ name: '紧急', indicatorCount: 1, indicatorColor: '#123456' });
    } finally {
      await db.delete();
    }
  });

  it('按泳道和持久顺序列出任务', () => {
    const graph = fixture();
    expect(tasksInLane(graph, graph.project.statusOptions[0]!.id).map(task => task.id)).toEqual(['a', 'b']);
    expect(tasksInLane(graph, null).map(task => task.id)).toEqual(['u']);
  });

  it('删除任务后压紧来源泳道顺序，后续新增不会撞上空洞序号', () => {
    const graph = fixture();
    const backlogId = graph.project.statusOptions[0]!.id;
    const removed = removeTask(graph, 'a');
    expect(tasksInLane(removed, backlogId).map(task => [task.id, task.sortOrder])).toEqual([['b', 0]]);
    expect(() => validateGraph(removed)).not.toThrow();
  });

  it('跨泳道移动、同泳道插入并重排来源与目标', () => {
    const graph = fixture();
    const backlogId = graph.project.statusOptions[0]!.id;
    const pendingId = graph.project.statusOptions[1]!.id;
    const moved = moveTaskInBoard(graph, 'b', pendingId, 'c');
    expect(tasksInLane(moved, backlogId).map(task => task.id)).toEqual(['a']);
    expect(tasksInLane(moved, pendingId).map(task => task.id)).toEqual(['b', 'c']);
    expect(graph.tasks.find(task => task.id === 'b')?.statusOptionId).toBe(backlogId);

    const reordered = moveTaskInBoard(moved, 'c', pendingId, 'b');
    expect(tasksInLane(reordered, pendingId).map(task => task.id)).toEqual(['c', 'b']);
  });

  it('拒绝不存在的泳道、任务和排序目标', () => {
    const graph = fixture();
    expect(() => moveTaskInBoard(graph, 'missing', null, null)).toThrow('任务不存在');
    expect(() => moveTaskInBoard(graph, 'a', 'missing', null)).toThrow('Status 不存在');
    expect(() => moveTaskInBoard(graph, 'a', graph.project.statusOptions[1]!.id, 'b')).toThrow('排序目标无效');
  });

  it('删除被引用的 Status 与 assignee 后清除引用并重排合并泳道', () => {
    const graph = fixture();
    const [backlog, pending] = graph.project.statusOptions;
    const assignee = { id: 'person-1', name: '工程师 A' };
    const priority = { id: 'priority-high', name: '高', indicatorCount: 2, indicatorColor: '#f05252' };
    graph.project.assigneeOptions = [assignee];
    graph.project.priorityOptions = [priority];
    graph.tasks[0]!.assigneeId = assignee.id;
    graph.tasks[0]!.priorityOptionId = priority.id;
    const next = updateTaskOptions(graph, {
      statusOptions: graph.project.statusOptions.slice(1),
      typeOptions: graph.project.typeOptions,
      priorityOptions: [],
      assigneeOptions: [],
    });
    expect(next.tasks.find(task => task.id === 'a')?.statusOptionId).toBeNull();
    expect(next.tasks.find(task => task.id === 'c')?.statusOptionId).toBe(pending!.id);
    expect(next.tasks.find(task => task.id === 'b')?.assigneeId).toBeNull();
    expect(next.tasks.find(task => task.id === 'b')?.priorityOptionId).toBeNull();
    expect(next.tasks.filter(task => task.statusOptionId === null).map(task => task.sortOrder).sort()).toEqual([0, 1, 2]);
    expect(() => validateGraph(next)).not.toThrow();
  });

  it('拒绝非法日历日期和截止早于开始日期', () => {
    const graph = fixture();
    const task = graph.tasks[0]!;
    task.startDate = '2026-02-30';
    expect(() => validateGraph(graph)).toThrow('有效的 YYYY-MM-DD');
    task.startDate = '2026-02-20';
    task.dueDate = '2026-02-19';
    expect(() => validateGraph(graph)).toThrow('截止日期不能早于');
  });

  it('单次项目 revision 事务持久化移动和选项删除引用清理', async () => {
    const db = new ArchiveDatabase(`task-board-${crypto.randomUUID()}`);
    try {
      const repo = new ArchiveRepository(db);
      let graph = await repo.create('任务看板', '001');
      const [backlog, pending] = graph.project.statusOptions;
      const createTask = (id: string, sortOrder: number) => ({
        id, projectId: graph.project.id, name: id, description: '', externalTaskId: null,
        statusOptionId: backlog!.id, typeOptionId: null, priorityOptionId: null, assigneeId: null,
        startDate: null, dueDate: null, sortOrder, comments: [],
      });
      graph = await repo.saveTask(graph.project.id, graph.project.revision, createTask('a', 0));
      graph = await repo.saveTask(graph.project.id, graph.project.revision, createTask('b', 1));
      const moved = await repo.moveTask(graph.project.id, graph.project.revision, 'b', pending!.id, null);
      expect(moved.project.revision).toBe(graph.project.revision + 1);
      expect(tasksInLane(moved, pending!.id).map(task => task.id)).toEqual(['b']);
      await expect(repo.moveTask(graph.project.id, graph.project.revision, 'a', pending!.id, null))
        .rejects.toThrow('其他标签页已更新');

      const withoutBacklog = await repo.saveTaskOptions(moved.project.id, moved.project.revision, {
        statusOptions: moved.project.statusOptions.filter(option => option.id !== backlog!.id),
        typeOptions: moved.project.typeOptions,
        priorityOptions: moved.project.priorityOptions,
        assigneeOptions: moved.project.assigneeOptions,
      });
      expect(withoutBacklog.tasks.find(task => task.id === 'a')?.statusOptionId).toBeNull();
      expect(tasksInLane(withoutBacklog, null).map(task => task.id)).toEqual(['a']);
    } finally {
      await db.delete();
    }
  });

  it('评论新增、编辑和删除经项目 revision 原子保存', async () => {
    const db = new ArchiveDatabase(`task-comments-${crypto.randomUUID()}`);
    try {
      const repo = new ArchiveRepository(db);
      const graph = await repo.create('评论测试', '002');
      const task = {
        id: 'comment-task', projectId: graph.project.id, name: '有评论的任务', description: '', externalTaskId: null,
        statusOptionId: graph.project.statusOptions[0]!.id, typeOptionId: null, priorityOptionId: null,
        assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [],
      };
      let saved = await repo.saveTask(graph.project.id, graph.project.revision, task);
      const createdAt = '2026-11-10T10:00:00.000Z';
      saved = await repo.saveTask(graph.project.id, saved.project.revision, {
        ...task,
        comments: [{ id: 'comment-1', text: '**开始**', createdAt, updatedAt: createdAt }],
      });
      expect(saved.tasks[0]!.comments).toEqual([{ id: 'comment-1', text: '**开始**', createdAt, updatedAt: createdAt }]);
      const updatedAt = '2026-11-10T11:00:00.000Z';
      saved = await repo.saveTask(graph.project.id, saved.project.revision, {
        ...saved.tasks[0]!,
        comments: [{ ...saved.tasks[0]!.comments[0]!, text: '**完成**', updatedAt }],
      });
      expect(saved.tasks[0]!.comments[0]).toMatchObject({ text: '**完成**', createdAt, updatedAt });
      saved = await repo.saveTask(graph.project.id, saved.project.revision, { ...saved.tasks[0]!, comments: [] });
      expect(saved.tasks[0]!.comments).toEqual([]);
      expect(await repo.get(graph.project.id)).toEqual(saved);
    } finally {
      await db.delete();
    }
  });
});