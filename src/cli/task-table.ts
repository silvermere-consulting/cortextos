/**
 * Task-table rendering for `bus list-tasks`.
 *
 * Extracted from an inline console.log in bus.ts because it was NOT TESTABLE in that
 * shape — and "not testable" was the reason a real defect lived here unnoticed: the
 * rendered id was truncated AND welded to the assignee, so agents copying an id from
 * the table got a silently wrong one, which then 404s on update-task.
 *
 * Ask whether a thing is testable before asking why it is untested.
 */

export const TASK_ID_COL = 28; // task ids are 27 chars; +1 guarantees a gutter
const ASSIGNEE_COL = 17;

export interface TaskRowFields {
  id: string;
  status: string;
  priority?: string;
  assigned_to?: string | null;
  title: string;
}

export const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '●',
  blocked: '◑',
  completed: '✓',
  done: '✓',
  cancelled: '✗',
};

export function taskTableHeader(): string {
  return '  Status  Pri  ' + 'ID'.padEnd(TASK_ID_COL) + 'Assignee'.padEnd(ASSIGNEE_COL) + 'Title';
}

/**
 * Render one task row.
 *
 * The id is NEVER truncated. It is padded to a width wider than the id itself, so an id
 * and the assignee beside it can never fuse into one unsplittable token — which is what
 * made agents mis-cut ids in the first place.
 */
export function formatTaskRow(t: TaskRowFields, priorityIcon: string): string {
  const statusIcon = (STATUS_ICON[t.status] || '?').padEnd(8);
  const priIcon = priorityIcon.padEnd(5);
  const id = t.id.padEnd(TASK_ID_COL);
  const assignee = (t.assigned_to || '-').substring(0, ASSIGNEE_COL - 1).padEnd(ASSIGNEE_COL);
  const title = t.title.substring(0, 50);
  return `  ${statusIcon}${priIcon}${id}${assignee}${title}`;
}
