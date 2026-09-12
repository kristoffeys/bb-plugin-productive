import { beforeEach, describe, expect, it } from 'vitest'
import { createProductiveApi, mapFolder, mapProductiveTask } from '../productive/index'

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

function api() {
  return createProductiveApi(
    { apiToken: 'super-secret-token', organizationId: '42' },
    { fetchImpl }
  )
}

beforeEach(() => {
  calls.length = 0
  queue = []
})

// ---------------------------------------------------------------------------
// mapFolder
// ---------------------------------------------------------------------------

describe('mapFolder', () => {
  it('maps an active folder', () => {
    const record = {
      type: 'folders',
      id: 'folder-1',
      attributes: { name: 'Sprint board', position: 1, placement: 1, archived_at: null, hidden: false }
    }
    expect(mapFolder(record)).toEqual({ id: 'folder-1', name: 'Sprint board', archived: false })
  })

  it('marks a folder with archived_at set as archived', () => {
    const record = {
      type: 'folders',
      id: 'folder-2',
      attributes: { name: 'Old board', archived_at: '2026-01-01T00:00:00.000Z' }
    }
    expect(mapFolder(record).archived).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mapProductiveTask: folder resolved through task_list -> folder
// ---------------------------------------------------------------------------

describe('mapProductiveTask folder resolution', () => {
  const included = [
    {
      type: 'task_lists',
      id: 'list-1',
      attributes: { name: 'To do' },
      relationships: { folder: { data: { type: 'folders', id: 'folder-1' } } }
    },
    {
      type: 'folders',
      id: 'folder-1',
      attributes: { name: 'Sprint board', archived_at: null }
    }
  ]

  it('resolves folderId and folderName via the nested task_list.folder include', () => {
    const task = {
      type: 'tasks',
      id: 'task-1',
      attributes: { title: 'Do the thing' },
      relationships: {
        task_list: { data: { type: 'task_lists', id: 'list-1' } }
      }
    }
    const mapped = mapProductiveTask('42', task, included)
    expect(mapped.folderId).toBe('folder-1')
    expect(mapped.folderName).toBe('Sprint board')
    expect(mapped.taskList?.folderId).toBe('folder-1')
    expect(mapped.taskList?.folderName).toBe('Sprint board')
  })

  it('leaves folder fields undefined when the folder is not side-loaded', () => {
    const task = {
      type: 'tasks',
      id: 'task-2',
      attributes: { title: 'No folder here' },
      relationships: {
        task_list: { data: { type: 'task_lists', id: 'list-1' } }
      }
    }
    // Only the task_list is included, not its folder.
    const partialIncluded = [included[0]]
    const mapped = mapProductiveTask('42', task, partialIncluded)
    expect(mapped.folderId).toBeUndefined()
    expect(mapped.folderName).toBeUndefined()
  })

  it('leaves folder fields undefined when there is no task_list at all', () => {
    const task = {
      type: 'tasks',
      id: 'task-3',
      attributes: { title: 'No list' },
      relationships: {}
    }
    const mapped = mapProductiveTask('42', task, included)
    expect(mapped.folderId).toBeUndefined()
    expect(mapped.folderName).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// listFolders: archived filtering
// ---------------------------------------------------------------------------

describe('listFolders', () => {
  const payload = {
    data: [
      { type: 'folders', id: 'f-1', attributes: { name: 'Active board', archived_at: null } },
      { type: 'folders', id: 'f-2', attributes: { name: 'Archived board 1', archived_at: '2026-01-01T00:00:00.000Z' } },
      { type: 'folders', id: 'f-3', attributes: { name: 'Archived board 2', archived_at: '2026-02-01T00:00:00.000Z' } }
    ],
    links: { next: null }
  }

  it('excludes archived folders by default', async () => {
    enqueue(payload)
    const folders = await api().listFolders('project-1')
    expect(folders.map((f) => f.id)).toEqual(['f-1'])
    expect(calls[0].url).toContain('/folders?filter[project_id]=project-1')
  })

  it('includes archived folders when asked', async () => {
    enqueue(payload)
    const folders = await api().listFolders('project-1', { includeArchived: true })
    expect(folders.map((f) => f.id)).toEqual(['f-1', 'f-2', 'f-3'])
  })
})

// ---------------------------------------------------------------------------
// listTaskLists: folder population, archived filtering, folder filtering
// ---------------------------------------------------------------------------

describe('listTaskLists folders', () => {
  const payload = {
    data: [
      {
        type: 'task_lists',
        id: 'list-1',
        attributes: { name: 'To do', archived_at: null },
        relationships: { folder: { data: { type: 'folders', id: 'folder-1' } } }
      },
      {
        type: 'task_lists',
        id: 'list-2',
        attributes: { name: 'Done', archived_at: null },
        relationships: { folder: { data: { type: 'folders', id: 'folder-2' } } }
      },
      {
        type: 'task_lists',
        id: 'list-3',
        attributes: { name: 'Old list', archived_at: '2026-01-01T00:00:00.000Z' },
        relationships: { folder: { data: { type: 'folders', id: 'folder-1' } } }
      }
    ],
    included: [
      { type: 'folders', id: 'folder-1', attributes: { name: 'Sprint board' } },
      { type: 'folders', id: 'folder-2', attributes: { name: 'Backlog board' } }
    ],
    links: { next: null }
  }

  it('populates folderId/folderName and excludes archived lists by default', async () => {
    enqueue(payload)
    const lists = await api().listTaskLists('project-1')
    expect(lists.map((l) => l.id)).toEqual(['list-1', 'list-2'])
    expect(lists.find((l) => l.id === 'list-1')).toMatchObject({
      folderId: 'folder-1',
      folderName: 'Sprint board'
    })
    expect(calls[0].url).not.toMatch(/sort=/)
  })

  it('filters to one folder when folderId is given', async () => {
    enqueue(payload)
    const lists = await api().listTaskLists('project-1', { folderId: 'folder-1' })
    expect(lists.map((l) => l.id)).toEqual(['list-1'])
  })

  it('includes archived lists when asked', async () => {
    enqueue(payload)
    const lists = await api().listTaskLists('project-1', { includeArchived: true })
    expect(lists.map((l) => l.id)).toEqual(['list-1', 'list-2', 'list-3'])
  })
})

// ---------------------------------------------------------------------------
// listTasks: client-side folder filtering
// ---------------------------------------------------------------------------

describe('listTasks folder filtering', () => {
  it('filters mapped tasks by folderId client-side, with no extra request', async () => {
    enqueue({
      data: [
        {
          type: 'tasks',
          id: 'task-1',
          attributes: { title: 'In folder 1' },
          relationships: { task_list: { data: { type: 'task_lists', id: 'list-1' } } }
        },
        {
          type: 'tasks',
          id: 'task-2',
          attributes: { title: 'In folder 2' },
          relationships: { task_list: { data: { type: 'task_lists', id: 'list-2' } } }
        }
      ],
      included: [
        {
          type: 'task_lists',
          id: 'list-1',
          attributes: { name: 'To do' },
          relationships: { folder: { data: { type: 'folders', id: 'folder-1' } } }
        },
        {
          type: 'task_lists',
          id: 'list-2',
          attributes: { name: 'Done' },
          relationships: { folder: { data: { type: 'folders', id: 'folder-2' } } }
        },
        { type: 'folders', id: 'folder-1', attributes: { name: 'Sprint board' } },
        { type: 'folders', id: 'folder-2', attributes: { name: 'Backlog board' } }
      ],
      links: { next: null }
    })

    const tasks = await api().listTasks({ projectId: 'project-1', folderId: 'folder-1' })
    expect(tasks.map((t) => t.id)).toEqual(['task-1'])
    // Only the one /tasks request — folder filtering did not trigger a
    // second round-trip to resolve task lists.
    expect(calls.length).toBe(1)
  })
})
