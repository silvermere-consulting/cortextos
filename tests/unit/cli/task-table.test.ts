import { describe, it, expect } from 'vitest';
import { formatTaskRow, taskTableHeader, TASK_ID_COL } from '../../../src/cli/task-table.js';

// A real id from the live bus. Task ids are 27 chars: task_<13-digit ms>_<8-digit rand>.
const REAL_ID = 'task_1783829843757_87450547';

const task = {
  id: REAL_ID,
  status: 'pending',
  assigned_to: 'engineer',
  title: 'a task',
};

describe('list-tasks table rendering', () => {
  // ── THE ISOLATING CLAIM, alone in its own test. ──
  // The original defect: `t.id.substring(0, 26)` dropped the 27th char, and the resulting
  // 26-char id then hit `.padEnd(26)` which added NOTHING, so the id fused to the assignee:
  //     "task_1783829843757_8745054engineer"
  // An agent copying "the id" from that row gets a silently wrong id, which 404s on
  // update-task. Nothing else may assert before this, or a sibling failure would mask it.
  it('renders the FULL task id, never truncated', () => {
    expect(formatTaskRow(task, '·')).toContain(REAL_ID);
  });

  it('separates the id from the assignee with whitespace (they must never fuse)', () => {
    const row = formatTaskRow(task, '·');
    // The id must be followed by at least one space before anything else appears.
    expect(row).toMatch(new RegExp(`${REAL_ID}\\s`));
    // And the fused form must not occur.
    expect(row).not.toContain(`${REAL_ID}engineer`);
  });

  it('id column is wider than a task id, so a gutter is structural not incidental', () => {
    expect(TASK_ID_COL).toBeGreaterThan(REAL_ID.length);
  });

  it('header id column aligns with the rendered rows', () => {
    const header = taskTableHeader();
    const row = formatTaskRow(task, '·');
    // Assignee starts at the same column in both.
    expect(header.indexOf('Assignee')).toBe(row.indexOf('engineer'));
  });

  it('still truncates an over-long title (unchanged behaviour)', () => {
    const long = { ...task, title: 'x'.repeat(80) };
    expect(formatTaskRow(long, '·')).toContain('x'.repeat(50));
    expect(formatTaskRow(long, '·')).not.toContain('x'.repeat(51));
  });
});
