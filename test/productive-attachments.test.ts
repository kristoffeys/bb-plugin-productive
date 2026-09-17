import { beforeEach, describe, expect, it } from 'vitest'
import { createProductiveApi, mapAttachment } from '../productive/index'
import { buildIncludedLookup } from '../productive/mapper'

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
// mapAttachment
// ---------------------------------------------------------------------------

describe('mapAttachment', () => {
  it('maps a well-formed task attachment', () => {
    const record = {
      type: 'attachments',
      id: 'att-1',
      attributes: {
        name: 'screenshot.png',
        content_type: 'image/png',
        size: 2048,
        url: 'https://files.productive.io/att-1/screenshot.png',
        thumb: 'https://files.productive.io/att-1/thumb.png',
        created_at: '2026-01-01T00:00:00.000Z',
        deleted_at: null,
        attachable_type: 'task'
      },
      relationships: {
        task: { data: { type: 'tasks', id: 'task-1' } }
      }
    }
    expect(mapAttachment(record)).toEqual({
      id: 'att-1',
      name: 'screenshot.png',
      contentType: 'image/png',
      size: 2048,
      url: 'https://files.productive.io/att-1/screenshot.png',
      thumbUrl: 'https://files.productive.io/att-1/thumb.png',
      isImage: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      attachedTo: 'task',
      commentId: undefined
    })
  })

  it('defaults a missing content_type to empty string and isImage to false', () => {
    const record = {
      type: 'attachments',
      id: 'att-2',
      attributes: {
        name: 'notes.txt',
        size: 10,
        url: 'https://files.productive.io/att-2/notes.txt',
        attachable_type: 'task'
      }
    }
    const attachment = mapAttachment(record)
    expect(attachment.contentType).toBe('')
    expect(attachment.isImage).toBe(false)
  })

  it('coerces a numeric-string size', () => {
    const record = {
      type: 'attachments',
      id: 'att-3',
      attributes: {
        name: 'archive.zip',
        content_type: 'application/zip',
        size: '4096',
        url: 'https://files.productive.io/att-3/archive.zip',
        attachable_type: 'task'
      }
    }
    expect(mapAttachment(record).size).toBe(4096)
  })

  it('defaults an unparsable size to 0', () => {
    const record = {
      type: 'attachments',
      id: 'att-4',
      attributes: {
        name: 'mystery',
        size: 'not-a-number',
        url: 'https://files.productive.io/att-4',
        attachable_type: 'task'
      }
    }
    expect(mapAttachment(record).size).toBe(0)
  })

  it('marks a comment attachment with attachedTo and commentId', () => {
    const record = {
      type: 'attachments',
      id: 'att-5',
      attributes: {
        name: 'inline.png',
        content_type: 'image/png',
        size: 100,
        url: 'https://files.productive.io/att-5/inline.png',
        attachable_type: 'comment'
      },
      relationships: {
        comment: { data: { type: 'comments', id: 'comment-9' } }
      }
    }
    const attachment = mapAttachment(record)
    expect(attachment.attachedTo).toBe('comment')
    expect(attachment.commentId).toBe('comment-9')
  })
})

// ---------------------------------------------------------------------------
// listTaskAttachments
// ---------------------------------------------------------------------------

describe('listTaskAttachments', () => {
  it('fetches attachments for a task and drops soft-deleted ones', async () => {
    enqueue({
      data: [
        {
          type: 'attachments',
          id: 'att-1',
          attributes: {
            name: 'kept.png',
            content_type: 'image/png',
            size: 1,
            url: 'https://files.productive.io/att-1',
            deleted_at: null,
            attachable_type: 'task'
          }
        },
        {
          type: 'attachments',
          id: 'att-2',
          attributes: {
            name: 'removed.png',
            content_type: 'image/png',
            size: 1,
            url: 'https://files.productive.io/att-2',
            deleted_at: '2026-02-01T00:00:00.000Z',
            attachable_type: 'task'
          }
        }
      ],
      links: { next: null }
    })

    const attachments = await api().listTaskAttachments('task-1')
    expect(attachments.map((a) => a.id)).toEqual(['att-1'])
    expect(calls[0].url).toContain('/attachments?filter[task_id]=task-1')
  })
})

// ---------------------------------------------------------------------------
// getTaskComments attachment matching
// ---------------------------------------------------------------------------

