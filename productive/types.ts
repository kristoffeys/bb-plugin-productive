// Domain types for the Productive.io API layer. Productive is a single-org
// JSON:API provider (one API token -> one organization), so everything below is
// scoped by the credentials handed to `createProductiveApi`.
//
// These are the API layer's OWN types; contract.ts owns the wire shapes
// (WorkItem etc.) and validates whatever server.ts derives from these.

export type ProductiveRecord = Record<string, unknown>

/** Same three buckets contract.ts's workStateCategorySchema enumerates. */
export type ProductiveStateCategory = 'todo' | 'in_progress' | 'done'

export type ProductiveProject = {
  id: string
  name: string
  /** Productive's per-org sequential `project_number`. */
  number?: number
}

export type ProductiveTaskList = {
  id: string
  name: string
  projectId?: string
  folderId?: string
  folderName?: string
}

/** A Productive "folder" — what Productive used to call a "board". Its task
 *  lists are the columns. */
export type ProductiveFolder = {
  id: string
  name: string
  archived: boolean
}

export type ProductivePerson = {
  id: string
  name: string
  email?: string
  avatarUrl?: string
}

export type ProductiveWorkflowStatus = {
  id: string
  name: string
  /** Productive `category_id`: 1 = Not Started, 2 = Started, 3 = Closed. */
  categoryId: number
  stateCategory: ProductiveStateCategory
  color?: string
}

export type ProductiveTask = {
  /** Productive task id — the locator used everywhere in the plugin. */
  id: string
  /** Per-project sequential counter (`task_number`), rendered as the key. */
  taskNumber?: number
  /** Human display identifier, e.g. "#412". */
  key: string
  title: string
  /** Markdown, converted from Productive's HTML body. */
  description: string
  url: string
  organizationId: string
  project: ProductiveProject
  taskListId?: string
  taskList?: ProductiveTaskList
  folderId?: string
  folderName?: string
  status: ProductiveWorkflowStatus
  assignee?: ProductivePerson
  /** Present even when the assignee record was not side-loaded. */
  assigneeId?: string
  labels: string[]
  dueDate?: string
  createdAt: string
  updatedAt: string
}

export type ProductiveAttachment = {
  id: string
  name: string
  /** e.g. "image/png"; '' when Productive omits it. */
  contentType: string
  /** Bytes; 0 when unknown. */
  size: number
  /** Opens in a logged-in browser — the API token cannot fetch these bytes. */
  url: string
  thumbUrl?: string
  isImage: boolean
  createdAt: string
  attachedTo: 'task' | 'comment'
  commentId?: string
}

export type ProductiveComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  user?: ProductivePerson
  attachments: ProductiveAttachment[]
}

export type ProductiveTaskStatusFilter = 'open' | 'closed' | 'all'

export type ProductiveListTasksArgs = {
  projectId?: string
  taskListId?: string
  /** Filtered client-side after mapping — see api.ts's `listTasks` comment for why. */
  folderId?: string
  assigneeId?: string
  status?: ProductiveTaskStatusFilter
  limit?: number
}

export type ProductiveCreateTaskArgs = {
  projectId: string
  taskListId?: string
  title: string
  /** Markdown; converted to HTML before it is sent. */
  description?: string
  assigneeId?: string
  workflowStatusId?: string
  /** ISO date, YYYY-MM-DD. */
  dueDate?: string
}

export type ProductiveTaskUpdate = {
  /** Moves the task between the board's task-list lanes. */
  taskListId?: string | null
  title?: string
  /** Markdown; converted to HTML before it is sent. `null` clears the body. */
  description?: string | null
  assigneeId?: string | null
  workflowStatusId?: string | null
}
