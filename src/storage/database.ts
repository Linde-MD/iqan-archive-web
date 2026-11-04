import Dexie, { type Table } from 'dexie';
import { createProject, normalizeVersion, requireCondition, type Project, type ProjectGraph, type Task, type VersionNode, type Edge, type Branch, type ProjectSnapshot } from '../domain/model';
import { applyDeletion, applyDeletionMany, appendVersion, createBranch, deleteBranch as removeBranch, deleteTask, mergeVersion, release, revokeRelease, setNodeParents, updateBranch, updateNode, updatePartNumber, updateTask, validateGraph, validateTransition, type BranchUpdate, type DeletionPlan, type MultiDeletionPlan, type NodeUpdate } from '../domain/graph';
import { registerCandidates, type FileCandidate } from '../domain/filenames';
import type { DirectoryBinding, DirectoryRole, DirectoryHandle } from '../files/directories';
import { changeVersionRelations, type BatchRelationAction } from '../domain/relations';

function configurationOnly(graph: ProjectGraph): ProjectGraph {
  return {
    project: {
      id: graph.project.id, name: graph.project.name, partNumber: graph.project.partNumber,
      revision: graph.project.revision,
      engineeringDirectoryHint: graph.project.engineeringDirectoryHint,
      wordDirectoryHint: graph.project.wordDirectoryHint,
    },
    nodes: graph.nodes.map(({ id, projectId, version, description, taskId, releasedAt }) => ({ id, projectId, version, description, taskId, releasedAt })),
    edges: graph.edges.map(({ id, projectId, parentId, childId }) => ({ id, projectId, parentId, childId })),
    tasks: graph.tasks.map(({ id, projectId, name, description, externalTaskId }) => ({ id, projectId, name, description, externalTaskId })),
    branches: graph.branches.map(({ id, projectId, name, description, color, headId }) => ({ id, projectId, name, description, color, headId })),
  };
}

export class ArchiveDatabase extends Dexie {
  projects!: Table<Project, string>;
  nodes!: Table<VersionNode, string>;
  edges!: Table<Edge, string>;
  branches!: Table<Branch, string>;
  tasks!: Table<Task, string>;
  directoryBindings!: Table<DirectoryBinding, [string, DirectoryRole]>;

  constructor(name = 'iqan-archive-web') {
    super(name);
    this.version(1).stores({
      projects: 'id',
      nodes: 'id, projectId, &[projectId+version]',
      edges: 'id, projectId',
      branches: 'id, projectId',
      tasks: 'id, projectId, &[projectId+externalTaskId]',
      files: 'id, projectId, nodeId',
    });
    this.version(2).stores({
      directoryBindings: '[projectId+role], projectId',
    }).upgrade(async transaction => {
      const versions = new Set<string>();
      const nodes = await transaction.table<VersionNode>('nodes').toArray();
      for (const node of nodes) {
        const key = JSON.stringify([node.projectId, normalizeVersion(node.version)]);
        requireCondition(!versions.has(key), 'MIGRATION_CONFLICT', '旧版本号空白归一后存在冲突，升级已取消，旧数据未改动；请使用旧版整理冲突后重试。');
        versions.add(key);
      }
    });
    this.version(3).stores({ files: null });
    this.version(4).stores({
      tasks: 'id, projectId, &[projectId+externalTaskId]',
    });
    this.on('ready', () => {
      // Dexie scales native versions by ten and otherwise accepts newer schemas.
      requireCondition(this.backendDB().version === this.verno * 10, 'SCHEMA_VERSION', '数据库版本超出当前应用支持范围，请使用匹配的新版应用，勿清除本机数据。');
    }, true);
  }
}

export class ArchiveRepository {
  constructor(public readonly db: ArchiveDatabase) {}

  async listProjects(): Promise<Project[]> {
    return this.db.projects.toArray();
  }

  async create(name: string, partNumber: string): Promise<ProjectGraph> {
    const graph = createProject(name, partNumber);
    validateGraph(graph);
    await this.db.projects.add(graph.project);
    return graph;
  }

  private get tables() {
    return [this.db.projects, this.db.nodes, this.db.edges, this.db.branches, this.db.tasks];
  }

  private async read(projectId: string): Promise<ProjectGraph> {
    const project = await this.db.projects.get(projectId);
    requireCondition(project, 'PROJECT_NOT_FOUND', '项目不存在。');
    const [nodes, edges, branches, tasks] = await Promise.all([
      this.db.nodes.where('projectId').equals(projectId).toArray(),
      this.db.edges.where('projectId').equals(projectId).toArray(),
      this.db.branches.where('projectId').equals(projectId).toArray(),
      this.db.tasks.where('projectId').equals(projectId).toArray(),
    ]);
    const graph = { project, nodes, edges, branches, tasks };
    validateGraph(graph);
    return graph;
  }

  async get(projectId: string): Promise<ProjectGraph> {
    return this.db.transaction('r', this.tables, () => this.read(projectId));
  }

