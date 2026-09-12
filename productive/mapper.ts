// Pure JSON:API -> domain mapping. No I/O, no dependencies: everything here is
// a function of the parsed response body, which is what makes it testable
// without touching the network.
import type {
  ProductiveAttachment,
  ProductiveComment,
  ProductiveFolder,
  ProductivePerson,
  ProductiveProject,
  ProductiveRecord,
  ProductiveStateCategory,
  ProductiveTask,
  ProductiveTaskList,
  ProductiveWorkflowStatus
} from './types'

// ---------------------------------------------------------------------------
// Defensive coercers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): ProductiveRecord {
  return value && typeof value === 'object' ? (value as ProductiveRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value
  }
  // Why: Productive numeric ids (task_number, relationship ids) arrive as both
  // strings and numbers across endpoints; coerce so identifiers stay stable.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return fallback
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  // Why: Productive serializes several numeric attributes as strings
  // (`task_number` and `project_number` come back as "450"/"254", while
  // `category_id` is a real number). Rejecting the string form silently fell
  // back to the global task id for every task key.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// ---------------------------------------------------------------------------
// JSON:API included[] resolution
// ---------------------------------------------------------------------------

export type IncludedLookup = Map<string, ProductiveRecord>

function includedKey(type: string, id: string): string {
  return `${type}:${id}`
}

/** Why: JSON:API side-loads related records in a flat `included[]` array keyed
 *  by {type,id}; relationships only carry the {type,id} pointer, so reads must
 *  resolve nested objects through this lookup rather than reading embedded data. */
export function buildIncludedLookup(included: unknown): IncludedLookup {
  const lookup: IncludedLookup = new Map()
  if (!Array.isArray(included)) {
    return lookup
  }
  for (const entry of included) {
    const record = asRecord(entry)
    const type = asString(record.type)
    const id = asString(record.id)
    if (type && id) {
      lookup.set(includedKey(type, id), record)
    }
  }
  return lookup
}

/** Resolve a single relationship pointer (`relationships.<name>.data`) to its
 *  side-loaded `included[]` record, returning {} when absent or unresolved. */
export function resolveRelationship(
  relationships: ProductiveRecord,
  name: string,
  lookup: IncludedLookup
): ProductiveRecord {
  const relationship = asRecord(asRecord(relationships)[name])
  const data = asRecord(relationship.data)
  const type = asString(data.type)
  const id = asString(data.id)
  if (!type || !id) {
    return {}
  }
  return lookup.get(includedKey(type, id)) ?? {}
}

/** The id a relationship points at, independent of whether it was side-loaded. */
export function relationshipId(relationships: ProductiveRecord, name: string): string | null {
  const data = asRecord(asRecord(asRecord(relationships)[name]).data)
  const id = asString(data.id)
  return id || null
}

// ---------------------------------------------------------------------------
// HTML <-> Markdown body helpers
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' '
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named = HTML_ENTITIES[entity]
    if (named !== undefined) {
      return named
    }
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return match
  })
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function looksLikeHtml(value: string): boolean {
  return /<[a-zA-Z/][^>]*>/.test(value)
}

/** Why: Productive encodes @-mentions inline as `@[{...}]` — a JSON array of
 *  mention descriptors (person/task/etc., each with a `label`). Render them as a
 *  readable `@Label` instead of leaking raw JSON into task and comment bodies. */
function renderProductiveMentions(text: string): string {
  if (!text.includes('@[')) {
    return text
  }
  return text.replace(/@(\[[^\]]*\])/g, (match, jsonArray: string) => {
    try {
      const parsed: unknown = JSON.parse(jsonArray)
      if (!Array.isArray(parsed)) {
        return match
      }
      const labels = parsed
        .map((entry) =>
          entry && typeof entry === 'object' ? asString((entry as ProductiveRecord).label) : ''
        )
        .filter((label) => label.length > 0)
      return labels.length > 0 ? labels.map((label) => `@${label}`).join(' ') : match
    } catch {
      // Not a mention token (or malformed) — leave the original text untouched.
      return match
    }
  })
}

/** Why: Productive description/comment bodies are HTML rich text, but the field
 *  has been observed to also carry plain text; accept both defensively and
 *  collapse toward Markdown. */