describe('getTaskComments attachment matching', () => {
  it('attaches each attachment only to the comment it belongs to', async () => {
    enqueue({
      data: [
        {
          type: 'comments',
          id: 'comment-1',
          attributes: { body: 'first', created_at: '2026-01-01T00:00:00.000Z' },
          relationships: { creator: { data: { type: 'people', id: 'person-1' } } }
        },
        {
          type: 'comments',
          id: 'comment-2',
          attributes: { body: 'second', created_at: '2026-01-02T00:00:00.000Z' },
          relationships: {
            creator: { data: { type: 'people', id: 'person-1' } },
            attachments: { data: [{ type: 'attachments', id: 'att-3' }] }
          }
        }
      ],
      included: [
        { type: 'people', id: 'person-1', attributes: { first_name: 'Ada', last_name: 'Lovelace' } },
        {
          type: 'attachments',
          id: 'att-1',
          attributes: {
            name: 'for-comment-1.png',
            content_type: 'image/png',
            size: 1,
            url: 'https://files.productive.io/att-1',
            deleted_at: null,
            attachable_type: 'comment'
          },
          relationships: { comment: { data: { type: 'comments', id: 'comment-1' } } }
        },
        {
          type: 'attachments',
          id: 'att-2',
          attributes: {
            name: 'deleted.png',
            content_type: 'image/png',
            size: 1,
            url: 'https://files.productive.io/att-2',
            deleted_at: '2026-01-03T00:00:00.000Z',
            attachable_type: 'comment'
          },
          relationships: { comment: { data: { type: 'comments', id: 'comment-1' } } }
        },
        {
          type: 'attachments',
          id: 'att-3',
          attributes: {
            name: 'relationship-only.pdf',
            content_type: 'application/pdf',
            size: 2,
            url: 'https://files.productive.io/att-3',
            deleted_at: null,
            attachable_type: 'comment'
          }
        }
      ],
      links: { next: null }
    })

    const comments = await api().getTaskComments('task-1')
    const byId = new Map(comments.map((c) => [c.id, c]))
    expect(byId.get('comment-1')?.attachments.map((a) => a.id)).toEqual(['att-1'])
    expect(byId.get('comment-2')?.attachments.map((a) => a.id)).toEqual(['att-3'])
  })
})

describe('buildIncludedLookup sanity', () => {
  it('resolves attachments records the same way as other included types', () => {
    const lookup = buildIncludedLookup([
      { type: 'attachments', id: 'att-1', attributes: { name: 'x' } }
    ])
    expect(lookup.get('attachments:att-1')).toEqual({
      type: 'attachments',
      id: 'att-1',
      attributes: { name: 'x' }
    })
  })
})

// ---------------------------------------------------------------------------
// uploadTaskAttachment — Productive's four-step upload flow
// ---------------------------------------------------------------------------

describe('uploadTaskAttachment', () => {
  it('creates the record, posts the bytes, then links it to the task', async () => {
    enqueue({
      data: {
        type: 'attachments',
        id: 'att-9',
        attributes: {
          aws_policy: {
            url: 'https://bucket.s3.eu-west-1.amazonaws.com',
            key: 'uploads/att-9/trace.pdf',
            policy: 'base64policy',
            'x-amz-signature': 'sig'
          }
        }
      }
    })
    enqueue(null, 204) // the S3 POST
    enqueue({ data: { type: 'attachments', id: 'att-9' } })
    enqueue({ data: { type: 'tasks', id: 'task-7' } })

    const id = await api().uploadTaskAttachment('task-7', {
      name: 'trace.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3])
    })

    expect(id).toBe('att-9')
    expect(calls.map(call => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
      'POST https://api.productive.io/api/v2/attachments',
      'POST https://bucket.s3.eu-west-1.amazonaws.com',
      'PATCH https://api.productive.io/api/v2/attachments/att-9',
      'PATCH https://api.productive.io/api/v2/tasks/task-7'
    ])

    const created = JSON.parse(String(calls[0]!.init?.body))
    expect(created.data.attributes).toMatchObject({
      name: 'trace.pdf',
      content_type: 'application/pdf',
      size: 3,
      attachable_type: 'task'
    })

    // The S3 body is form-data carrying every policy field except `url`,
    // with the file last.
    const form = calls[1]!.init?.body as FormData
    expect(form.get('key')).toBe('uploads/att-9/trace.pdf')
    expect(form.get('policy')).toBe('base64policy')
    expect(form.get('url')).toBeNull()
    expect([...form.keys()].at(-1)).toBe('File')

    const linked = JSON.parse(String(calls[3]!.init?.body))
    expect(linked.data.relationships.attachments.data).toEqual([
      { type: 'attachments', id: 'att-9' }
    ])
  })

  it('reports a failed storage upload instead of linking a broken attachment', async () => {
    enqueue({
      data: {
        type: 'attachments',
        id: 'att-1',
        attributes: { aws_policy: { url: 'https://bucket.s3.amazonaws.com', key: 'k' } }
      }
    })
    enqueue({ message: 'nope' }, 403)

    await expect(
      api().uploadTaskAttachment('task-1', {
        name: 'big.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1])
      })
    ).rejects.toThrow(/storage failed \(403\)/)
    expect(calls).toHaveLength(2)
  })

  it('links uploaded files to comments with the comment attachable type', async () => {
    enqueue({
      data: {
        type: 'attachments',
        id: 'att-comment',
        attributes: {
          aws_policy: {
            url: 'https://bucket.s3.amazonaws.com',
            key: 'uploads/comment/image.png'
          }
        }
      }
    })
    enqueue(null, 204)
    enqueue({ data: { type: 'attachments', id: 'att-comment' } })
    enqueue({ data: { type: 'comments', id: 'comment-7' } })

    await api().uploadCommentAttachment('comment-7', {
      name: 'image.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2])
    })

    const created = JSON.parse(String(calls[0]!.init?.body))
    expect(created.data.attributes.attachable_type).toBe('comment')
    expect(calls[3]?.url).toContain('/comments/comment-7')
    const linked = JSON.parse(String(calls[3]!.init?.body))
    expect(linked.data).toMatchObject({ type: 'comments', id: 'comment-7' })
  })
})
