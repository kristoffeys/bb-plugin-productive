import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  NO_FOLDER_FILTER,
  NO_LABELS_FILTER,
  NO_TASK_LIST_FILTER,
  NO_TASK_LIST_LANE_KEY,
  UNASSIGNED_ASSIGNEE_FILTER,
  assigneeFilterOptions,
  filterWorkItemsByAttributes,
  folderFilterOptions,
  formatAttachmentSize,
  isGroupCollapsed,
  sortWorkItemsByWorkflow,
  statusFilterOptions,
  taskListLanes,
  taskListMoveTargets,
  toggleFilterOptionSelection,
  toggleGroupCollapsedOverride,
  workflowStatusGroups,
  workflowStatusLanes,
  workflowStatusTone
} from '../board-view.ts';
import type { WorkItem, WorkStatusOption } from '../contract.ts';

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: 'proj_a',
    locator: '1',
    key: '#1',
    title: 'Task',
    description: '',
    url: 'https://app.productive.io/org/task/1',
    status: 'To Do',
    statusId: 's1',
    stateCategory: 'todo',
    assignee: null,
    assigneeId: null,
    project: 'Website',
    productiveProjectId: 'pp1',
    taskList: null,
    taskListId: null,
    folder: null,
    folderId: null,
    labels: [],
    dueDate: null,
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('workflowStatusGroups groups by workflow status and orders by category', () => {
  const items = [
    item({ locator: '1', status: 'Done', stateCategory: 'done' }),
    item({ locator: '2', status: 'In Progress', stateCategory: 'in_progress' }),
    item({ locator: '3', status: 'To Do', stateCategory: 'todo' }),
    item({ locator: '4', status: 'In Progress', stateCategory: 'in_progress' })
  ];
  const groups = workflowStatusGroups(items);
  // DEFAULT_WORKFLOW_STATUS_ORDER is ['To Do', 'In Progress', 'Done'].
  assert.deepEqual(
    groups.map(group => group.name),
    ['To Do', 'In Progress', 'Done']
  );
  assert.equal(groups.find(group => group.name === 'In Progress')?.items.length, 2);
});

test('sortWorkItemsByWorkflow follows the persisted status order first', () => {
  const items = [
    item({ locator: '1', status: 'Blocked', stateCategory: 'in_progress' }),
    item({ locator: '2', status: 'Backlog', stateCategory: 'todo' }),
    item({ locator: '3', status: 'Done', stateCategory: 'done' })
  ];
  const sorted = sortWorkItemsByWorkflow(items, ['Backlog', 'Blocked', 'Done']);
  assert.deepEqual(
    sorted.map(entry => entry.locator),
    ['2', '1', '3']
  );
});

test('workflowStatusLanes includes discovered statuses with no items so they stay droppable', () => {
  const items = [item({ locator: '1', status: 'To Do', stateCategory: 'todo' })];
  const discovered: WorkStatusOption[] = [
    { id: 's-todo', name: 'To Do', stateCategory: 'todo', current: true },
    { id: 's-review', name: 'In Review', stateCategory: 'in_progress', current: false }
  ];
  const lanes = workflowStatusLanes(items, discovered);
  assert.deepEqual(
    lanes.map(lane => lane.name),
    ['To Do', 'In Review']
  );
});

test('taskListLanes orders lanes like listProductiveTaskLists and puts "(No task list)" last', () => {
  const items = [
    item({ locator: '1', taskList: 'Backlog', taskListId: 'tl-2' }),
    item({ locator: '2', taskList: null, taskListId: null }),
    item({ locator: '3', taskList: 'Sprint 1', taskListId: 'tl-1' })
  ];
  const lanes = taskListLanes(items, [
    { id: 'tl-1', name: 'Sprint 1' },
    { id: 'tl-2', name: 'Backlog' }
  ]);
  assert.deepEqual(
    lanes.map(lane => lane.key),
    ['tl-1', 'tl-2', NO_TASK_LIST_LANE_KEY]
  );
  assert.equal(lanes.at(-1)?.name, '(No task list)');
});

test('taskListLanes omits the "(No task list)" lane when every item has a task list', () => {
  const items = [item({ locator: '1', taskList: 'Sprint 1', taskListId: 'tl-1' })];
  const lanes = taskListLanes(items, [{ id: 'tl-1', name: 'Sprint 1' }]);
  assert.deepEqual(
    lanes.map(lane => lane.key),
    ['tl-1']
  );
});

test('taskListMoveTargets excludes the item\'s current lane', () => {
  const lanes = taskListLanes(
    [item({ locator: '1', taskList: 'Sprint 1', taskListId: 'tl-1' })],
    [
      { id: 'tl-1', name: 'Sprint 1' },
      { id: 'tl-2', name: 'Backlog' }
    ]
  );
  const targets = taskListMoveTargets({ taskListId: 'tl-1' }, lanes);
  assert.deepEqual(
    targets.map(lane => lane.key),
    ['tl-2']
  );
});

