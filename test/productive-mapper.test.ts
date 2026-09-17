import { beforeEach, describe, expect, it } from 'vitest'
import {
  bodyToMarkdown,
  categoryKeyFromId,
  createProductiveApi,
  isAuthError,
  markdownToBody,
  ProductiveApiError,
  taskUrl
} from '../productive/index'

// ---------------------------------------------------------------------------
// Fake transport: a queue of JSON:API payloads, recording every request.
// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit | undefined }

const calls: Call[] = []
let queue: { status: number; body: unknown }[] = []

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), init })
  const next = queue.shift() ?? { status: 200, body: { data: [], links: { next: null } } }
  return new Response(next.body === null ? null : JSON.stringify(next.body), {
    status: next.status,
    headers: { 'Content-Type': 'application/vnd.api+json' }
  })
}) as typeof fetch

function enqueue(body: unknown, status = 200): void {
  queue.push({ status, body })
}

const TOKEN = 'super-secret-token'

function api() {
  return createProductiveApi({ apiToken: TOKEN, organizationId: '42' }, { fetchImpl })
}

function body(index: number): Record<string, any> {
  return JSON.parse(String(calls[index]?.init?.body))
}

beforeEach(() => {
  calls.length = 0
  queue = []
})

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

describe('bodyToMarkdown mention rendering', () => {
  it('renders a Productive @-mention token as a readable @Label', () => {
    const raw =
      'cc @[{"type":"person","id":"1072309","label":"Alexander Verbeke","avatar_url":null,"attachment_url":null,"is_done":false}] please review'
    expect(bodyToMarkdown(raw)).toBe('cc @Alexander Verbeke please review')
  })

  it('renders multiple mentions in one body', () => {
    const raw =
      '@[{"type":"person","id":"1","label":"Ada Lovelace"}] and @[{"type":"person","id":"2","label":"Alan Turing"}]'
    expect(bodyToMarkdown(raw)).toBe('@Ada Lovelace and @Alan Turing')
  })

  it('renders mentions inside HTML bodies after tag stripping', () => {
    const raw = '<p>Ping @[{"type":"person","id":"9","label":"Grace Hopper"}]</p>'
    expect(bodyToMarkdown(raw)).toBe('Ping @Grace Hopper')
  })

  it('leaves non-mention bracket text untouched', () => {
    expect(bodyToMarkdown('see list [1, 2, 3] here')).toBe('see list [1, 2, 3] here')
  })

  it('strips HTML into markdown-ish plain text', () => {
    expect(bodyToMarkdown('<p>First line<br>second line</p>')).toBe('First line\nsecond line')
    expect(bodyToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two')
    expect(bodyToMarkdown('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>')
  })

  it('round-trips editor text back into an HTML body', () => {
    expect(markdownToBody('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>')
    expect(markdownToBody('a & <b>')).toBe('<p>a &amp; &lt;b&gt;</p>')
  })
})

describe('categoryKeyFromId', () => {
  it('buckets Productive category ids onto the contract state categories', () => {
    expect(categoryKeyFromId(1)).toBe('todo')
    expect(categoryKeyFromId(2)).toBe('in_progress')
    expect(categoryKeyFromId(3)).toBe('done')
    expect(categoryKeyFromId(undefined)).toBe('todo')
    // Productive serializes some numeric attributes as strings, so the
    // string form buckets the same as the number.
    expect(categoryKeyFromId('2')).toBe('in_progress')
    expect(categoryKeyFromId('not a number')).toBe('todo')
  })
})

describe('taskUrl', () => {
  it('builds the org-scoped Productive deep link', () => {
    expect(taskUrl('42', '825407')).toBe('https://app.productive.io/42/task/825407')
  })
})

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const TASK_RESPONSE = {
  data: {
    type: 'tasks',
    id: '825407',
    attributes: {
      task_number: 1,
      title: 'Wire up auth',
      description: '<p>First line<br>second line</p>',
      tag_list: ['backend', 'auth'],
      due_date: '2026-07-01',
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-19T00:00:00.000Z'
    },
    relationships: {
      project: { data: { type: 'projects', id: 'proj-1' } },
      assignee: { data: { type: 'people', id: 'person-1' } },
      workflow_status: { data: { type: 'workflow_statuses', id: 'ws-2' } },
      task_list: { data: { type: 'task_lists', id: 'list-1' } }
    }
  },
  included: [
    { type: 'projects', id: 'proj-1', attributes: { name: 'Orca', project_number: 7 } },
    {
      type: 'people',
      id: 'person-1',
      attributes: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }
    },
    { type: 'workflow_statuses', id: 'ws-2', attributes: { name: 'In progress', category_id: 2 } },
    { type: 'task_lists', id: 'list-1', attributes: { name: 'Sprint 1' } }
  ]
}

describe('createProductiveApi transport', () => {
  it('sends the JSON:API auth headers against the v2 base url', async () => {
    enqueue(TASK_RESPONSE)
    await api().getTask('825407')

    expect(calls[0].url).toContain('https://api.productive.io/api/v2/tasks/825407')
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers['X-Auth-Token']).toBe(TOKEN)
    expect(headers['X-Organization-Id']).toBe('42')
    expect(headers['Content-Type']).toBe('application/vnd.api+json')
  })

  it('rejects empty credentials before making a request', () => {
    expect(() => createProductiveApi({ apiToken: '', organizationId: '42' }, { fetchImpl })).toThrow(
      ProductiveApiError
    )
    expect(calls).toHaveLength(0)
  })

  it('throws ProductiveApiError with errors[0].detail on non-2xx', async () => {
    enqueue({ errors: [{ detail: 'Task not found', title: 'Not Found' }] }, 404)
    await expect(api().getTask('nope')).rejects.toThrow('Task not found')

    enqueue({ errors: [] }, 500)
    await expect(api().listProjects()).rejects.toBeInstanceOf(ProductiveApiError)
  })

  it('flags 401 as an auth error but not 403', async () => {
    enqueue({ errors: [{ detail: 'Invalid token' }] }, 401)
    const unauthorized = await api()
      .listProjects()
      .catch((error: unknown) => error)
    expect(isAuthError(unauthorized)).toBe(true)
    expect((unauthorized as ProductiveApiError).status).toBe(401)

    enqueue({ errors: [{ detail: 'Forbidden' }] }, 403)
    const forbidden = await api()
      .listProjects()
      .catch((error: unknown) => error)
    expect(isAuthError(forbidden)).toBe(false)
  })

  it('never leaks the API token into an error message', async () => {
    enqueue({ errors: [{ detail: `token ${TOKEN} rejected` }] }, 401)
    const error = (await api()
      .listProjects()
      .catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toContain('[redacted]')
  })
})

describe('Productive task operations', () => {
  it('resolves JSON:API included[] relationships when mapping a task', async () => {
    enqueue(TASK_RESPONSE)
    const task = await api().getTask('825407')

    expect(task).toMatchObject({
      id: '825407',
      taskNumber: 1,
      key: '#1',
      title: 'Wire up auth',
      description: 'First line\nsecond line',
      url: 'https://app.productive.io/42/task/825407',
      project: { id: 'proj-1', name: 'Orca' },
      taskList: { id: 'list-1', name: 'Sprint 1' },
      taskListId: 'list-1',
      assignee: { id: 'person-1', name: 'Ada Lovelace', email: 'ada@example.com' },
      assigneeId: 'person-1',
      status: { id: 'ws-2', name: 'In progress', categoryId: 2, stateCategory: 'in_progress' },
      labels: ['backend', 'auth'],
      dueDate: '2026-07-01',
      updatedAt: '2026-06-19T00:00:00.000Z'
    })
    expect(calls[0].url).toContain('include=assignee,workflow_status,project,task_list')
  })

  it('returns null for an empty task payload', async () => {
    enqueue({ data: null })
    await expect(api().getTask('1')).resolves.toBeNull()
  })

  it('requests the full include set when listing', async () => {
    enqueue({ data: [], links: { next: null } })
    await api().listTasks({ projectId: 'proj-1' })
    expect(calls[0].url).toContain('include=assignee,workflow_status,project,task_list')
  })

  it('translates list filters into Productive query params', async () => {
    enqueue({ data: [], links: { next: null } })
    await api().listTasks({
      projectId: 'proj-1',
      taskListId: 'list-1',
      assigneeId: '96137',
      status: 'closed',
      limit: 20
    })

    const url = calls[0].url
    expect(url).toContain('filter%5Bproject_id%5D=proj-1')
    expect(url).toContain('filter%5Btask_list_id%5D=list-1')
    expect(url).toContain('filter%5Bassignee_id%5D=96137')
    // Productive's task status filter is an integer (1 = open, 2 = closed).
    expect(url).toContain('filter%5Bstatus%5D=2')
    expect(url).toContain('page%5Bsize%5D=20')
  })

  it('defaults to the open status filter and omits it for "all"', async () => {
    enqueue({ data: [], links: { next: null } })
    await api().listTasks()
    expect(calls[0].url).toContain('filter%5Bstatus%5D=1')

    calls.length = 0
    enqueue({ data: [], links: { next: null } })
    await api().listTasks({ status: 'all' })
    expect(calls[0].url).not.toContain('filter%5Bstatus%5D')
  })

  it('sorts and limits list results by updatedAt', async () => {
    const task = (id: string, updatedAt: string) => ({
      type: 'tasks',
      id,
      attributes: { task_number: Number(id), updated_at: updatedAt }
    })
    enqueue({
      data: [
        task('1', '2026-01-01T00:00:00.000Z'),
        task('2', '2026-03-01T00:00:00.000Z'),
        task('3', '2026-02-01T00:00:00.000Z')
      ],
      links: { next: null }
    })
    const tasks = await api().listTasks({ limit: 2 })
    expect(tasks.map((item) => item.id)).toEqual(['2', '3'])
  })

  it('searches tasks with filter[query] and skips blank queries', async () => {
    enqueue({ data: [], links: { next: null } })
    await api().searchTasks('  auth  ')
    expect(calls[0].url).toContain('filter%5Bquery%5D=auth')

    calls.length = 0
    await expect(api().searchTasks('   ')).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('buckets workflow status categories onto the contract state categories', async () => {
    enqueue({
      data: [
        { type: 'workflow_statuses', id: '1', attributes: { name: 'Backlog', category_id: 1 } },
        { type: 'workflow_statuses', id: '2', attributes: { name: 'Doing', category_id: 2 } },
        { type: 'workflow_statuses', id: '3', attributes: { name: 'Closed', category_id: 3 } }
      ],
      links: { next: null }
    })

    await expect(api().listWorkflowStatuses()).resolves.toEqual([
      { id: '1', name: 'Backlog', categoryId: 1, stateCategory: 'todo', color: undefined },
      { id: '2', name: 'Doing', categoryId: 2, stateCategory: 'in_progress', color: undefined },
      { id: '3', name: 'Closed', categoryId: 3, stateCategory: 'done', color: undefined }
    ])
  })

  it('paginates JSON:API collections via links.next + page[number]', async () => {
    enqueue({
      data: [{ type: 'projects', id: '2', attributes: { name: 'Bravo' } }],
      links: { next: 'https://api.productive.io/api/v2/projects?page[number]=2&page[size]=100' }
    })
    enqueue({
      data: [{ type: 'projects', id: '1', attributes: { name: 'Alpha' } }],
      links: { next: null }
    })

    await expect(api().listProjects()).resolves.toMatchObject([
      { id: '1', name: 'Alpha' },
      { id: '2', name: 'Bravo' }
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('page%5Bnumber%5D=1')
    expect(calls[1].url).toContain('page%5Bnumber%5D=2')
  })

  it('resolves a project workflow id via the workflow include', async () => {
    enqueue({
      data: {
        type: 'projects',
        id: 'proj-1',
        relationships: { workflow: { data: { type: 'workflows', id: 'wf-7' } } }
      },
      included: [{ type: 'workflows', id: 'wf-7', attributes: { name: 'Default' } }]
    })
    await expect(api().getProjectWorkflowId('proj-1')).resolves.toBe('wf-7')
    expect(calls[0].url).toContain('/projects/proj-1?include=workflow')

    // Productive omits the pointer entirely when the include is missing.
    calls.length = 0
    enqueue({ data: { type: 'projects', id: 'proj-1', relationships: { workflow: { meta: { included: false } } } } })
    await expect(api().getProjectWorkflowId('proj-1')).resolves.toBeNull()
  })

  it('scopes workflow statuses to one workflow', async () => {
    enqueue({ data: [], links: { next: null } })
    await api().listWorkflowStatuses({ workflowId: 'wf-7' })
    expect(calls[0].url).toContain('filter%5Bworkflow_id%5D=wf-7')
  })

  it('stops paginating at meta.total_pages', async () => {
    enqueue({
      data: [{ type: 'workflow_statuses', id: '1', attributes: { name: 'Backlog' } }],
      meta: { total_pages: 1 },
      links: { next: 'https://api.productive.io/api/v2/workflow_statuses?page[number]=2' }
    })
    await api().listWorkflowStatuses()
    expect(calls).toHaveLength(1)
  })

  it('sets the workflow_status relationship when updating task status', async () => {
    enqueue(null, 204) // PATCH -> 204 No Content
    enqueue(TASK_RESPONSE) // read-back
    const task = await api().updateTask('825407', { workflowStatusId: 'ws-3' })

    expect(calls[0].init?.method).toBe('PATCH')
    expect(body(0)).toEqual({
      data: {
        type: 'tasks',
        id: '825407',
        relationships: { workflow_status: { data: { type: 'workflow_statuses', id: 'ws-3' } } }
      }
    })
    expect(task.status.id).toBe('ws-2')
  })

  it('clears the assignee with a null relationship and converts descriptions to HTML', async () => {
    enqueue(null, 204)
    enqueue(TASK_RESPONSE)
    await api().updateTask('825407', { assigneeId: null, description: 'hello\nworld' })

    expect(body(0).data.relationships.assignee).toEqual({ data: null })
    expect(body(0).data.attributes.description).toBe('<p>hello<br>world</p>')
  })

  it('creates a task with project, task list and assignee relationships', async () => {
    enqueue({ data: { type: 'tasks', id: '900', attributes: { task_number: 5 } } })
    enqueue({ data: { type: 'tasks', id: '900', attributes: { task_number: 5 } } })

    const task = await api().createTask({
      projectId: 'proj-1',
      taskListId: 'list-1',
      title: 'New task',
      assigneeId: 'p-1',
      description: 'body text'
    })

    expect(body(0).data.relationships).toEqual({
      project: { data: { type: 'projects', id: 'proj-1' } },
      task_list: { data: { type: 'task_lists', id: 'list-1' } },
      assignee: { data: { type: 'people', id: 'p-1' } }
    })
    expect(body(0).data.attributes.description).toBe('<p>body text</p>')
    expect(task).toMatchObject({ id: '900', key: '#5', url: 'https://app.productive.io/42/task/900' })
  })

  it('refuses to create a task without a title or project', async () => {
    await expect(api().createTask({ projectId: 'proj-1', title: '  ' })).rejects.toThrow(
      ProductiveApiError
    )
    await expect(api().createTask({ projectId: '', title: 'x' })).rejects.toThrow(ProductiveApiError)
    expect(calls).toHaveLength(0)
  })

  it('maps comments and resolves the creator from included[]', async () => {
    enqueue({
      data: [
        {
          type: 'comments',
          id: 'comment-1',
          attributes: { body: 'Looks reproducible.', created_at: '2026-05-30T12:00:00.000Z' },
          relationships: { creator: { data: { type: 'people', id: 'person-1' } } }
        }
      ],
      included: [
        { type: 'people', id: 'person-1', attributes: { first_name: 'Ada', last_name: 'Lovelace' } }
      ],
      links: { next: null }
    })

    await expect(api().getTaskComments('825407')).resolves.toEqual([
      {
        id: 'comment-1',
        body: 'Looks reproducible.',
        createdAt: '2026-05-30T12:00:00.000Z',
        updatedAt: undefined,
        user: { id: 'person-1', name: 'Ada Lovelace', email: undefined, avatarUrl: undefined },
        attachments: []
      }
    ])
    expect(calls[0].url).toContain('filter[task_id]=825407')
    expect(calls[0].url).toContain('include=creator,attachments')
  })

  it('posts a comment as HTML against the task relationship', async () => {
    enqueue({
      data: {
        type: 'comments',
        id: 'c-9',
        attributes: { body: '<p>ack</p>', created_at: '2026-05-30T12:00:00.000Z' }
      }
    })
    const comment = await api().addTaskComment('825407', 'ack')

    expect(calls[0].url).toContain('/comments')
    expect(body(0).data.attributes.body).toBe('<p>ack</p>')
    expect(body(0).data.relationships.task).toEqual({ data: { type: 'tasks', id: '825407' } })
    expect(comment).toMatchObject({ id: 'c-9', body: 'ack' })
  })

  it('lists task lists and active assignable people', async () => {
    enqueue({
      data: [
        {
          type: 'task_lists',
          id: 'list-1',
          attributes: { name: 'Sprint 1' },
          relationships: { project: { data: { type: 'projects', id: 'proj-1' } } }
        }
      ],
      links: { next: null }
    })
    await expect(api().listTaskLists('proj-1')).resolves.toEqual([
      { id: 'list-1', name: 'Sprint 1', projectId: 'proj-1' }
    ])
    expect(calls[0].url).toContain('filter[project_id]=proj-1')

    calls.length = 0
    await expect(api().listTaskLists('')).resolves.toEqual([])
    expect(calls).toHaveLength(0)

    enqueue({
      data: [
        { type: 'people', id: 'p-1', attributes: { first_name: 'Ada', last_name: 'Lovelace' } },
        { type: 'people', id: 'p-2', attributes: { first_name: 'Grace', last_name: 'Hopper' } },
        { type: 'people', attributes: { first_name: 'No', last_name: 'Id' } }
      ],
      links: { next: null }
    })
    await expect(api().listAssignablePeople({
      query: 'ada',
      projectId: 'proj-1',
      preferredPersonId: 'p-2'
    })).resolves.toEqual([
      { id: 'p-2', name: 'Grace Hopper', email: undefined, avatarUrl: undefined },
      { id: 'p-1', name: 'Ada Lovelace', email: undefined, avatarUrl: undefined }
    ])
    expect(calls[0].url).toContain('filter%5Bstatus%5D=1')
    expect(calls[0].url).toContain('filter%5Bproject_id%5D=proj-1')
    expect(calls[0].url).toContain('filter%5Bquery%5D=ada')
  })
})
