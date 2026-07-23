/**
 * dashboard/src/app/api/tasks/[id]/__tests__/patch-route.test.ts
 *
 * API route tests for PATCH /api/tasks/[id] — status-update path.
 * Focus: a completion (or any status change) targeting a NONEXISTENT task id
 * must return a graceful 404, not a 500. Regression guard for the bug where
 * getTaskById(id) was never null-checked before spawning the bus script, so a
 * missing id failed inside the script and surfaced as a 500.
 *
 * Also locks the guard ORDER the fix depends on: the server-side secret-shape
 * check runs BEFORE the task lookup, so a fake id is still probeable with a
 * secret-shaped field (400) and never leaks a 404-vs-not distinction from it.
 *
 * Mocks @/lib/data/tasks so getTaskById is controllable and no SQLite DB is
 * needed. Uses the @/ alias resolved by vitest.config.ts to dashboard/src.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock the data layer before importing the route (no DB open, no fixture)
// ---------------------------------------------------------------------------

const mockGetTaskById = vi.fn();

vi.mock('@/lib/data/tasks', () => ({
  getTaskById: mockGetTaskById,
}));

// Import route AFTER mock registration
type TaskRouteModule = typeof import('../route');
let route: TaskRouteModule;

beforeEach(async () => {
  mockGetTaskById.mockReset();
  route = await import('../route');
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function callPatch(id: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const params = Promise.resolve({ id });
  return route.PATCH(req, { params });
}

// A GitHub-PAT-shaped string the secret-shape classifier flags (see
// dashboard/src/lib/__tests__/secret-shape.test.ts).
const SECRET_SHAPED = 'ghp_AbCdEf1234567890AbCdEf1234567890AbCd';

// ---------------------------------------------------------------------------

describe('PATCH /api/tasks/[id] — missing id is a 404, not a 500', () => {
  it('returns 404 when completing a nonexistent task id', async () => {
    mockGetTaskById.mockReturnValueOnce(null);

    const res = await callPatch('task_does_not_exist', { status: 'completed' });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Task not found');
    expect(mockGetTaskById).toHaveBeenCalledWith('task_does_not_exist');
  });

  it('returns 404 for a non-completion status change on a missing id', async () => {
    mockGetTaskById.mockReturnValueOnce(null);

    const res = await callPatch('nope', { status: 'in_progress' });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/tasks/[id] — guards run before the task lookup', () => {
  it('secret-shape guard precedes lookup: fake id + secret-shaped field is 400, not 404', async () => {
    mockGetTaskById.mockReturnValueOnce(null);

    const res = await callPatch('task_does_not_exist', {
      status: 'completed',
      outputSummary: SECRET_SHAPED,
    });

    expect(res.status).toBe(400);
    // The lookup is never reached because the secret-shape guard short-circuits.
    expect(mockGetTaskById).not.toHaveBeenCalled();
  });

  it('rejects an invalid status with 400 before any lookup', async () => {
    const res = await callPatch('task_1', { status: 'bogus' });

    expect(res.status).toBe(400);
    expect(mockGetTaskById).not.toHaveBeenCalled();
  });

  it('rejects a path-traversal-shaped id with 400 before any lookup', async () => {
    const res = await callPatch('../secrets', { status: 'completed' });

    expect(res.status).toBe(400);
    expect(mockGetTaskById).not.toHaveBeenCalled();
  });
});
