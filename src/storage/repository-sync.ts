import type { Project, ProjectGraph, ProjectSnapshot } from '../domain/model';
import type { SnapshotImportPlan } from './database';

export interface RepositorySync {
  readonly permissions: { sharedWritable: boolean; newVersionWritable: boolean; draftNodeIds: Readonly<Record<string, readonly string[]>>; draftProjectIds: readonly string[] };
  listProjects(): Promise<Project[]>;
  get(id: string): Promise<ProjectGraph>;
  snapshot(id: string): Promise<ProjectSnapshot>;
  create(name: string, partNumber: string): Promise<ProjectGraph>;
  change(id: string, revision: number, transform: (graph: ProjectGraph) => ProjectGraph, deletion: boolean, operation?: unknown): Promise<ProjectGraph>;
  deleteProject(id: string, revision: number, confirmedName: string): Promise<void>;
  restoreUndo(id: string, revision: number, graph: ProjectGraph): Promise<ProjectGraph>;
  restoreSnapshot(graph: ProjectGraph, currentId: string, preview: SnapshotImportPlan): Promise<ProjectGraph>;
  previewSnapshotRestore(graph: ProjectGraph, currentId: string): Promise<SnapshotImportPlan>;
}
