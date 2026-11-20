export interface InboxSummary {
  revision: number;
  unreadCount: number;
}

export interface CommentNotification {
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  commentId: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  reply: boolean;
  mention: boolean;
  read: boolean;
}
