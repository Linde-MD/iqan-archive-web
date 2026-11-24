import type { Branch, Edge, Project, Task, VersionNode } from './model';

export type ProjectSummary = Pick<Project, 'id' | 'name' | 'partNumber' | 'revision'>;
export type VersionSummary = Omit<VersionNode, 'description'>;
export type TaskSummary = Omit<Task, 'description' | 'comments' | 'descriptionEditedBy'> & {
  descriptionExcerpt: string;
  commentCount: number;
};

export type ProjectPage = 'files' | 'graph' | 'tasks';

export interface ProjectFilesView {
  kind: 'files';
  revision: number;
  project: ProjectSummary;
  nodes: VersionSummary[];
  edges: Edge[];
}

export interface ProjectGraphView {
  kind: 'graph';
  revision: number;
  project: Project;
  nodes: VersionNode[];
  edges: Edge[];
  branches: Branch[];
  tasks: TaskSummary[];
}

export interface ProjectBoardView {
  kind: 'tasks';
  revision: number;
  project: Project;
  nodes: VersionSummary[];
  edges: Edge[];
  branches: Branch[];
  tasks: TaskSummary[];
}

export type ProjectPageView = ProjectFilesView | ProjectGraphView | ProjectBoardView;

export interface TaskDetail {
  revision: number;
  task: Task;
}

export interface VersionDetail {
  revision: number;
  node: VersionNode;
}

export function summarizeProject(project: Project): ProjectSummary {
  const { id, name, partNumber, revision } = project;
  return { id, name, partNumber, revision };
}

export function summarizeVersion(node: VersionNode): VersionSummary {
  const { description: _description, ...summary } = node;
  return summary;
}

export function summarizeTask(task: Task): TaskSummary {
  const { description, comments, descriptionEditedBy: _editedBy, ...summary } = task;
  return { ...summary, descriptionExcerpt: description.slice(0, 160), commentCount: comments.length };
}
