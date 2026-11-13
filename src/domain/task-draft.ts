import type { Task } from './model';

export function mergeSavedTaskDraft(draft: Task, submitted: Task, saved: Task): void {
  if (draft.name === submitted.name) draft.name = saved.name;
  if (draft.description === submitted.description) draft.description = saved.description;
  const fields = ['externalTaskId', 'parentTaskId', 'statusOptionId', 'typeOptionId',
    'priorityOptionId', 'assigneeId', 'startDate', 'dueDate'] as const;
  for (const field of fields) {
    if (draft[field] === submitted[field]) draft[field] = saved[field];
  }
  draft.sortOrder = saved.sortOrder;
  draft.comments = structuredClone(saved.comments);
}
