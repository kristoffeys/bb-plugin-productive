// The Productive operations the rest of the plugin uses, built on the transport
// in client.ts. Everything returns domain types from types.ts and throws
// ProductiveApiError on any non-2xx.
import {
  createTransport,
  withPageParams,
  ProductiveApiError,
  type JsonApiResponse,
  type ProductiveCredentials
} from './client'
import {
  asRecord,
  asString,
  buildIncludedLookup,
  isAttachmentDeleted,
  mapAttachment,
  mapComment,
  mapFolder,
  mapPerson,
  mapProductiveTask,
  mapProject,
  mapTaskList,
  mapWorkflowStatus,
  markdownToBody,
  relationshipId,
  taskUrl
} from './mapper'
import type {
  ProductiveAttachment,
  ProductiveComment,
  ProductiveCreateTaskArgs,
  ProductiveFolder,
  ProductiveListTasksArgs,
  ProductivePerson,
  ProductiveProject,
  ProductiveRecord,
  ProductiveTask,
  ProductiveTaskList,
  ProductiveTaskUpdate,
  ProductiveWorkflowStatus
} from './types'

/** Only used when Productive's upload policy omits its own bucket URL. */
const S3_UPLOAD_FALLBACK_URL = 'https://productive-files-production.s3.eu-west-1.amazonaws.com'

/** Verified against the live API: this include set resolves assignee, status,
 *  project, task-list and (via the nested `task_list.folder` hop) folder names
 *  in one call, so lists need no N+1 follow-ups. */
const TASK_INCLUDE = 'assignee,workflow_status,project,task_list.folder'

// Why: Productive's task `status` filter expects an INTEGER — 1 = open,
// 2 = closed. Passing 'open'/'closed' returns 400 "Expected a value of type
// 'Integer'".
const STATUS_OPEN = '1'
const STATUS_CLOSED = '2'

const DEFAULT_LIMIT = 100
/**
 * Ceiling for a whole-board sync. Productive caps a page at 200, so this is 25
 * requests worst case. The old 100-task default silently truncated any busy
 * project — Lemahieu alone has 270 open tasks.
 */
export const BOARD_TASK_LIMIT = 5000
const MAX_PAGE_SIZE = 200

function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  return Math.min(
    Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback),
    BOARD_TASK_LIMIT
  )
}