export function bodyToMarkdown(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  if (!looksLikeHtml(value)) {
    // Plain text — the transform is effectively identity (trimmed of trailing ws).
    return renderProductiveMentions(
      value
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
  }

  let text = value
  // Block-level breaks before stripping tags so structure survives.
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  text = text.replace(/<\s*\/\s*(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr)\s*>/gi, '\n')
  text = text.replace(/<\s*li\b[^>]*>/gi, '- ')
  // Drop all remaining tags.
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return renderProductiveMentions(
    text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** Convert Markdown/plain editor text into the HTML body Productive expects:
 *  paragraph per blank-line-separated block, `<br>` joins inside. */
export function markdownToBody(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const paragraphs = normalized.split(/\n{2,}/)
  return paragraphs
    .map((paragraph) => {
      const lines = paragraph.split('\n').map((line) => escapeHtml(line))
      return `<p>${lines.join('<br>')}</p>`
    })
    .join('')
}

// ---------------------------------------------------------------------------
// Status mapping (workflow_status.category_id -> contract state categories)
// ---------------------------------------------------------------------------

/** Productive `category_id`: 1 = Not Started, 2 = Started, 3 = Closed. Anything
 *  missing or unknown falls back to 'todo' so the board tone is always defined. */
export function categoryKeyFromId(categoryId: unknown): ProductiveStateCategory {
  const id = asFiniteNumber(categoryId)
  if (id === 2) {
    return 'in_progress'
  }
  if (id === 3) {
    return 'done'
  }
  return 'todo'
}

// ---------------------------------------------------------------------------
// Entity mappers
// ---------------------------------------------------------------------------

function personName(attributes: ProductiveRecord): string {
  const first = asString(attributes.first_name)
  const last = asString(attributes.last_name)
  const joined = [first, last].filter(Boolean).join(' ').trim()
  return joined || asString(attributes.name) || asString(attributes.email, 'Unknown')
}

export function mapPerson(record: unknown): ProductivePerson | undefined {
  const data = asRecord(record)
  const id = asString(data.id)
  if (!id) {
    return undefined
  }
  const attributes = asRecord(data.attributes)
  return {
    id,
    name: personName(attributes),
    email: asString(attributes.email) || undefined,
    avatarUrl: asString(attributes.avatar_url) || undefined
  }
}

export function mapProject(record: unknown): ProductiveProject {
  const data = asRecord(record)
  const attributes = asRecord(data.attributes)
  return {
    id: asString(data.id),
    name: asString(attributes.name, 'Untitled project'),
    number: asFiniteNumber(attributes.project_number) ?? undefined
  }
}

/** `lookup` is optional so callers without a `folder` include (or without any
 *  included[] at all) still get a valid ProductiveTaskList back — folder
 *  fields are simply left undefined rather than guessed. */
export function mapTaskList(record: unknown, lookup?: IncludedLookup): ProductiveTaskList {
  const data = asRecord(record)
  const attributes = asRecord(data.attributes)
  const relationships = asRecord(data.relationships)
  const folderRecord = lookup ? resolveRelationship(relationships, 'folder', lookup) : {}
  return {
    id: asString(data.id),
    name: asString(attributes.name, 'Untitled list'),
    projectId: relationshipId(relationships, 'project') ?? undefined,
    folderId: relationshipId(relationships, 'folder') ?? undefined,
    folderName: asString(folderRecord.id) ? mapFolder(folderRecord).name : undefined
  }
}

/** A Productive "folder" record (what used to be a "board"). */
export function mapFolder(record: unknown): ProductiveFolder {
  const data = asRecord(record)
  const attributes = asRecord(data.attributes)
  return {
    id: asString(data.id),
    name: asString(attributes.name, 'Untitled folder'),
    archived: attributes.archived_at !== undefined && attributes.archived_at !== null
  }
}

export function mapWorkflowStatus(record: unknown): ProductiveWorkflowStatus {
  const data = asRecord(record)
  const attributes = asRecord(data.attributes)
  return {
    id: asString(data.id),
    name: asString(attributes.name, 'Unknown'),
    categoryId: asFiniteNumber(attributes.category_id) ?? 1,
    stateCategory: categoryKeyFromId(attributes.category_id),
    color: asString(attributes.color) || undefined
  }
}

export function mapComment(
  record: unknown,
  lookup?: IncludedLookup,
  attachments: ProductiveAttachment[] = []
): ProductiveComment {
  const data = asRecord(record)
  const attributes = asRecord(data.attributes)
  const relationships = asRecord(data.relationships)
  const author = lookup
    ? resolveRelationship(relationships, 'creator', lookup)
    : asRecord(attributes.creator)
  return {
    id: asString(data.id),
    body: bodyToMarkdown(attributes.body ?? attributes.commentable_body),
    createdAt: asString(attributes.created_at, new Date().toISOString()),
    updatedAt: asString(attributes.updated_at) || undefined,
    user: mapPerson(author),
    attachments
  }
}

/** Maps a Productive `attachments` JSON:API record. `lookup` is accepted for
 *  parity with the other map* helpers (side-loaded creator/task/comment
 *  records) even though ProductiveAttachment does not currently surface them. */
export function mapAttachment(record: unknown, lookup?: IncludedLookup): ProductiveAttachment {
  void lookup
  const data = asRecord(record)
  const attributes = asRecord(data.attributes)
  const relationships = asRecord(data.relationships)
  const contentType = asString(attributes.content_type)
  return {
    id: asString(data.id),
    name: asString(attributes.name, 'Untitled attachment'),
    contentType,
    size: asFiniteNumber(attributes.size) ?? 0,
    url: asString(attributes.url),
    thumbUrl: asString(attributes.thumb) || undefined,
    isImage: contentType.startsWith('image/'),
    createdAt: asString(attributes.created_at, new Date().toISOString()),
    attachedTo: asString(attributes.attachable_type) === 'comment' ? 'comment' : 'task',
    commentId: relationshipId(relationships, 'comment') ?? undefined
  }
}

/** An attachment is soft-deleted (and must not be shown) once Productive sets
 *  `deleted_at`. */
export function isAttachmentDeleted(record: unknown): boolean {
  const attributes = asRecord(asRecord(record).attributes)
  return attributes.deleted_at !== undefined && attributes.deleted_at !== null
}

/** Resolve the workflow status whether it is side-loaded under `workflow_status`
 *  or only described by attributes (status_id + category fields). */
function resolveTaskStatus(
  attributes: ProductiveRecord,
  relationships: ProductiveRecord,
  lookup: IncludedLookup
): ProductiveWorkflowStatus {
  const sideLoaded = resolveRelationship(relationships, 'workflow_status', lookup)
  if (asString(sideLoaded.id)) {
    return mapWorkflowStatus(sideLoaded)
  }
  // Fallback: synthesize from the relationship id + any attribute category hint.
  const id = relationshipId(relationships, 'workflow_status') ?? asString(attributes.status_id)
  const rawCategory = attributes.status_category_id ?? attributes.category_id
  return {
    id,
    name: asString(attributes.status_name, 'Unknown'),
    categoryId: asFiniteNumber(rawCategory) ?? 1,
    stateCategory: categoryKeyFromId(rawCategory),
    color: undefined
  }
}

export function taskUrl(organizationId: string, taskId: string): string {
  // Why: the org-scoped prefix is the load-bearing part; Productive resolves the
  // short /task/<id> deep link to the full project-scoped path.
  return `https://app.productive.io/${encodeURIComponent(organizationId)}/task/${encodeURIComponent(
    taskId
  )}`
}

export function mapProductiveTask(
  organizationId: string,
  raw: unknown,
  included?: unknown
): ProductiveTask {
  const data = asRecord(raw)
  const attributes = asRecord(data.attributes)
  const relationships = asRecord(data.relationships)
  const lookup = buildIncludedLookup(included)

  const id = asString(data.id)
  const taskNumber = asFiniteNumber(attributes.task_number)
  const project = mapProject(resolveRelationship(relationships, 'project', lookup))
  const projectId = relationshipId(relationships, 'project') ?? (project.id || undefined)
  const assigneeRecord = resolveRelationship(relationships, 'assignee', lookup)
  const taskListRecord = resolveRelationship(relationships, 'task_list', lookup)
  const taskListRelationships = asRecord(taskListRecord.relationships)
  // Folder is reached by following task_list -> folder through the same
  // included[] lookup (nested include `task_list.folder`, never a second
  // request). Left undefined — never guessed — when either hop isn't
  // side-loaded.
  const folderRecord = asString(taskListRecord.id)
    ? resolveRelationship(taskListRelationships, 'folder', lookup)
    : {}
  const now = new Date().toISOString()

  return {
    id,
    taskNumber: taskNumber ?? undefined,
    key: `#${taskNumber ?? id}`,
    title: asString(attributes.title, id ? `#${taskNumber ?? id}` : 'Untitled task'),
    description: bodyToMarkdown(attributes.description),
    url: taskUrl(organizationId, id),
    organizationId,
    project: projectId ? { ...project, id: projectId } : project,
    taskListId: relationshipId(relationships, 'task_list') ?? undefined,
    taskList: asString(taskListRecord.id) ? mapTaskList(taskListRecord, lookup) : undefined,
    folderId: asString(folderRecord.id) ? asString(folderRecord.id) : undefined,
    folderName: asString(folderRecord.id) ? mapFolder(folderRecord).name : undefined,
    status: resolveTaskStatus(attributes, relationships, lookup),
    assignee: mapPerson(assigneeRecord),
    assigneeId: relationshipId(relationships, 'assignee') ?? undefined,
    labels: asStringArray(attributes.tag_list),
    dueDate: asString(attributes.due_date) || undefined,
    createdAt: asString(attributes.created_at, now),
    updatedAt: asString(attributes.updated_at ?? attributes.last_activity_at, now)
  }
}
