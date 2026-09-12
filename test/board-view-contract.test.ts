import { describe, expect, test } from 'vitest';
import { boardViewStateSchema } from '../contract.js';

/**
 * app.tsx builds the saveBoardView payload with filterStateToPresetState().
 * That call is wrapped in a .catch(), so if the payload ever stops satisfying
 * the contract the board silently forgets its view instead of erroring — the
 * exact symptom "saving doesn't work". These tests pin the shape the UI sends.
 */
function uiPayload(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      version: 1,
      view: 'kanban',
      query: 'downloads',
      stateCategories: ['todo', 'in_progress'],
      statuses: ['Open'],
      assignees: ['Kristof Feys'],
      folders: ['Ticket scope 2'],
      taskLists: ['Todo'],
      labels: [],
      collapsedGroups: { done: true },
      ...overrides
    },
    groupBy: 'taskList'
  };
}

describe('board view payload', () => {
  test('accepts exactly what the board sends', () => {
    const parsed = boardViewStateSchema.parse(uiPayload());
    expect(parsed.groupBy).toBe('taskList');
    expect(parsed.state.folders).toEqual(['Ticket scope 2']);
    expect(parsed.state.view).toBe('kanban');
  });

  test('defaults groupBy so a view saved before lane grouping still loads', () => {
    const { groupBy: _dropped, ...withoutGroupBy } = uiPayload();
    const parsed = boardViewStateSchema.parse(withoutGroupBy);
    expect(parsed.groupBy).toBe('workflowStatus');
  });

  test('defaults folders so a view saved before folders existed still loads', () => {
    const payload = uiPayload();
    delete (payload.state as Record<string, unknown>).folders;
    expect(boardViewStateSchema.parse(payload).state.folders).toEqual([]);
  });

  test('rejects an unknown field rather than storing junk', () => {
    // A strict schema is what makes the .catch() dangerous, so prove the
    // boundary is where we think it is.
    expect(() =>
      boardViewStateSchema.parse(uiPayload({ sortOrder: 'asc' }))
    ).toThrow();
  });

  test('covers every lane grouping the UI can produce', () => {
    for (const groupBy of ['workflowStatus', 'taskList'] as const) {
      const parsed = boardViewStateSchema.parse({
        ...uiPayload(),
        groupBy
      });
      expect(parsed.groupBy).toBe(groupBy);
    }
  });
});