  private async write(graph: ProjectGraph): Promise<void> {
    const id = graph.project.id;
    for (const table of [this.db.nodes, this.db.edges, this.db.branches, this.db.tasks]) {
      await table.where('projectId').equals(id).delete();
    }
    // add (rather than put) prevents a foreign project's ID from being overwritten.
    await this.db.nodes.bulkAdd(graph.nodes);
    await this.db.edges.bulkAdd(graph.edges);
    await this.db.branches.bulkAdd(graph.branches);
    await this.db.tasks.bulkAdd(graph.tasks);
    await this.db.projects.put(graph.project);
  }

  private async change(
    projectId: string,
    revision: number,
    transform: (graph: ProjectGraph) => ProjectGraph,
    deletion = false,
  ): Promise<ProjectGraph> {
    return this.db.transaction('rw', this.tables, async () => {
      const current = await this.read(projectId);
      requireCondition(current.project.revision === revision, 'STALE_REVISION', '其他标签页已更新项目，请刷新后重试。');
      const next = configurationOnly(transform(current));
      if (!deletion) validateTransition(current, next);
      else validateGraph(next);
      next.project.revision = current.project.revision + 1;
      await this.write(next);
      return next;
    });
  }

  async save(graph: ProjectGraph): Promise<ProjectGraph> {
    return this.change(graph.project.id, graph.project.revision, current => {
      const released = new Map(current.nodes.map(node => [node.id, node.releasedAt]));
      for (const node of graph.nodes) {
        requireCondition(node.releasedAt === (released.get(node.id) ?? null), 'RELEASE_COMMAND', '放行状态和时间必须通过放行或撤销命令修改。');
      }
      return structuredClone(graph);
    });
  }

  async restoreUndo(projectId: string, revision: number, previous: ProjectGraph): Promise<ProjectGraph> {
    return this.db.transaction('rw', this.tables, async () => {
      const current = await this.read(projectId);
      requireCondition(current.project.revision === revision, 'STALE_REVISION', '其他标签页已更新项目，撤销已取消，请重新读取版本图。');
      requireCondition(previous.project.id === projectId, 'PROJECT_ID', '撤销记录不属于当前项目。');
      const restored = configurationOnly(previous);
      validateGraph(restored);
      restored.project.revision = current.project.revision + 1;
      await this.write(restored);
      return restored;
    });
  }