test('taskListMoveTargets maps the "(No task list)" lane to a null taskListId, not the sentinel key', () => {
  const lanes = taskListLanes(
    [item({ locator: '1', taskList: null, taskListId: null })],
    [{ id: 'tl-1', name: 'Sprint 1' }]
  );
  const targets = taskListMoveTargets({ taskListId: 'tl-1' }, lanes);
  const noListTarget = targets.find(lane => lane.key === NO_TASK_LIST_LANE_KEY);
  assert.equal(noListTarget?.taskListId, null);
});

test('folderFilterOptions surfaces a "No folder" sentinel', () => {
  const items = [
    item({ locator: '1', folder: 'Website' }),
    item({ locator: '2', folder: null })
  ];
  const options = folderFilterOptions(items);
  assert.ok(options.some(option => option.value === 'Website'));
  assert.ok(options.some(option => option.value === NO_FOLDER_FILTER));
});

test('workflowStatusTone is stable for a known status name and derived otherwise', () => {
  assert.equal(workflowStatusTone('In Review', 'in_progress'), 'review');
  assert.equal(workflowStatusTone('Done', 'done'), 'done');
  const first = workflowStatusTone('Some Custom Status', 'todo');
  const second = workflowStatusTone('Some Custom Status', 'todo');
  assert.equal(first, second);
});

test('statusFilterOptions and assigneeFilterOptions surface an unassigned/empty sentinel', () => {
  const items = [
    item({ locator: '1', status: 'To Do', assignee: 'Ada Lovelace' }),
    item({ locator: '2', status: 'To Do', assignee: null })
  ];
  const statuses = statusFilterOptions(items);
  assert.deepEqual(statuses.map(option => option.value), ['To Do']);

  const assignees = assigneeFilterOptions(items);
  assert.ok(assignees.some(option => option.value === UNASSIGNED_ASSIGNEE_FILTER));
  assert.ok(assignees.some(option => option.value === 'Ada Lovelace'));
});

test('toggleFilterOptionSelection adds then removes a value, case-insensitively', () => {
  const withValue = toggleFilterOptionSelection([], 'Ada Lovelace');
  assert.deepEqual(withValue, ['Ada Lovelace']);
  const removed = toggleFilterOptionSelection(withValue, 'ada lovelace');
  assert.deepEqual(removed, []);
});

test('filterWorkItemsByAttributes ANDs facets and ORs values within a facet', () => {
  const items = [
    item({ locator: '1', assignee: 'Ada Lovelace', taskList: 'Sprint 1', labels: ['bug'] }),
    item({ locator: '2', assignee: 'Grace Hopper', taskList: 'Sprint 1', labels: [] }),
    item({ locator: '3', assignee: 'Ada Lovelace', taskList: null, labels: ['bug'] })
  ];
  const filtered = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: ['Ada Lovelace'],
    folders: [],
    taskLists: ['Sprint 1'],
    labels: []
  });
  assert.deepEqual(
    filtered.map(entry => entry.locator),
    ['1']
  );

  const noTaskList = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: [],
    folders: [],
    taskLists: [NO_TASK_LIST_FILTER],
    labels: []
  });
  assert.deepEqual(
    noTaskList.map(entry => entry.locator),
    ['3']
  );

  const noLabels = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: [],
    folders: [],
    taskLists: [],
    labels: [NO_LABELS_FILTER]
  });
  assert.deepEqual(
    noLabels.map(entry => entry.locator),
    ['2']
  );
});

test('filterWorkItemsByAttributes filters by folder', () => {
  const items = [
    item({ locator: '1', folder: 'Website' }),
    item({ locator: '2', folder: 'Mobile app' }),
    item({ locator: '3', folder: null })
  ];
  const filtered = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: [],
    folders: ['Website'],
    taskLists: [],
    labels: []
  });
  assert.deepEqual(
    filtered.map(entry => entry.locator),
    ['1']
  );

  const noFolder = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: [],
    folders: [NO_FOLDER_FILTER],
    taskLists: [],
    labels: []
  });
  assert.deepEqual(
    noFolder.map(entry => entry.locator),
    ['3']
  );
});

test('isGroupCollapsed defaults done groups to collapsed and respects overrides and search', () => {
  assert.equal(
    isGroupCollapsed({ overrides: {}, groupKey: 'done:done', category: 'done' }),
    true
  );
  assert.equal(
    isGroupCollapsed({ overrides: {}, groupKey: 'todo:todo', category: 'todo' }),
    false
  );
  const overrides = toggleGroupCollapsedOverride({}, 'done:done', 'done');
  assert.equal(
    isGroupCollapsed({ overrides, groupKey: 'done:done', category: 'done' }),
    false
  );
  assert.equal(
    isGroupCollapsed({
      overrides,
      groupKey: 'done:done',
      category: 'done',
      searchActive: true
    }),
    false
  );
});

test('formatAttachmentSize renders bytes, KB, and MB ranges', () => {
  assert.equal(formatAttachmentSize(0), '0 B');
  assert.equal(formatAttachmentSize(512), '512 B');
  assert.equal(formatAttachmentSize(493_568), '482 KB');
  assert.equal(formatAttachmentSize(3_250_586), '3.1 MB');
});
