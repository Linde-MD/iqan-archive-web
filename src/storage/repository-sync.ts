import type { Project, ProjectGraph, ProjectSnapshot, TaskAssignee } from '../domain/model';
import type { SnapshotImportPlan } from './database';

export interface RepositorySync {
  readonly permissions: { sharedWritable: boolean; sharedWriteBlockedReason: string; newVersionWritable: boolean; draftNodeIds: Readonly<Record<string, readonly string[]>>; draftProjectIds: readonly string[] };
  listProjects(): Promise<Project[]>;
  listAssignees(): Promise<TaskAssignee[]>;
  get(id: string): Promise<ProjectGraph>;
  snapshot(id: string): Promise<ProjectSnapshot>;
  create(name: string, partNumber: string): Promise<ProjectGraph>;
  change(id: string, revision: number, transform: (graph: ProjectGraph) => ProjectGraph, deletion: boolean, operation?: unknown): Promise<ProjectGraph>;
  deleteProject(id: string, revision: number, confirmedName: string): Promise<void>;
  restoreSnapshot(graph: ProjectGraph, currentId: string, preview: SnapshotImportPlan): Promise<ProjectGraph>;
  previewSnapshotRestore(graph: ProjectGraph, currentId: string): Promise<SnapshotImportPlan>;
}

export function projectWriteBlockedReason(permissions: RepositorySync['permissions'] | undefined, projectId: string): string {
  if (!permissions) return '';
  if (permissions.sharedWriteBlockedReason) return permissions.sharedWriteBlockedReason;
  return permissions.draftProjectIds.includes(projectId)
    ? '当前项目有待同步版本，既有共享内容暂时只读。请在账号菜单的“协作与同步”中预览并确认发布草稿，再修改共享内容。'
    : '';
}