  async saveTask(projectId: string, revision: number, task: Task): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => updateTask(graph, task));
  }

  async deleteTask(projectId: string, revision: number, taskId: string): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => deleteTask(graph, taskId));
  }

  async register(projectId: string, revision: number, candidates: readonly FileCandidate[]) {
    return this.change(projectId, revision, graph => registerCandidates(graph, candidates));
  }

  async setPartNumber(projectId: string, revision: number, partNumber: string) {
    return this.change(projectId, revision, graph => updatePartNumber(graph, partNumber));
  }

  async deleteProject(projectId: string, revision: number, confirmedName: string): Promise<void> {
    await this.db.transaction('rw', [...this.tables, this.db.directoryBindings], async () => {
      const current = await this.read(projectId);
      requireCondition(current.project.revision === revision, 'STALE_REVISION', '项目已更新，请取消删除，重新读取项目并确认。');
      requireCondition(confirmedName === current.project.name, 'DELETE_CONFIRMATION', '请输入完整项目名称以确认删除。');
      for (const table of [this.db.nodes, this.db.edges, this.db.branches, this.db.tasks, this.db.directoryBindings]) {
        await table.where('projectId').equals(projectId).delete();
      }
      await this.db.projects.delete(projectId);
    });
  }

  async directoryHint(projectId: string, revision: number, role: DirectoryRole, hint: string) {
    return this.change(projectId, revision, graph => {
      graph.project[role === 'engineering' ? 'engineeringDirectoryHint' : 'wordDirectoryHint'] = hint.trim();
      return graph;
    });
  }

  async bind(projectId: string, role: DirectoryRole, handle: DirectoryHandle): Promise<void> {
    await this.db.transaction('rw', [this.db.projects, this.db.directoryBindings], async () => {
      requireCondition(await this.db.projects.get(projectId), 'PROJECT_NOT_FOUND', '项目不存在。');
      await this.db.directoryBindings.put({ projectId, role, handle });
    });
  }

  async release(projectId: string, revision: number, nodeId: string): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => release(graph, nodeId, new Date().toISOString()));
  }

  async revoke(projectId: string, revision: number, nodeId: string): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => revokeRelease(graph, nodeId));
  }

  async deleteNode(projectId: string, revision: number, plan: DeletionPlan, confirmedVersion: string | null): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => applyDeletion(graph, plan, confirmedVersion), true);
  }

  async deleteNodes(projectId: string, revision: number, plan: MultiDeletionPlan, confirmedVersions: Readonly<Record<string, string>>): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => applyDeletionMany(graph, plan, confirmedVersions), true);
  }

  async addNode(projectId: string, revision: number, node: VersionNode, parentIds: readonly string[], targetBranchId: string | null): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => appendVersion(graph, node, parentIds, targetBranchId));
  }

  async addBranch(projectId: string, revision: number, branch: Branch): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => createBranch(graph, branch));
  }

  async deleteBranch(projectId: string, revision: number, branchId: string): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => removeBranch(graph, branchId));
  }

  async merge(projectId: string, revision: number, node: VersionNode, parentIds: readonly string[], targetBranchId: string): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => mergeVersion(graph, node, parentIds, targetBranchId));
  }

  async saveNode(projectId: string, revision: number, nodeId: string, update: NodeUpdate): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => updateNode(graph, nodeId, update));
  }

  async saveNodeParents(projectId: string, revision: number, childId: string, parentIds: readonly string[]): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => setNodeParents(graph, childId, parentIds));
  }

  async changeRelations(projectId: string, revision: number, nodeIds: readonly string[], action: BatchRelationAction): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => changeVersionRelations(graph, nodeIds, action));
  }

  async saveBranch(projectId: string, revision: number, branchId: string, update: BranchUpdate): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => updateBranch(graph, branchId, update));
  }

  async snapshot(projectId: string): Promise<ProjectSnapshot> {
    const graph = await this.get(projectId);
    const clean = configurationOnly(graph);
    const { id, name, partNumber, revision } = clean.project;
    return { schemaVersion: 3, graph: { ...clean, project: { id, name, partNumber, revision } } };
  }

  async inspectSnapshotImport(graph: ProjectGraph): Promise<boolean> {
    validateGraph(graph);
    return this.db.transaction('r', [...this.tables, this.db.directoryBindings], () => this.importHasConflict(graph));
  }

  async importSnapshot(graph: ProjectGraph): Promise<{ graph: ProjectGraph; copied: boolean }> {
    validateGraph(graph);
    return this.db.transaction('rw', [...this.tables, this.db.directoryBindings], async () => {
      const clean = configurationOnly(graph);
      clean.project.engineeringDirectoryHint = '';
      clean.project.wordDirectoryHint = '';
      const copied = await this.importHasConflict(clean);
      const imported = copied ? await this.remapImportedGraph(clean) : clean;
      validateGraph(imported);
      await this.db.nodes.bulkAdd(imported.nodes);
      await this.db.edges.bulkAdd(imported.edges);
      await this.db.branches.bulkAdd(imported.branches);
      await this.db.tasks.bulkAdd(imported.tasks);
      await this.db.projects.add(imported.project);
      return { graph: imported, copied };
    });
  }

  private async importHasConflict(graph: ProjectGraph): Promise<boolean> {
    if (await this.db.projects.get(graph.project.id)) return true;
    if (await this.db.directoryBindings.where('projectId').equals(graph.project.id).count()) return true;
    for (const [table, items] of [
      [this.db.nodes, graph.nodes],
      [this.db.edges, graph.edges],
      [this.db.branches, graph.branches],
      [this.db.tasks, graph.tasks],
    ] as const) {
      for (const item of items) if (await table.get(item.id)) return true;
    }
    return false;
  }

  private async remapImportedGraph(graph: ProjectGraph): Promise<ProjectGraph> {
    async function freshIds(count: number, exists: (id: string) => Promise<boolean>): Promise<string[]> {
      const ids: string[] = [];
      const used = new Set<string>();
      while (ids.length < count) {
        const id = crypto.randomUUID();
        if (used.has(id) || await exists(id)) continue;
        used.add(id);
        ids.push(id);
      }
      return ids;
    }

    const [projectIds, nodeIds, edgeIds, branchIds, taskIds] = await Promise.all([
      freshIds(1, async id => Boolean(await this.db.projects.get(id)) || Boolean(await this.db.directoryBindings.where('projectId').equals(id).count())),
      freshIds(graph.nodes.length, async id => Boolean(await this.db.nodes.get(id))),
      freshIds(graph.edges.length, async id => Boolean(await this.db.edges.get(id))),
      freshIds(graph.branches.length, async id => Boolean(await this.db.branches.get(id))),
      freshIds(graph.tasks.length, async id => Boolean(await this.db.tasks.get(id))),
    ]);
    const projectId = projectIds[0]!;
    const nodeIdMap = new Map(graph.nodes.map((item, index) => [item.id, nodeIds[index]!]));
    const taskIdMap = new Map(graph.tasks.map((item, index) => [item.id, taskIds[index]!]));
    return {
      project: { ...graph.project, id: projectId, revision: 0, engineeringDirectoryHint: '', wordDirectoryHint: '' },
      nodes: graph.nodes.map(item => ({
        ...item,
        id: nodeIdMap.get(item.id)!,
        projectId,
        taskId: item.taskId === null ? null : taskIdMap.get(item.taskId)!,
      })),
      edges: graph.edges.map((item, index) => ({
        ...item, id: edgeIds[index]!, projectId,
        parentId: nodeIdMap.get(item.parentId)!,
        childId: nodeIdMap.get(item.childId)!,
      })),
      branches: graph.branches.map((item, index) => ({
        ...item, id: branchIds[index]!, projectId, headId: nodeIdMap.get(item.headId)!,
      })),
      tasks: graph.tasks.map((item, index) => ({ ...item, id: taskIds[index]!, projectId })),
    };
  }
}
