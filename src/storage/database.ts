import Dexie, { type Table } from 'dexie';
import { createProject, normalizeVersion, requireCondition, type Project, type ProjectGraph, type Task, type VersionNode, type Edge, type Branch, type FileReference, type ProjectSnapshot } from '../domain/model';
import { applyDeletion, release, revokeRelease, updateTask, validateGraph, validateTransition, type DeletionPlan } from '../domain/graph';
import { registerCandidates, rebindReference, type FileCandidate } from '../domain/filenames';
import type { DirectoryBinding, DirectoryRole, DirectoryHandle } from '../files/directories';

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
    tasks: graph.tasks.map(({ id, projectId, name, description, loopId }) => ({ id, projectId, name, description, loopId })),
    branches: graph.branches.map(({ id, projectId, name, description, color, headId }) => ({ id, projectId, name, description, color, headId })),
    files: graph.files.map(({ id, projectId, nodeId, fileName, relativePath, extension, candidateDate, parsingStatus }) => ({ id, projectId, nodeId, fileName, relativePath, extension, candidateDate, parsingStatus })),
  };
}

export class ArchiveDatabase extends Dexie {
  projects!: Table<Project, string>;
  nodes!: Table<VersionNode, string>;
  edges!: Table<Edge, string>;
  branches!: Table<Branch, string>;
  tasks!: Table<Task, string>;
  files!: Table<FileReference, string>;
  directoryBindings!: Table<DirectoryBinding, [string, DirectoryRole]>;

  constructor(name = 'iqan-archive-web') {
    super(name);
    this.version(1).stores({
      projects: 'id',
      nodes: 'id, projectId, &[projectId+version]',
      edges: 'id, projectId',
      branches: 'id, projectId',
      tasks: 'id, projectId, &[projectId+loopId]',
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
    return [this.db.projects, this.db.nodes, this.db.edges, this.db.branches, this.db.tasks, this.db.files];
  }

  private async read(projectId: string): Promise<ProjectGraph> {
    const project = await this.db.projects.get(projectId);
    requireCondition(project, 'PROJECT_NOT_FOUND', '项目不存在。');
    const [nodes, edges, branches, tasks, files] = await Promise.all([
      this.db.nodes.where('projectId').equals(projectId).toArray(),
      this.db.edges.where('projectId').equals(projectId).toArray(),
      this.db.branches.where('projectId').equals(projectId).toArray(),
      this.db.tasks.where('projectId').equals(projectId).toArray(),
      this.db.files.where('projectId').equals(projectId).toArray(),
    ]);
    const graph = { project, nodes, edges, branches, tasks, files };
    validateGraph(graph);
    return graph;
  }

  async get(projectId: string): Promise<ProjectGraph> {
    return this.db.transaction('r', this.tables, () => this.read(projectId));
  }

  private async write(graph: ProjectGraph): Promise<void> {
    const id = graph.project.id;
    for (const table of [this.db.nodes, this.db.edges, this.db.branches, this.db.tasks, this.db.files]) {
      await table.where('projectId').equals(id).delete();
    }
    // add (rather than put) prevents a foreign project's ID from being overwritten.
    await this.db.nodes.bulkAdd(graph.nodes);
    await this.db.edges.bulkAdd(graph.edges);
    await this.db.branches.bulkAdd(graph.branches);
    await this.db.tasks.bulkAdd(graph.tasks);
    await this.db.files.bulkAdd(graph.files);
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

  async saveTask(projectId: string, revision: number, task: Task): Promise<ProjectGraph> {
    return this.change(projectId, revision, graph => updateTask(graph, task));
  }

  async register(projectId: string, revision: number, candidates: readonly FileCandidate[]) {
    return this.change(projectId, revision, graph => registerCandidates(graph, candidates));
  }

  async rebind(projectId: string, revision: number, fileId: string, candidate: FileCandidate) {
    return this.change(projectId, revision, graph => rebindReference(graph, fileId, candidate));
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

  async snapshot(projectId: string): Promise<ProjectSnapshot> {
    const graph = await this.get(projectId);
    return { schemaVersion: 1, graph: configurationOnly(graph) };
  }
}
