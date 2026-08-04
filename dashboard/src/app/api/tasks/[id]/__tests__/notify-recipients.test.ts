/**
 * Unit tests for taskNotifyRecipients — the recipient set for a task
 * status-change notification (PATCH /api/tasks/[id], site #2).
 *
 * The bug this guards: notifications used to key on created_by ONLY, so a task
 * dispatched by one agent to another never reached the assignee. The fix
 * notifies BOTH, deduped, filtered to bus-CLI-safe agent names. These tests lock
 * that logic so it cannot silently regress to the one-recipient shape.
 *
 * Mocks @/lib/data/tasks so importing the route does not open SQLite (mirrors
 * patch-route.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/data/tasks', () => ({ getTaskById: vi.fn() }));

import { taskNotifyRecipients } from '../route';

describe('taskNotifyRecipients — both parties, deduped, filtered', () => {
  it('notifies BOTH creator and assignee when distinct (the fix), creator first', () => {
    expect(taskNotifyRecipients('chief', 'engineer')).toEqual(['chief', 'engineer']);
  });

  it('DEDUPES a self-created + self-assigned task to a single message', () => {
    expect(taskNotifyRecipients('engineer', 'engineer')).toEqual(['engineer']);
  });

  it('handles a missing side (only creator, or only assignee)', () => {
    expect(taskNotifyRecipients('chief', undefined)).toEqual(['chief']);
    expect(taskNotifyRecipients(undefined, 'engineer')).toEqual(['engineer']);
    expect(taskNotifyRecipients(undefined, undefined)).toEqual([]);
    expect(taskNotifyRecipients('', 'engineer')).toEqual(['engineer']);
  });

  it('filters non-agent recipients (human / dashboard / user) — humans are not paged', () => {
    expect(taskNotifyRecipients('human', 'engineer')).toEqual(['engineer']);
    expect(taskNotifyRecipients('chief', 'dashboard')).toEqual(['chief']);
    expect(taskNotifyRecipients('chief', 'user')).toEqual(['chief']);
    expect(taskNotifyRecipients('human', 'user')).toEqual([]);
  });

  it('filters names that would be unsafe as a bus-CLI positional arg', () => {
    expect(taskNotifyRecipients('Chief', 'engineer')).toEqual(['engineer']);        // uppercase
    expect(taskNotifyRecipients('bad name', 'engineer')).toEqual(['engineer']);      // space
    expect(taskNotifyRecipients('chief;rm -rf', 'engineer')).toEqual(['engineer']);  // shell metachar
    expect(taskNotifyRecipients('../evil', 'engineer')).toEqual(['engineer']);       // traversal
    expect(taskNotifyRecipients('a'.repeat(65), 'engineer')).toEqual(['engineer']);  // too long
  });

  it('is non-vacuous: valid names pass, invalid are dropped, in the same call', () => {
    // If the filter were a no-op, the invalid name would appear; if it dropped
    // everything, the valid one would be missing. Both wrong shapes fail this.
    expect(taskNotifyRecipients('ENGINEER', 'writer')).toEqual(['writer']);
  });
});
