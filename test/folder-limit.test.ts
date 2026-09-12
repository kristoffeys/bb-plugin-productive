import { expect, test, vi } from 'vitest';
import { createProductiveApi } from '../productive/index.js';

const CREDENTIALS = { apiToken: 'token', organizationId: '9093' };

/**
 * Productive has no `filter[folder_id]` on /tasks, so the folder scope is
 * applied to the mapped results. The regression this guards: applying the
 * caller's `limit` BEFORE that filter silently dropped a folder's tasks
 * whenever they fell outside the newest N tasks project-wide.
 */
function taskRecord(id: number, taskListId: string) {
  return {
    id: String(id),
    type: 'tasks',
    attributes: {
      title: `Task ${id}`,
      task_number: String(id),
      updated_at: `2026-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      tag_list: []
    },
    relationships: {
      task_list: { data: { id: taskListId, type: 'task_lists' } },
      workflow_status: { data: { id: '1', type: 'workflow_statuses' } },
      project: { data: { id: '672212', type: 'projects' } }
    }
  };
}

const INCLUDED = [
  {
    id: '1',
    type: 'workflow_statuses',
    attributes: { name: 'Open', category_id: 2 }
  },
  { id: '672212', type: 'projects', attributes: { name: 'Example project' } },
  // Lane in the folder we want.
  {
    id: 'list-wanted',
    type: 'task_lists',
    attributes: { name: 'Todo' },
    relationships: { folder: { data: { id: 'folder-wanted', type: 'folders' } } }
  },
  // Lane in a different folder.
  {
    id: 'list-other',
    type: 'task_lists',
    attributes: { name: 'Backlog' },
    relationships: { folder: { data: { id: 'folder-other', type: 'folders' } } }
  },
  { id: 'folder-wanted', type: 'folders', attributes: { name: 'Sprint board' } },
  { id: 'folder-other', type: 'folders', attributes: { name: 'Other board' } }
];

test('folder scope survives a small limit', async () => {
  // 60 tasks in another folder come first, then 5 in the folder we want — so
  // a limit applied before the folder filter would return nothing at all.
  const data = [
    ...Array.from({ length: 60 }, (_, index) => taskRecord(index + 1, 'list-other')),
    ...Array.from({ length: 5 }, (_, index) => taskRecord(200 + index, 'list-wanted'))
  ];

  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    return new Response(
      JSON.stringify({
        data,
        included: INCLUDED,
        meta: { current_page: 1, total_pages: 1, total_count: data.length }
      }),
      { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }
    );
  });

  const api = createProductiveApi(CREDENTIALS, { fetchImpl });
  const tasks = await api.listTasks({
    projectId: '672212',
    folderId: 'folder-wanted',
    limit: 10
  });

  expect(tasks).toHaveLength(5);
  expect(tasks.every(task => task.folderId === 'folder-wanted')).toBe(true);
  expect(tasks.every(task => task.folderName === 'Sprint board')).toBe(true);
});

test('an unscoped list still honours the caller limit', async () => {
  const data = Array.from({ length: 40 }, (_, index) =>
    taskRecord(index + 1, 'list-other')
  );
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data,
          included: INCLUDED,
          meta: { current_page: 1, total_pages: 1, total_count: data.length }
        }),
        { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }
      )
  );
  const api = createProductiveApi(CREDENTIALS, { fetchImpl });

  const tasks = await api.listTasks({ projectId: '672212', limit: 10 });
  expect(tasks).toHaveLength(10);
});
