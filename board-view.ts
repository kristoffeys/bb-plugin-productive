// Pure board-presentation helpers for app.tsx.
//
// Ported from the Taskboard plugin's browse.ts, trimmed to this plugin's
// model: three state categories (todo / in_progress / done), no priority, and
// `taskList` where Taskboard had `project`. Everything here is deliberately
// free of React and of `window` so test/app-ui.test.ts can exercise it
// directly.
import type {
  WorkItem,
  WorkStateCategory,
  WorkStatusOption
} from './contract.js';
import { DEFAULT_WORKFLOW_STATUS_ORDER } from './browse.js';

export { DEFAULT_WORKFLOW_STATUS_ORDER };

/** Sentinels for "this facet is empty" so they cannot collide with real text. */
export const UNASSIGNED_ASSIGNEE_FILTER = '__productive_unassigned__';
export const NO_TASK_LIST_FILTER = '__productive_no_task_list__';
export const NO_FOLDER_FILTER = '__productive_no_folder__';
export const NO_LABELS_FILTER = '__productive_no_labels__';

export interface FilterOption {
  value: string;
  label: string;
}

export const ASSIGNEE_AVATAR_TONES = [
  'violet',
  'blue',
  'teal',
  'amber',
  'rose',
  'slate'
] as const;
export type AssigneeAvatarTone = (typeof ASSIGNEE_AVATAR_TONES)[number];

export interface AssigneeAvatarIdentity {
  initials: string;
  tone: AssigneeAvatarTone;
}