function sortAndLimitTasks(tasks: ProductiveTask[], limit: number): ProductiveTask[] {
  return tasks
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

function singleRecord(response: JsonApiResponse | null): ProductiveRecord {
  return response && !Array.isArray(response.data) ? asRecord(response.data) : {}
}

/** Folders and task_lists both carry `archived_at`; set means archived. */
function isArchived(record: ProductiveRecord): boolean {
  const archivedAt = asRecord(record.attributes).archived_at
  return archivedAt !== undefined && archivedAt !== null
}

export interface ProductiveApi {
  readonly organizationId: string

  /** Tasks matching the given filters, newest-updated first. */
  listTasks(args?: ProductiveListTasksArgs): Promise<ProductiveTask[]>
  /** Free-text search across tasks (Productive `filter[query]`). */
  searchTasks(query: string, limit?: number): Promise<ProductiveTask[]>
  /** A single task, or null when Productive has no task with that id. */
  getTask(taskId: string): Promise<ProductiveTask | null>
  createTask(args: ProductiveCreateTaskArgs): Promise<ProductiveTask>
  updateTask(taskId: string, updates: ProductiveTaskUpdate): Promise<ProductiveTask>
  /** Moves a task and its comments to Productive's recoverable recycle bin. */
  archiveTask(taskId: string): Promise<void>
  addTaskComment(taskId: string, body: string): Promise<ProductiveComment>
  getTaskComments(taskId: string): Promise<ProductiveComment[]>
  /** Attachments on the task itself (not those on its comments). */
  listTaskAttachments(taskId: string): Promise<ProductiveAttachment[]>

  /** Upload a file and attach it to a task. Productive's flow is create the
   *  attachment record, POST the bytes to the S3 bucket its `aws_policy`
   *  describes, hand the resulting URL back, then link it to the task. */
  uploadTaskAttachment(
    taskId: string,
    file: { name: string; contentType: string; bytes: Uint8Array }
  ): Promise<string>
  uploadCommentAttachment(
    commentId: string,
    file: { name: string; contentType: string; bytes: Uint8Array }
  ): Promise<string>

  listProjects(args?: { query?: string; limit?: number }): Promise<ProductiveProject[]>
  listTaskLists(
    projectId: string,
    options?: { folderId?: string; includeArchived?: boolean }
  ): Promise<ProductiveTaskList[]>
  /** Folders — what Productive used to call a "board". Excludes archived
   *  folders by default. */
  listFolders(projectId: string, options?: { includeArchived?: boolean }): Promise<ProductiveFolder[]>
  /** The workflow a project is attached to — the scope for its status set. */
  getProjectWorkflowId(productiveProjectId: string): Promise<string | null>
  /** Statuses for one workflow. Unscoped, Productive returns every workflow's
   *  statuses, which is wrong for a per-project board. */
  listWorkflowStatuses(args?: { workflowId?: string }): Promise<ProductiveWorkflowStatus[]>
  listAssignablePeople(args?: {
    query?: string
    projectId?: string
    preferredPersonId?: string
  }): Promise<ProductivePerson[]>
  /** One person by id. Cheaper than paging everyone to resolve a name. */
  getPerson(personId: string): Promise<ProductivePerson | null>
}

export function createProductiveApi(
  credentials: ProductiveCredentials,
  options?: { fetchImpl?: typeof fetch }
): ProductiveApi {
  const transport = createTransport(credentials, options)
  const { organizationId } = transport
  // The S3 upload is a different host with form-data, so it bypasses the
  // JSON:API transport and uses the raw fetch directly.
  const doFetch = options?.fetchImpl ?? globalThis.fetch

  async function getTask(taskId: string): Promise<ProductiveTask | null> {
    const response = await transport.request<JsonApiResponse>(
      `/tasks/${encodeURIComponent(taskId)}?include=${TASK_INCLUDE}`
    )
    const data = singleRecord(response)
    if (!asString(data.id)) {
      return null
    }
    return mapProductiveTask(organizationId, data, response?.included)
  }

  async function uploadAttachment(
    target: { type: 'task' | 'comment'; id: string },
    file: { name: string; contentType: string; bytes: Uint8Array }
  ): Promise<string> {
    const name = file.name.trim() || 'attachment'
    const created = await transport.request<JsonApiResponse>('/attachments', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'attachments',
          attributes: {
            name,
            content_type: file.contentType,
            size: file.bytes.byteLength,
            attachable_type: target.type
          }
        }
      })
    })
    const record = singleRecord(created)
    const attachmentId = asString(record.id)
    const policy = asRecord(asRecord(record.attributes).aws_policy)
    const bucketUrl = asString(policy.url) || asString(asRecord(record.attributes).upload_url)
    if (!attachmentId || Object.keys(policy).length === 0) {
      throw new ProductiveApiError(
        `Productive did not return an upload policy for ${name}.`,
        null
      )
    }

    // Everything in aws_policy except `url` is an S3 form field; the file
    // must come last or S3 ignores the fields that follow it.
    const form = new FormData()
    for (const [key, value] of Object.entries(policy)) {
      if (key === 'url' || value === null || value === undefined) continue
      form.append(key, String(value))
    }
    form.append('File', new Blob([file.bytes as BlobPart], { type: file.contentType }), name)
    const targetUrl = bucketUrl || S3_UPLOAD_FALLBACK_URL
    const uploaded = await doFetch(targetUrl, { method: 'POST', body: form })
    if (!uploaded.ok) {
      throw new ProductiveApiError(
        `Uploading ${name} to storage failed (${uploaded.status}).`,
        uploaded.status
      )
    }
    const location =
      uploaded.headers.get('location') ??
      `${targetUrl.replace(/\/$/, '')}/${encodeURI(asString(policy.key))}`

    await transport.request<JsonApiResponse>(
      `/attachments/${encodeURIComponent(attachmentId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          data: { type: 'attachments', attributes: { temp_url: location } }
        })
      }
    )
    await transport.request<JsonApiResponse>(
      `/${target.type}s/${encodeURIComponent(target.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: `${target.type}s`,
            id: target.id,
            relationships: {
              attachments: { data: [{ type: 'attachments', id: attachmentId }] }
            }
          }
        })
      }
    )
    return attachmentId
  }

  /** Re-read a task after a mutation so callers always get the server's view
   *  (status name, updated_at) rather than the thin PATCH/POST echo. */
  async function reloadTask(taskId: string): Promise<ProductiveTask> {
    const task = await getTask(taskId)
    if (!task) {
      throw new ProductiveApiError(`Productive task ${taskId} could not be read back.`, null)
    }
    return task
  }

  async function listTasksPaged(
    query: URLSearchParams,
    limit: number,
    keep?: (task: ProductiveTask) => boolean
  ): Promise<ProductiveTask[]> {
    // With a post-fetch predicate the page budget cannot be `limit` — the
    // matching tasks may be spread across the whole result set — so pull up to
    // the board ceiling and let the predicate decide what survives.
    const fetchBudget = keep === undefined ? limit : BOARD_TASK_LIMIT
    const { records, included } = await transport.fetchPaged(
      (page, pageSize) =>
        withPageParams(`/tasks?${query.toString()}&include=${TASK_INCLUDE}`, page, pageSize),
      { pageSize: Math.min(fetchBudget, MAX_PAGE_SIZE), maxRecords: fetchBudget }
    )
    const mapped = records.map((record) => mapProductiveTask(organizationId, record, included))
    const tasks = keep === undefined ? mapped : mapped.filter(keep)
    return sortAndLimitTasks(tasks, limit)
  }

  return {
    organizationId,

    async listTasks(args: ProductiveListTasksArgs = {}): Promise<ProductiveTask[]> {
      const limit = clampLimit(args.limit)
      const params = new URLSearchParams()
      params.set('sort', '-updated_at')
      if (args.projectId) {
        params.set('filter[project_id]', args.projectId)
      }
      if (args.taskListId) {
        params.set('filter[task_list_id]', args.taskListId)
      }
      if (args.assigneeId) {
        params.set('filter[assignee_id]', args.assigneeId)
      }
      const status = args.status ?? 'open'
      if (status === 'open') {
        params.set('filter[status]', STATUS_OPEN)
      } else if (status === 'closed') {
        params.set('filter[status]', STATUS_CLOSED)
      }
      // Why client-side, not `filter[folder_id]`: Productive's /tasks endpoint
      // has no folder filter, and TASK_INCLUDE already resolves each task's
      // folderId for free via the nested `task_list.folder` include — so
      // filtering the already-mapped list costs zero extra requests, versus
      // an extra listTaskLists round-trip to resolve folder -> task list ids.
      //
      // The folder filter runs BEFORE the limit is applied. Truncating first
      // would silently drop a folder's tasks whenever they fall outside the
      // newest `limit` tasks project-wide.
      const folderId = args.folderId
      return listTasksPaged(
        params,
        limit,
        folderId === undefined
          ? undefined
          : (task) => task.folderId === folderId
      )
    },

    async searchTasks(query: string, limit?: number): Promise<ProductiveTask[]> {
      const trimmed = query.trim()
      if (!trimmed) {
        return []
      }
      const params = new URLSearchParams()
      params.set('filter[query]', trimmed)
      params.set('sort', '-updated_at')
      return listTasksPaged(params, clampLimit(limit, 30))
    },

    getTask,

    async uploadTaskAttachment(
      taskId: string,
      file: { name: string; contentType: string; bytes: Uint8Array }
    ): Promise<string> {
      return uploadAttachment({ type: 'task', id: taskId }, file)
    },

    async uploadCommentAttachment(
      commentId: string,
      file: { name: string; contentType: string; bytes: Uint8Array }
    ): Promise<string> {
      return uploadAttachment({ type: 'comment', id: commentId }, file)
    },

    async createTask(args: ProductiveCreateTaskArgs): Promise<ProductiveTask> {
      const title = args.title.trim()
      if (!title) {
        throw new ProductiveApiError('A task title is required.')
      }
      if (!args.projectId) {
        throw new ProductiveApiError('A Productive project is required to create a task.')
      }
      const attributes: ProductiveRecord = { title }
      if (args.description?.trim()) {
        attributes.description = markdownToBody(args.description.trim())
      }
      const relationships: ProductiveRecord = {
        project: { data: { type: 'projects', id: args.projectId } }
      }
      if (args.taskListId) {
        relationships.task_list = { data: { type: 'task_lists', id: args.taskListId } }
      }
      if (args.assigneeId) {
        relationships.assignee = { data: { type: 'people', id: args.assigneeId } }
      }
      if (args.workflowStatusId) {
        relationships.workflow_status = {
          data: { type: 'workflow_statuses', id: args.workflowStatusId }
        }
      }
      if (args.dueDate) {
        attributes.due_date = args.dueDate
      }
      const response = await transport.request<JsonApiResponse>('/tasks', {
        method: 'POST',
        body: JSON.stringify({ data: { type: 'tasks', attributes, relationships } })
      })
      const data = singleRecord(response)
      const id = asString(data.id)
      if (!id) {
        throw new ProductiveApiError('Productive did not return an id for the created task.')
      }
      // The POST response carries no `included[]`, so read the task back to get
      // resolved status/assignee/project names.
      return (await getTask(id)) ?? mapProductiveTask(organizationId, data)
    },

    async updateTask(taskId: string, updates: ProductiveTaskUpdate): Promise<ProductiveTask> {
      const attributes: ProductiveRecord = {}
      if (updates.title !== undefined) {
        attributes.title = updates.title
      }
      if (updates.description !== undefined) {
        attributes.description = updates.description ? markdownToBody(updates.description) : ''
      }
      const relationships: ProductiveRecord = {}
      if (updates.assigneeId !== undefined) {
        // Why: assignee and status changes both flow through the JSON:API
        // relationships block on PATCH /tasks/{id}.
        relationships.assignee = updates.assigneeId
          ? { data: { type: 'people', id: updates.assigneeId } }
          : { data: null }
      }
      if (updates.workflowStatusId !== undefined) {
        relationships.workflow_status = updates.workflowStatusId
          ? { data: { type: 'workflow_statuses', id: updates.workflowStatusId } }
          : { data: null }
      }
      if (updates.taskListId !== undefined) {
        relationships.task_list = updates.taskListId
          ? { data: { type: 'task_lists', id: updates.taskListId } }
          : { data: null }
      }
      const data: ProductiveRecord = { type: 'tasks', id: taskId }
      if (Object.keys(attributes).length > 0) {
        data.attributes = attributes
      }
      if (Object.keys(relationships).length > 0) {
        data.relationships = relationships
      }
      if (!data.attributes && !data.relationships) {
        return reloadTask(taskId)
      }
      await transport.request(`/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ data })
      })
      return reloadTask(taskId)
    },

    async archiveTask(taskId: string): Promise<void> {
      if (!taskId) {
        throw new ProductiveApiError('A task id is required.')
      }
      await transport.request(`/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE'
      })
    },

    async addTaskComment(taskId: string, body: string): Promise<ProductiveComment> {
      const attributes = body.trim() ? { body: markdownToBody(body) } : {}
      const response = await transport.request<JsonApiResponse>('/comments', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'comments',
            attributes,
            relationships: { task: { data: { type: 'tasks', id: taskId } } }
          }
        })
      })
      return mapComment(singleRecord(response))
    },

    async getTaskComments(taskId: string): Promise<ProductiveComment[]> {
      const { records, included } = await transport.fetchPaged((page, pageSize) =>
        withPageParams(
          `/comments?filter[task_id]=${encodeURIComponent(taskId)}&include=creator,attachments&sort=created_at`,
          page,
          pageSize
        )
      )
      const lookup = buildIncludedLookup(included)
      // Attachments side-load in `included[]` as `attachments` records; group
      // them by the comment they point at via their `comment` relationship.
      const attachmentById = new Map<string, ProductiveAttachment>()
      const attachmentsByCommentId = new Map<string, ProductiveAttachment[]>()
      for (const included_record of included) {
        if (asString(included_record.type) !== 'attachments' || isAttachmentDeleted(included_record)) {
          continue
        }
        const attachment = mapAttachment(included_record, lookup)
        attachmentById.set(attachment.id, attachment)
        if (!attachment.commentId) {
          continue
        }
        const bucket = attachmentsByCommentId.get(attachment.commentId) ?? []
        bucket.push(attachment)
        attachmentsByCommentId.set(attachment.commentId, bucket)
      }
      return records.map((record) => {
        const commentId = asString(record.id)
        const relationshipData = asRecord(asRecord(record.relationships).attachments).data
        const relationshipAttachments = Array.isArray(relationshipData)
          ? relationshipData
              .map(entry => attachmentById.get(asString(asRecord(entry).id)))
              .filter((attachment): attachment is ProductiveAttachment => attachment !== undefined)
          : []
        const attachments = relationshipAttachments.length > 0
          ? relationshipAttachments
          : (attachmentsByCommentId.get(commentId) ?? [])
        return mapComment(record, lookup, attachments)
      })
    },

    async listTaskAttachments(taskId: string): Promise<ProductiveAttachment[]> {
      const { records } = await transport.fetchPaged((page, pageSize) =>
        withPageParams(
          `/attachments?filter[task_id]=${encodeURIComponent(taskId)}`,
          page,
          pageSize
        )
      )
      return records.filter((record) => !isAttachmentDeleted(record)).map((record) => mapAttachment(record))
    },

    async listProjects(
      args: { query?: string; limit?: number } = {}
    ): Promise<ProductiveProject[]> {
      const query = args.query?.trim()
      const path = query
        ? `/projects?filter[status]=1&filter[query]=${encodeURIComponent(query)}&sort=name`
        : '/projects?filter[status]=1&sort=name'
      const { records } = await transport.fetchPaged(
        // filter[status]=1 -> active projects only.
        (page, pageSize) => withPageParams(path, page, pageSize),
        args.limit === undefined ? undefined : { maxRecords: args.limit }
      )
      return records.map(mapProject).sort((a, b) => a.name.localeCompare(b.name))
    },

    async listTaskLists(
      projectId: string,
      options?: { folderId?: string; includeArchived?: boolean }
    ): Promise<ProductiveTaskList[]> {
      if (!projectId) {
        return []
      }
      // Why no `sort`: Productive rejects every sort field on /task_lists
      // ("Sort by 'x' is not supported on this endpoint"). Its default order is
      // already placement-ascending, which is the board order we want.
      const { records, included } = await transport.fetchPaged((page, pageSize) =>
        withPageParams(
          `/task_lists?filter[project_id]=${encodeURIComponent(projectId)}&include=folder`,
          page,
          pageSize
        )
      )
      const lookup = buildIncludedLookup(included)
      const includeArchived = options?.includeArchived ?? false
      return records
        .filter((record) => includeArchived || !isArchived(record))
        .map((record) => mapTaskList(record, lookup))
        .filter((list) => !options?.folderId || list.folderId === options.folderId)
    },

    async listFolders(
      projectId: string,
      options?: { includeArchived?: boolean }
    ): Promise<ProductiveFolder[]> {
      if (!projectId) {
        return []
      }
      const { records } = await transport.fetchPaged((page, pageSize) =>
        withPageParams(
          `/folders?filter[project_id]=${encodeURIComponent(projectId)}`,
          page,
          pageSize
        )
      )
      const includeArchived = options?.includeArchived ?? false
      return records.filter((record) => includeArchived || !isArchived(record)).map(mapFolder)
    },

    async getProjectWorkflowId(productiveProjectId: string): Promise<string | null> {
      if (!productiveProjectId) {
        return null
      }
      // Why: the `workflow` relationship comes back as {"meta":{"included":false}}
      // unless explicitly included, so the include is load-bearing here.
      const response = await transport.request<JsonApiResponse>(
        `/projects/${encodeURIComponent(productiveProjectId)}?include=workflow`
      )
      const data = singleRecord(response)
      return relationshipId(asRecord(data.relationships), 'workflow')
    },

    async listWorkflowStatuses(args?: {
      workflowId?: string
    }): Promise<ProductiveWorkflowStatus[]> {
      const params = new URLSearchParams()
      if (args?.workflowId) {
        params.set('filter[workflow_id]', args.workflowId)
      }
      const suffix = params.toString() ? `?${params.toString()}` : ''
      const { records } = await transport.fetchPaged((page, pageSize) =>
        withPageParams(`/workflow_statuses${suffix}`, page, pageSize)
      )
      return records.map(mapWorkflowStatus)
    },

    async getPerson(personId: string): Promise<ProductivePerson | null> {
      if (!personId) return null
      const response = await transport.request<JsonApiResponse>(
        `/people/${encodeURIComponent(personId)}`
      )
      const data = response?.data
      if (data === undefined || Array.isArray(data)) return null
      return mapPerson(data) ?? null
    },

    async listAssignablePeople(args?: {
      query?: string
      projectId?: string
      preferredPersonId?: string
    }): Promise<ProductivePerson[]> {
      const params = new URLSearchParams()
      // Only active members are assignable.
      params.set('filter[status]', '1')
      if (args?.projectId) {
        params.set('filter[project_id]', args.projectId)
      }
      if (args?.query?.trim()) {
        params.set('filter[query]', args.query.trim())
      }
      const { records } = await transport.fetchPaged((page, pageSize) =>
        withPageParams(`/people?${params.toString()}`, page, pageSize)
      )
      const people = records
        .map((record) => mapPerson(record))
        .filter((person): person is ProductivePerson => person !== undefined)
      const preferredPersonId = args?.preferredPersonId
      if (preferredPersonId) {
        // Keep Productive's ordering intact, except that the configured viewer
        // is always the first choice in assignee dropdowns.
        people.sort((left, right) =>
          Number(right.id === preferredPersonId) - Number(left.id === preferredPersonId)
        )
      }
      return people
    }
  }
}

export { taskUrl }
