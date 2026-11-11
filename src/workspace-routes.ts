export type ProjectView = 'files' | 'graph' | 'documents' | 'tasks';
export type ProjectOverlay = 'edit' | 'delete';

export interface WorkspaceLocation {
  projectId: string;
  view: ProjectView;
  child: string[];
  overlay: ProjectOverlay | null;
}

export function projectPath(projectId: string, view: ProjectView, ...children: string[]): string {
  const base = `/projects/${encodeURIComponent(projectId)}/${view}`;
  return children.length ? `${base}/${children.map(encodeURIComponent).join('/')}` : base;
}

export function projectOverlayPath(projectId: string, view: ProjectView, overlay: ProjectOverlay): string {
  return `${projectPath(projectId, view)}/${overlay === 'edit' ? 'edit-project' : 'delete-project'}`;
}

export function parseWorkspaceLocation(path: string): WorkspaceLocation {
  let segments: string[];
  try {
    segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { projectId: '', view: 'files', child: [], overlay: null };
  }
  if (segments[0] !== 'projects' || !segments[1]) {
    return { projectId: '', view: 'files', child: [], overlay: null };
  }
  const projectId = segments[1];
  const view = segments[2] as ProjectView | undefined;
  if (!view || !['files', 'graph', 'documents', 'tasks'].includes(view)) {
    return { projectId: '', view: 'files', child: [], overlay: null };
  }
  const overlay = segments[3] === 'edit-project' ? 'edit'
    : segments[3] === 'delete-project' ? 'delete' : null;
  return { projectId, view, child: segments.slice(overlay ? 4 : 3), overlay };
}