/** Initials + a stable tone for an assignee name. Never renders raw markup. */
export function assigneeAvatarIdentity(name: string): AssigneeAvatarIdentity {
  const normalized = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const initials =
    normalized
      .split(' ')
      .flatMap(token => {
        const character = Array.from(token).find(value =>
          /[\p{L}\p{N}]/u.test(value)
        );
        return character ? [character] : [];
      })
      .slice(0, 2)
      .map(character => Array.from(character.toUpperCase())[0] ?? '')
      .join('') || '?';
  let hash = 2166136261;
  for (const character of normalized.toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return {
    initials,
    tone: ASSIGNEE_AVATAR_TONES[(hash >>> 0) % ASSIGNEE_AVATAR_TONES.length]!
  };
}

export interface WorkItemAttributeFilters {
  statuses: readonly string[];
  assignees: readonly string[];
  folders: readonly string[];
  taskLists: readonly string[];
  labels: readonly string[];
}

export interface WorkflowStatus {
  name: string;
  category: WorkStateCategory;
}

export interface WorkflowStatusGroup extends WorkflowStatus {
  key: string;
  items: WorkItem[];
}

export type WorkflowStatusLane = WorkflowStatus & { key: string };

const FALLBACK_WORKFLOW_RANK: Readonly<Record<WorkStateCategory, number>> = {
  in_progress: 0,
  todo: 1,
  done: 2
};

const FALLBACK_STATUS_LABEL: Readonly<Record<WorkStateCategory, string>> = {
  in_progress: 'In progress',
  todo: 'Todo',
  done: 'Done'
};

/**
 * Names that pull an unlisted status towards the right neighbourhood of a
 * persisted `statusOrder`. Productive workflow statuses are org-defined, so a
 * board's order rarely lists every status an item can carry.
 */
const CATEGORY_STATUS_ANCHORS: Readonly<
  Record<WorkStateCategory, readonly string[]>
> = {
  in_progress: ['in progress', 'in review', 'blocked'],
  todo: ['todo', 'backlog'],
  done: ['done', 'closed']
};

function normalizedValue(value: string): string {
  return value
    .trim()
    .replaceAll(/[_-]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .toLocaleLowerCase();
}

function normalizedStatus(value: string): string {
  const normalized = normalizedValue(value);
  return normalized === 'to do' ? 'todo' : normalized;
}

export const WORKFLOW_STATUS_TONES = [
  'review',
  'progress',
  'blocked',
  'qa',
  'todo',
  'duplicate',
  'triage',
  'backlog',
  'done',
  'canceled'
] as const;
export type WorkflowStatusTone = (typeof WORKFLOW_STATUS_TONES)[number];

const EXACT_STATUS_TONES = new Map<string, WorkflowStatusTone>([
  ['in review', 'review'],
  ['review', 'review'],
  ['in progress', 'progress'],
  ['started', 'progress'],
  ['blocked', 'blocked'],
  ['paused', 'blocked'],
  ['qa', 'qa'],
  ['quality assurance', 'qa'],
  ['todo', 'todo'],
  ['open', 'todo'],
  ['duplicate', 'duplicate'],
  ['triage', 'triage'],
  ['backlog', 'backlog'],
  ['done', 'done'],
  ['completed', 'done'],
  ['closed', 'done'],
  ['canceled', 'canceled'],
  ['cancelled', 'canceled']
]);

/** A stable, name-derived tone so a workflow keeps its colours between loads. */
export function workflowStatusTone(
  name: string,
  category: WorkStateCategory
): WorkflowStatusTone {
  const normalized = normalizedStatus(name);
  const exact = EXACT_STATUS_TONES.get(normalized);
  if (exact) return exact;
  let hash = 0;
  for (const character of `${category}:${normalized}`) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return WORKFLOW_STATUS_TONES[hash % WORKFLOW_STATUS_TONES.length]!;
}

function workflowRank(
  status: WorkflowStatus,
  statusOrder: readonly string[]
): number {
  const normalizedOrder = statusOrder.map(normalizedStatus);
  const exactRank = normalizedOrder.indexOf(normalizedStatus(status.name));
  if (exactRank >= 0) return exactRank;

  let categoryAnchor = -1;
  for (const [index, name] of normalizedOrder.entries()) {
    if (CATEGORY_STATUS_ANCHORS[status.category].includes(name)) {
      categoryAnchor = index;
    }
  }
  if (categoryAnchor >= 0) return categoryAnchor + 0.5;

  return statusOrder.length + FALLBACK_WORKFLOW_RANK[status.category];
}

export function compareWorkflowStatuses(
  left: WorkflowStatus,
  right: WorkflowStatus,
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): number {
  return (
    workflowRank(left, statusOrder) - workflowRank(right, statusOrder) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
    left.name.localeCompare(right.name)
  );
}

export function sortWorkItemsByWorkflow(
  items: readonly WorkItem[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkItem[] {
  return [...items].sort((left, right) =>
    compareWorkflowStatuses(
      { name: left.status, category: left.stateCategory },
      { name: right.status, category: right.stateCategory },
      statusOrder
    )
  );
}

export function workflowStatusLaneKey(
  name: string,
  category: WorkStateCategory
): string {
  return `${category}:${normalizedStatus(name)}`;
}

/** List sections: one per workflow status present in `items`. */
export function workflowStatusGroups(
  items: readonly WorkItem[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkflowStatusGroup[] {
  const groups = new Map<string, WorkflowStatusGroup>();
  for (const item of items) {
    const name = item.status.trim() || FALLBACK_STATUS_LABEL[item.stateCategory];
    const key = workflowStatusLaneKey(name, item.stateCategory);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, {
        key,
        name,
        category: item.stateCategory,
        items: [item]
      });
    }
  }
  return [...groups.values()].sort((left, right) =>
    compareWorkflowStatuses(left, right, statusOrder)
  );
}

/**
 * Kanban lanes: every status present in `items`, plus every status the
 * workflow offers (so empty lanes are still droppable), in `statusOrder`.
 */
export function workflowStatusLanes(
  items: readonly WorkItem[],
  discovered: readonly WorkStatusOption[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkflowStatusLane[] {
  const lanes = new Map<string, WorkflowStatusLane>();
  for (const group of workflowStatusGroups(items, statusOrder)) {
    lanes.set(group.key, {
      key: group.key,
      name: group.name,
      category: group.category
    });
  }
  for (const status of discovered) {
    const key = workflowStatusLaneKey(status.name, status.stateCategory);
    if (lanes.has(key)) continue;
    lanes.set(key, { key, name: status.name, category: status.stateCategory });
  }
  return [...lanes.values()].sort((left, right) =>
    compareWorkflowStatuses(left, right, statusOrder)
  );
}

/** The other lane-grouping mode for the kanban board (see `taskListLanes`). */
export const LANE_GROUPINGS = ['workflowStatus', 'taskList'] as const;
export type LaneGrouping = (typeof LANE_GROUPINGS)[number];

export interface TaskListLane {
  key: string;
  name: string;
  taskListId: string | null;
}


export const NO_TASK_LIST_LANE_KEY = '__productive_no_task_list_lane__';

export function taskListLaneKey(taskListId: string | null): string {
  return taskListId ?? NO_TASK_LIST_LANE_KEY;
}

/**
 * Kanban lanes for the "Task list" grouping (Productive's own board layout:
 * one lane per task list). Order follows `taskLists` (i.e. whatever order
 * `listProductiveTaskLists` returned), with a "(No task list)" lane last for
 * items that carry none. Droppable exactly like `workflowStatusLanes`; the
 * "(No task list)" lane's `taskListId` is `null`, which callers must pass
 * straight through to `updateItemTaskList` (see `taskListLaneTarget`).
 */
export function taskListLanes(
  items: readonly WorkItem[],
  taskLists: readonly { id: string; name: string }[]
): TaskListLane[] {
  const lanes: TaskListLane[] = taskLists.map(taskList => ({
    key: taskListLaneKey(taskList.id),
    name: taskList.name,
    taskListId: taskList.id
  }));
  const known = new Set(lanes.map(lane => lane.key));
  let hasNoTaskList = false;
  for (const item of items) {
    if (item.taskListId === null) {
      hasNoTaskList = true;
      continue;
    }
    const key = taskListLaneKey(item.taskListId);
    if (known.has(key)) continue;
    known.add(key);
    lanes.push({ key, name: item.taskList ?? key, taskListId: item.taskListId });
  }
  if (hasNoTaskList) {
    lanes.push({ key: NO_TASK_LIST_LANE_KEY, name: '(No task list)', taskListId: null });
  }
  return lanes;
}

/**
 * Task-list lanes an item can be dropped on — every lane except the one it's
 * already in. `lane.taskListId` is `null` for the "(No task list)" lane, so
 * passing it straight to `updateItemTaskList` clears the task's list; callers
 * must not send `NO_TASK_LIST_LANE_KEY` (the lane `key`) to the server.
 */
export function taskListMoveTargets(
  item: Pick<WorkItem, 'taskListId'>,
  lanes: readonly TaskListLane[]
): readonly TaskListLane[] {
  const currentKey = taskListLaneKey(item.taskListId);
  return lanes.filter(lane => lane.key !== currentKey);
}


function normalizedOptionalValue(
  value: string | null,
  emptyNames: RegExp
): string | null {
  const normalized = value?.trim().replaceAll(/\s+/gu, ' ') ?? '';
  if (!normalized || emptyNames.test(normalized)) return null;
  return normalized;
}

const NEVER_EMPTY = /^$/u;

function normalizedAssignee(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|unassigned)$/iu);
}

function normalizedTaskList(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|no task list)$/iu);
}

function normalizedFolder(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|no folder)$/iu);
}

export function filterOptionIdentity(value: string): string {
  return value.toLocaleLowerCase();
}

/**
 * Productive returns facet text with whatever casing the org typed. A
 * persisted selection must still match after a re-fetch, so selections are
 * folded onto the casing of the option that is currently on screen.
 */
export function canonicalizeSelectedFilterOptions(
  selected: readonly string[],
  options: readonly FilterOption[]
): string[] {
  const canonicalValues = new Map<string, string>();
  for (const option of options) {
    const identity = filterOptionIdentity(option.value);
    if (!canonicalValues.has(identity)) {
      canonicalValues.set(identity, option.value);
    }
  }
  const seen = new Set<string>();
  const canonicalized: string[] = [];
  for (const value of selected) {
    const identity = filterOptionIdentity(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    canonicalized.push(canonicalValues.get(identity) ?? value);
  }
  return canonicalized;
}

export function isFilterOptionSelected(
  selected: readonly string[],
  optionValue: string
): boolean {
  const identity = filterOptionIdentity(optionValue);
  return selected.some(value => filterOptionIdentity(value) === identity);
}

export function toggleFilterOptionSelection(
  selected: readonly string[],
  optionValue: string
): string[] {
  const identity = filterOptionIdentity(optionValue);
  const remaining = selected.filter(
    value => filterOptionIdentity(value) !== identity
  );
  return remaining.length === selected.length
    ? [...selected, optionValue]
    : remaining;
}

function singleValueFilterOptions(
  values: readonly (string | null)[],
  selected: readonly string[],
  normalize: (value: string | null) => string | null,
  emptyToken?: string,
  emptyLabel?: string
): FilterOption[] {
  const options = new Map<string, FilterOption>();
  let hasEmpty = false;
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) {
      hasEmpty = true;
      continue;
    }
    const identity = filterOptionIdentity(normalized);
    if (!options.has(identity)) {
      options.set(identity, { value: normalized, label: normalized });
    }
  }
  for (const value of selected) {
    if (emptyToken && value === emptyToken) {
      hasEmpty = true;
      continue;
    }
    const normalized = normalize(value);
    if (!normalized) continue;
    const identity = filterOptionIdentity(normalized);
    if (!options.has(identity)) {
      options.set(identity, { value: normalized, label: normalized });
    }
  }
  const sorted = [...options.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
  if (hasEmpty && emptyToken && emptyLabel) {
    sorted.push({ value: emptyToken, label: emptyLabel });
  }
  return sorted;
}

export function statusFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = [],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): FilterOption[] {
  const categories = new Map<string, WorkStateCategory>();
  for (const item of items) {
    categories.set(filterOptionIdentity(item.status.trim()), item.stateCategory);
  }
  return singleValueFilterOptions(
    items.map(item => item.status),
    selected,
    value => normalizedOptionalValue(value, NEVER_EMPTY)
  ).sort((left, right) =>
    compareWorkflowStatuses(
      {
        name: left.label,
        category: categories.get(filterOptionIdentity(left.value)) ?? 'todo'
      },
      {
        name: right.label,
        category: categories.get(filterOptionIdentity(right.value)) ?? 'todo'
      },
      statusOrder
    )
  );
}

export function assigneeFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.assignee),
    selected,
    normalizedAssignee,
    UNASSIGNED_ASSIGNEE_FILTER,
    'Unassigned'
  );
}

export function taskListFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.taskList),
    selected,
    normalizedTaskList,
    NO_TASK_LIST_FILTER,
    'No task list'
  );
}

export function folderFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.folder),
    selected,
    normalizedFolder,
    NO_FOLDER_FILTER,
    'No folder'
  );
}

export function labelFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  const options = singleValueFilterOptions(
    items.flatMap(item => item.labels),
    selected.filter(label => label !== NO_LABELS_FILTER),
    value => normalizedOptionalValue(value, NEVER_EMPTY)
  );
  if (
    (items.some(item => item.labels.every(label => !label.trim())) ||
      selected.includes(NO_LABELS_FILTER)) &&
    !options.some(option => option.value === NO_LABELS_FILTER)
  ) {
    options.push({ value: NO_LABELS_FILTER, label: 'No labels' });
  }
  return options;
}

function matchesSingleValueFilter(
  value: string | null,
  selected: readonly string[],
  normalize: (value: string | null) => string | null,
  emptyToken?: string
): boolean {
  if (selected.length === 0) return true;
  const normalized = normalize(value);
  if (!normalized) return emptyToken ? selected.includes(emptyToken) : false;
  const selectedValues = new Set(
    selected
      .filter(candidate => candidate !== emptyToken)
      .map(candidate => normalize(candidate))
      .filter((candidate): candidate is string => candidate !== null)
      .map(filterOptionIdentity)
  );
  return selectedValues.has(filterOptionIdentity(normalized));
}

/** Every facet is AND-ed; values inside one facet are OR-ed. */
export function filterWorkItemsByAttributes(
  items: readonly WorkItem[],
  filters: WorkItemAttributeFilters
): WorkItem[] {
  const selectedLabels = new Set(
    filters.labels
      .filter(label => label !== NO_LABELS_FILTER)
      .map(filterOptionIdentity)
  );
  const includeNoLabels = filters.labels.includes(NO_LABELS_FILTER);

  return items.filter(item => {
    if (
      !matchesSingleValueFilter(item.status, filters.statuses, value =>
        normalizedOptionalValue(value, NEVER_EMPTY)
      ) ||
      !matchesSingleValueFilter(
        item.assignee,
        filters.assignees,
        normalizedAssignee,
        UNASSIGNED_ASSIGNEE_FILTER
      ) ||
      !matchesSingleValueFilter(
        item.folder,
        filters.folders,
        normalizedFolder,
        NO_FOLDER_FILTER
      ) ||
      !matchesSingleValueFilter(
        item.taskList,
        filters.taskLists,
        normalizedTaskList,
        NO_TASK_LIST_FILTER
      )
    ) {
      return false;
    }
    if (filters.labels.length === 0) return true;
    const labels = item.labels
      .map(label => label.trim())
      .filter(Boolean)
      .map(filterOptionIdentity);
    return labels.length === 0
      ? includeNoLabels
      : labels.some(label => selectedLabels.has(label));
  });
}

/** Done groups start collapsed; everything else starts open. */
export function defaultGroupCollapsed(category: WorkStateCategory): boolean {
  return category === 'done';
}

export function isGroupCollapsed({
  overrides,
  groupKey,
  category,
  searchActive = false
}: {
  overrides: Readonly<Record<string, boolean>>;
  groupKey: string;
  category: WorkStateCategory;
  searchActive?: boolean;
}): boolean {
  if (searchActive) return false;
  return overrides[groupKey] ?? defaultGroupCollapsed(category);
}

export function toggleGroupCollapsedOverride(
  overrides: Readonly<Record<string, boolean>>,
  groupKey: string,
  category: WorkStateCategory
): Record<string, boolean> {
  const collapsed = overrides[groupKey] ?? defaultGroupCollapsed(category);
  const next = { ...overrides };
  if (!collapsed === defaultGroupCollapsed(category)) {
    delete next[groupKey];
  } else {
    next[groupKey] = !collapsed;
  }
  return next;
}

/** Renders an attachment's byte size as e.g. "0 B", "482 KB", "3.1 MB". */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}
