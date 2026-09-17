// bb-plugin-productive — backend entry.
//
// One Productive.io organization (one API token) serves every bb project. A bb
// project is mapped to exactly one Productive project; the board for that bb
// project is the mapped project's tasks, optionally narrowed to one task list
// and/or the configured person.
//
// Surfaces, all reading the same cache:
//   - the Productive nav panel and thread panel (app.tsx, over RPC)
//   - the `bb productive` CLI command
//   - the `productive-task` mention provider (@ / # in the composer)
//   - skills/productive/SKILL.md, which tells agents to use the CLI
//
// The API token lives in a 0600 file rather than a plugin setting so changing
// it does not require a plugin reload.
import { join, dirname, basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {
  CONNECTION_CHANGED,
  ITEMS_CHANGED,
  PRESETS_CHANGED,
  connectionInteractionResponseSchema,
  boardViewStateSchema,
  defaultProjectBoardSettings,
  filterPresetSummary,
  formatWorkItemContext,
  mentionId,
  parseMentionId,
  productiveRpcContract,
  type BoardStatus,
  type AttachmentUploadInput,
  type ConnectionView,
  type CreateTaskInput,
  type ProjectScope,
  type ProjectScopeView,
  type WorkItem,
  type WorkItemDetail,
  threadTitleForItem,
  formatWorkItemHandoffPrompt,
  type WorkAttachment,
  type WorkStateCategory,
  type WorkStatusOption
} from './contract.js';
import { MAX_UI_ATTACHMENT_BYTES } from './contract.js';
import { createWorkItemStore, type ProjectScopeDefaults } from './store.js';
import { deleteSecretFile, writeSecretFile } from './lib/secret-file.js';
import { flagValue, flagValues, positionalArgs } from './cli-args.js';
import {
  ProductiveApiError,
  BOARD_TASK_LIMIT,
  createProductiveApi,
  isAuthError,
  type ProductiveApi,
  type ProductiveAttachment,
  type ProductiveTask
} from './productive/index.js';
import { productiveSettings } from './composer-action-settings.js';
import { groupIdFromScope, groupScopeId } from './group-scopes.js';

const SYNC_INTERVAL_MS = 5 * 60_000;
const PRODUCTIVE_APP_ORIGIN = 'https://app.productive.io';
const sidebarGroupsSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      projectIds: z.array(z.string()),
      coordinatorThreadIds: z.array(z.string())
    })
  ),
  order: z.record(z.string(), z.array(z.unknown()))
});
const sidebarStartSchema = z.object({ threadId: z.string() });

/** Non-secret half of the connection. The token lives in a secret file. */
const connectionSettingsSchema = z
  .object({ organizationId: z.string(), personId: z.string() })
  .strict();
type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;

const EMPTY_CONNECTION: ConnectionSettings = {
  organizationId: '',
  personId: ''
};

export { productiveSettings } from './composer-action-settings.js';

export default async function plugin(bb: BbPluginApi) {
  bb.log.info('loaded');

  // Declarative settings are persisted by BB and are exposed to the plugin
  // settings page and app runtime. No connection or board state is stored here.
  bb.settings.define(productiveSettings);

  const store = createWorkItemStore(bb);
  const pluginDataDirectory = dirname(bb.storage.database().name);
  const tokenPath = join(pluginDataDirectory, 'secrets', 'api-token');

  async function sidebarGroups() {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: 'sidebar',
        method: 'project_groups_list',
        input: null,
        outputSchema: sidebarGroupsSchema
      });
      return result.groups;
    } catch (error) {
      bb.log.warn(`Sidebar groups unavailable: ${safeMessage(error)}`);
      return [];
    }
  }

  async function trackerTargets() {
    const [projects, groups] = await Promise.all([
      bb.sdk.projects.list({ includePersonal: true }),
      sidebarGroups()
    ]);
    return [
      ...projects.map(project => ({
        id: project.id,
        name: project.name,
        kind: 'project' as const,
        groupId: null
      })),
      ...groups.map(group => ({
        id: groupScopeId(group.id),
        name: group.name,
        kind: 'group' as const,
        groupId: group.id
      }))
    ];
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async function readToken(): Promise<string | null> {
    try {
      const value = (await readFile(tokenPath, 'utf8')).trim();
      return value === '' ? null : value;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    }
  }

  async function readConnectionSettings(): Promise<ConnectionSettings> {
    const stored = await bb.storage.kv.get<unknown>('connection');
    const parsed = connectionSettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : EMPTY_CONNECTION;
  }

  // One API client per (token, org). Rebuilt whenever the connection changes so
  // a re-keyed connection never keeps serving reads with the old credential.
  let apiCache: { key: string; api: ProductiveApi } | null = null;
  /** Resolved viewer name; cleared whenever the connection changes. */
  let viewerCache: { key: string; name: string | null } | null = null;

  async function currentApi(): Promise<ProductiveApi | null> {
    const [token, settings] = await Promise.all([
      readToken(),
      readConnectionSettings()
    ]);
    if (token === null || settings.organizationId === '') return null;
    const key = `${settings.organizationId}:${token}`;
    if (apiCache?.key !== key) {
      apiCache = {
        key,
        api: createProductiveApi({
          apiToken: token,
          organizationId: settings.organizationId
        })
      };
    }
    return apiCache.api;
  }

  /** Never let an upstream error text reach a caller verbatim. */
  function safeMessage(error: unknown): string {
    if (error instanceof ProductiveApiError) {
      if (isAuthError(error)) {
        return 'Productive rejected the API token. Update the connection.';
      }
      return `Productive request failed${
        error.status === null ? '' : ` (HTTP ${error.status})`
      }.`;
    }
    return 'Could not reach Productive.';
  }

  async function connectionView(): Promise<ConnectionView> {
    const [token, settings] = await Promise.all([
      readToken(),
      readConnectionSettings()
    ]);
    const configured = token !== null && settings.organizationId !== '';
    if (!configured) {
      return {
        configured: false,
        organizationId: settings.organizationId,
        personId: settings.personId,
        viewerName: null,
        available: false,
        message: 'Add a Productive API token and organization id to connect.'
      };
    }
    const api = await currentApi();
    if (api === null) {
      return {
        configured,
        organizationId: settings.organizationId,
        personId: settings.personId,
        viewerName: null,
        available: false,
        message: 'Connection is incomplete.'
      };
    }
    // Productive has no /me endpoint: the viewer is only known when the user
    // supplied their person id. Resolve that one person directly and cache it
    // — this runs on every board open, and paging all 400+ people to find one
    // name was a real contributor to hitting Productive's rate limit.
    let viewerName: string | null = null;
    try {
      if (settings.personId !== '') {
        const cacheKey = `${settings.organizationId}:${settings.personId}`;
        if (viewerCache?.key === cacheKey) {
          viewerName = viewerCache.name;
        } else {
          viewerName = (await api.getPerson(settings.personId))?.name ?? null;
          viewerCache = { key: cacheKey, name: viewerName };
        }
      } else {
        await api.listProjects({ limit: 1 });
      }
    } catch (error) {
      return {
        configured,
        organizationId: settings.organizationId,
        personId: settings.personId,
        viewerName: null,
        available: false,
        message: safeMessage(error)
      };
    }
    return {
      configured,
      organizationId: settings.organizationId,
      personId: settings.personId,
      viewerName,
      available: true,
      message: null
    };
  }

  async function requireApi(): Promise<ProductiveApi> {
    const api = await currentApi();
    if (api === null) {
      throw new Error(
        'Productive is not connected. Set the API token and organization id first.'
      );
    }
    return api;
  }

  // -------------------------------------------------------------------------
  // Mapping tasks onto the board model
  // -------------------------------------------------------------------------

  async function organizationId(): Promise<string> {
    return (await readConnectionSettings()).organizationId;
  }

  function toWorkItem(
    task: ProductiveTask,
    bbProjectId: string,
    orgId: string
  ): WorkItem {
    return {
      bbProjectId,
      locator: task.id,
      key: task.key,
      title: task.title,
      description: task.description,
      url:
        task.url ||
        `${PRODUCTIVE_APP_ORIGIN}/${encodeURIComponent(
          orgId
        )}/task/${encodeURIComponent(task.id)}`,
      status: task.status.name,
      statusId: task.status.id,
      stateCategory: task.status.stateCategory,
      assignee: task.assignee?.name ?? null,
      assigneeId: task.assignee?.id ?? task.assigneeId ?? null,
      project: task.project?.name ?? null,
      productiveProjectId: task.project?.id ?? null,
      folder: task.folderName ?? null,
      folderId: task.folderId ?? null,
      taskList: task.taskList?.name ?? null,
      taskListId: task.taskListId ?? null,
      labels: task.labels ?? [],
      dueDate: task.dueDate ?? null,
      updatedAt: task.updatedAt
    };
  }

  async function toWorkItemDetail(
    task: ProductiveTask,
    bbProjectId: string,
    api: ProductiveApi,
    orgId: string
  ): Promise<WorkItemDetail> {
    const [comments, attachments] = await Promise.all([
      api.getTaskComments(task.id),
      api.listTaskAttachments(task.id)
    ]);
    return {
      ...toWorkItem(task, bbProjectId, orgId),
      comments: comments.map(comment => ({
        author: comment.user?.name ?? 'Unknown',
        body: comment.body,
        createdAt: comment.createdAt,
        attachments: (comment.attachments ?? []).map(toWorkAttachment)
      })),
      attachments: attachments.map(toWorkAttachment)
    };
  }

  function toWorkAttachment(attachment: ProductiveAttachment): WorkAttachment {
    return {
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
      thumbUrl: attachment.thumbUrl ?? null,
      isImage: attachment.isImage,
      createdAt: attachment.createdAt
    };
  }

  // -------------------------------------------------------------------------
  // Scope + sync
  // -------------------------------------------------------------------------

  const SCOPE_DEFAULTS: ProjectScopeDefaults = {
    productiveProjectId: '',
    folderId: '',
    taskListId: '',
    assignedToMeOnly: false,
    includeClosed: false
  };

  async function scopeView(projectId: string): Promise<ProjectScopeView> {
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    const [token, settings] = await Promise.all([
      readToken(),
      readConnectionSettings()
    ]);
    let productiveProjectName: string | null = null;
    if (scope.productiveProjectId !== '') {
      // Cached items carry the project name, so the common case needs no call.
      const [sample] = store.list({ projectId, limit: 1 });
      productiveProjectName = sample?.project ?? null;
    }
    const [sample] = store.list({ projectId, limit: 1 });
    return {
      ...scope,
      productiveProjectName,
      folderName: scope.folderId === '' ? null : (sample?.folder ?? null),
      taskListName: scope.taskListId === '' ? null : (sample?.taskList ?? null),
      connectionConfigured: token !== null && settings.organizationId !== ''
    };
  }

  // Guards against a slow sync writing results for a scope the user has since
  // changed. Bumped on every scope or connection change.
  const revisions = new Map<string, number>();
  function revision(projectId: string): number {
    return revisions.get(projectId) ?? 0;
  }
  function advanceRevision(projectId: string): number {
    const next = revision(projectId) + 1;
    revisions.set(projectId, next);
    return next;
  }

  async function syncProject(projectId: string): Promise<BoardStatus> {
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    if (scope.productiveProjectId === '') {
      return store.syncStatus(projectId);
    }
    const startedAt = revision(projectId);
    try {
      const api = await requireApi();
      const settings = await readConnectionSettings();
      const tasks = await api.listTasks({
        projectId: scope.productiveProjectId,
        folderId: scope.folderId === '' ? undefined : scope.folderId,
        taskListId: scope.taskListId === '' ? undefined : scope.taskListId,
        assigneeId:
          scope.assignedToMeOnly && settings.personId !== ''
            ? settings.personId
            : undefined,
        status: scope.includeClosed ? 'all' : 'open',
        // Without an explicit limit this silently stopped at the API default
        // and the board showed a truncated project.
        limit: BOARD_TASK_LIMIT
      });
      if (revision(projectId) !== startedAt) return store.syncStatus(projectId);
      const items = tasks.map(task =>
        toWorkItem(task, projectId, settings.organizationId)
      );
      store.replaceAll(projectId, items, new Date().toISOString());
    } catch (error) {
      bb.log.warn(`sync failed for ${projectId}: ${safeMessage(error)}`);
      store.setSyncError(projectId, safeMessage(error));
    }
    const status = store.syncStatus(projectId);
    bb.realtime.publish(ITEMS_CHANGED, { projectId });
    return status;
  }

  /**
   * Read a single task straight from Productive and refresh its cache row.
   *
   * Publishes ITEMS_CHANGED only when the cached row actually changed. The
   * guard lives here, where every caller routes through, because the naive
   * "publish on every refresh" version created a feedback loop: opening a task
   * called getItem -> refreshItem -> publish, the detail view's ITEMS_CHANGED
   * subscriber refetched, and the board hammered Productive until it returned
   * "Rate limit reached". A read that finds nothing new is not a change.
   */
  async function refreshItem(
    projectId: string,
    locator: string
  ): Promise<WorkItemDetail> {
    const api = await requireApi();
    const orgId = await organizationId();
    const task = await api.getTask(locator);
    if (task === null) throw new Error(`No Productive task ${locator}`);
    const detail = await toWorkItemDetail(task, projectId, api, orgId);
    const { comments: _comments, attachments: _attachments, ...item } = detail;
    const previous = store.get(projectId, locator);
    store.upsert(projectId, item);
    if (previous === null || !sameWorkItem(previous, item)) {
      bb.realtime.publish(ITEMS_CHANGED, { projectId });
    }
    return detail;
  }

  /** A ticket-per-worktree keeps parallel tickets from colliding in one checkout. */
  function threadEnvironment(
    kind: 'project-default' | 'worktree'
  ): Parameters<typeof bb.sdk.threads.spawn>[0]['environment'] {
    return kind === 'worktree'
      ? {
          type: 'host',
          workspace: {
            type: 'managed-worktree',
            baseBranch: { kind: 'default' }
          }
        }
      : { type: 'project-default' };
  }

  async function startThreadForScope(
    projectId: string,
    locator: string,
    environment: 'project-default' | 'worktree'
  ): Promise<{ threadId: string; title: string }> {
    const detail = await refreshItem(projectId, locator);
    const { comments: _comments, attachments: _attachments, ...item } = detail;
    const title = threadTitleForItem(item);
    const groupId = groupIdFromScope(projectId);
    if (groupId !== null) {
      const thread = await bb.sdk.plugins.callRpc({
        pluginId: 'sidebar',
        method: 'group_start_thread',
        input: {
          groupId,
          prompt: formatWorkItemHandoffPrompt(detail)
        },
        outputSchema: sidebarStartSchema
      });
      return { threadId: thread.threadId, title };
    }
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: threadEnvironment(environment),
      title,
      prompt: formatWorkItemHandoffPrompt(detail)
    });
    return { threadId: thread.id, title };
  }

  /** Field-wise equality; the cache row is flat, so a shallow compare is enough. */
  function sameWorkItem(left: WorkItem, right: WorkItem): boolean {
    const keys = Object.keys(right) as (keyof WorkItem)[];
    return keys.every(key => {
      const leftValue = left[key];
      const rightValue = right[key];
      if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        return (
          leftValue.length === rightValue.length &&
          leftValue.every((entry, index) => entry === rightValue[index])
        );
      }
      return leftValue === rightValue;
    });
  }

  async function statusOptionsFor(
    projectId: string,
    locator: string
  ): Promise<WorkStatusOption[]> {
    const api = await requireApi();
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    const cached = store.get(projectId, locator);
    const workflowId =
      scope.productiveProjectId === ''
        ? null
        : await api.getProjectWorkflowId(scope.productiveProjectId);
    const statuses = await api.listWorkflowStatuses(
      workflowId === null ? undefined : { workflowId }
    );
    return statuses.map(status => ({
      id: status.id,
      name: status.name,
      stateCategory: status.stateCategory,
      current: cached?.statusId === status.id
    }));
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(productiveRpcContract, {
    listProjects: async () => {
      return { projects: await trackerTargets() };
    },
    threadProject: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const group = (await sidebarGroups()).find(candidate =>
        candidate.coordinatorThreadIds.includes(threadId)
      );
      if (group) return { projectId: groupScopeId(group.id) };
      return { projectId: thread.projectId };
    },
    getConnection: async () => ({ connection: await connectionView() }),
    saveConnection: async input => {
      await bb.storage.kv.set('connection', {
        organizationId: input.organizationId,
        personId: input.personId
      });
      if (input.apiToken.operation === 'set') {
        await writeSecretFile(tokenPath, input.apiToken.value);
      } else if (input.apiToken.operation === 'clear') {
        await deleteSecretFile(tokenPath);
      }
      apiCache = null;
      viewerCache = null;
      for (const projectId of store.configuredProjectIds()) {
        advanceRevision(projectId);
      }
      const connection = await connectionView();
      bb.realtime.publish(CONNECTION_CHANGED, {
        configured: connection.configured
      });
      return { connection };
    },
    status: async ({ projectId }) => ({ status: store.syncStatus(projectId) }),
    listItems: async ({ projectId, query, stateCategories, limit }) => ({
      items: store.list({ projectId, query, stateCategories, limit })
    }),
    refresh: async ({ projectId }) => {
      const status = await syncProject(projectId);
      return { status, itemCount: status.itemCount };
    },
    getItem: async ({ projectId, locator }) => ({
      item: await refreshItem(projectId, locator)
    }),
    statusOptions: async ({ projectId, locator }) => ({
      options: await statusOptionsFor(projectId, locator)
    }),
    updateItemStatus: async ({ projectId, locator, statusId }) => {
      const api = await requireApi();
      await api.updateTask(locator, { workflowStatusId: statusId });
      const detail = await refreshItem(projectId, locator);
      const { comments: _comments, ...item } = detail;
      return { item };
    },
    updateItemAssignee: async ({ projectId, locator, assigneeId }) => {
      const api = await requireApi();
      await api.updateTask(locator, { assigneeId });
      const detail = await refreshItem(projectId, locator);
      const { comments: _comments, ...item } = detail;
      return { item };
    },
    updateItemContent: async ({ projectId, locator, title, description }) => {
      const api = await requireApi();
      await api.updateTask(locator, { title, description });
      return { item: await refreshItem(projectId, locator) };
    },
    archiveItem: async ({ projectId, locator }) => {
      const api = await requireApi();
      await api.archiveTask(locator);
      store.remove(projectId, locator);
      bb.realtime.publish(ITEMS_CHANGED, { projectId });
      return { archived: true as const };
    },
    updateItemTaskList: async ({ projectId, locator, taskListId }) => {
      const api = await requireApi();
      await api.updateTask(locator, { taskListId });
      const detail = await refreshItem(projectId, locator);
      const { comments: _comments, attachments: _attachments, ...item } = detail;
      return { item };
    },
    addComment: async ({ projectId, locator, body, attachments }) => {
      const api = await requireApi();
      const comment = await api.addTaskComment(locator, body);
      const warnings: string[] = [];
      for (const attachment of attachments) {
        try {
          await api.uploadCommentAttachment(
            comment.id,
            decodeUiAttachment(attachment)
          );
        } catch (error) {
          warnings.push(
            `Could not attach ${attachment.name}: ${safeMessage(error)}`
          );
        }
      }
      return {
        item: await refreshItem(projectId, locator),
        warnings
      };
    },
    uploadItemAttachment: async ({ projectId, locator, attachment }) => {
      const api = await requireApi();
      await api.uploadTaskAttachment(locator, decodeUiAttachment(attachment));
      return { item: await refreshItem(projectId, locator) };
    },
    getCreateTaskContext: async ({ projectId }) => {
      const project = (await trackerTargets()).find(
        candidate => candidate.id === projectId
      );
      const scope = await scopeView(projectId);
      const connection = await connectionView();
      return {
        context: {
          projectId,
          projectName: project?.name ?? projectId,
          available:
            connection.available && scope.productiveProjectId !== '',
          message:
            !connection.configured
              ? 'Productive is not connected.'
              : scope.productiveProjectId === ''
                ? 'This bb project is not mapped to a Productive project yet.'
                : connection.message,
          productiveProjectId:
            scope.productiveProjectId === '' ? null : scope.productiveProjectId,
          productiveProjectName: scope.productiveProjectName
        }
      };
    },
    getCreateTaskMetadata: async ({ projectId }) => {
      const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
      if (scope.productiveProjectId === '') {
        return {
          ok: false as const,
          error: {
            code: 'metadata_unavailable' as const,
            safeMessage:
              'This bb project is not mapped to a Productive project yet.'
          }
        };
      }
      try {
        const api = await requireApi();
        const { personId } = await readConnectionSettings();
        const workflowId = await api.getProjectWorkflowId(
          scope.productiveProjectId
        );
        const [statuses, taskLists, people] = await Promise.all([
          api.listWorkflowStatuses(
            workflowId === null ? undefined : { workflowId }
          ),
          api.listTaskLists(scope.productiveProjectId),
          api.listAssignablePeople({
            projectId: scope.productiveProjectId,
            preferredPersonId: personId
          })
        ]);
        const defaultStatus =
          statuses.find(status => status.categoryId === 1) ?? statuses[0];
        return {
          ok: true as const,
          metadata: {
            statusOptions: statuses.map(status => ({
              id: status.id,
              label: status.name
            })),
            assigneeOptions: people.map(person => ({
              id: person.id,
              label: person.name
            })),
            taskListOptions: taskLists.map(taskList => ({
              id: taskList.id,
              label: taskList.name
            })),
            defaultStatusId: defaultStatus?.id ?? null,
            defaultTaskListId:
              scope.taskListId === ''
                ? (taskLists[0]?.id ?? null)
                : scope.taskListId
          },
          connectorRevision: revision(projectId)
        };
      } catch (error) {
        return {
          ok: false as const,
          error: {
            code: 'metadata_unavailable' as const,
            safeMessage: safeMessage(error)
          }
        };
      }
    },
    createTask: async input => createTask(input),
    startThread: async ({ projectId, locator, environment }) => {
      // The task is re-read rather than taken from cache so the agent starts
      // from what Productive says right now, not a stale board row.
      return startThreadForScope(projectId, locator, environment);
    },
    getProjectScope: async ({ projectId }) => ({
      scope: await scopeView(projectId)
    }),
    saveProjectScope: async scope => {
      store.saveProjectScope(scope);
      advanceRevision(scope.projectId);
      void syncProject(scope.projectId);
      return { scope: await scopeView(scope.projectId) };
    },
    listProductiveProjects: async ({ query }) => {
      const api = await requireApi();
      const projects = await api.listProjects({ query, limit: 200 });
      return {
        projects: projects.map(project => ({
          id: project.id,
          name: project.name,
          number: project.number ?? null
        }))
      };
    },
    listProductiveFolders: async ({ productiveProjectId }) => {
      const api = await requireApi();
      const folders = await api.listFolders(productiveProjectId);
      return {
        folders: folders.map(folder => ({ id: folder.id, name: folder.name }))
      };
    },
    listProductiveTaskLists: async ({ productiveProjectId, folderId }) => {
      const api = await requireApi();
      const taskLists = await api.listTaskLists(productiveProjectId, {
        folderId: folderId === '' ? undefined : folderId
      });
      return {
        taskLists: taskLists.map(taskList => ({
          id: taskList.id,
          name: taskList.name,
          folderId: taskList.folderId ?? null,
          folderName: taskList.folderName ?? null
        }))
      };
    },
    getBoardView: async ({ projectId }) => {
      const stored = store.readBoardView(projectId);
      if (stored === null) return { view: null };
      // A stale row from an older schema must not stop the board opening.
      const parsed = boardViewStateSchema.safeParse(stored);
      return { view: parsed.success ? parsed.data : null };
    },
    saveBoardView: async ({ projectId, view }) => {
      store.writeBoardView(projectId, view);
      return { saved: true as const };
    },
    getProjectBoardSettings: async ({ projectId }) => ({
      settings: store.boardSettings(projectId)
    }),
    saveProjectBoardSettings: async settings => {
      store.saveBoardSettings(settings);
      return { settings };
    },
    listFilterPresets: async ({ projectId }) => ({
      presets: store.listPresets(projectId)
    }),
    saveFilterPreset: async ({ projectId, id, name, state }) => {
      const saved = store.savePreset({ projectId, id, name, state });
      const preset = filterPresetSummary(saved);
      const presets = store.listPresets(projectId);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { preset, presets };
    },
    deleteFilterPreset: async ({ projectId, id }) => {
      const presets = store.deletePreset(projectId, id);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { presets };
    },
    reorderFilterPresets: async ({ projectId, ids }) => {
      const presets = store.reorderPresets(projectId, ids);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { presets };
    }
  });

  const CONTENT_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  function contentTypeFor(name: string): string {
    return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
  }

  /**
   * Upload local files onto a task. `bb productive create --attach` is meant
   * for callers running on the same machine as the server — the bb-plugin-inbox
   * bridge stages Gmail attachments in the server's own tmpdir before calling.
   * ponytail: server-local reads only; route through bb.sdk.files with an
   * explicit hostId if remote machines ever need to attach their own files.
   */
  async function attachFiles(
    taskId: string,
    paths: readonly string[]
  ): Promise<{ uploaded: string[]; warnings: string[] }> {
    if (paths.length === 0) return { uploaded: [], warnings: [] };
    const api = await requireApi();
    const uploaded: string[] = [];
    const warnings: string[] = [];
    for (const path of paths) {
      const name = basename(path);
      try {
        const bytes = await readFile(path);
        await api.uploadTaskAttachment(taskId, {
          name,
          contentType: contentTypeFor(name),
          bytes
        });
        uploaded.push(name);
      } catch (error) {
        warnings.push(
          `Could not attach ${name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return { uploaded, warnings };
  }

  function decodeUiAttachment(attachment: AttachmentUploadInput): {
    name: string;
    contentType: string;
    bytes: Uint8Array;
  } {
    const bytes = Buffer.from(attachment.base64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UI_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments must be between 1 byte and ${MAX_UI_ATTACHMENT_BYTES} bytes.`
      );
    }
    return {
      name: attachment.name,
      contentType: attachment.contentType || 'application/octet-stream',
      bytes
    };
  }

  /**
   * The task list a new task lands in: the caller's choice, else the project's
   * configured default, else its first list. Productive has no "no list" state.
   */
  async function resolveTaskListId(
    productiveProjectId: string,
    requested: string | null
  ): Promise<string> {
    if (requested !== null && requested !== '') return requested;
    const api = await requireApi();
    const taskLists = await api.listTaskLists(productiveProjectId);
    const first = taskLists[0];
    if (first === undefined) {
      throw new Error(
        'This Productive project has no task lists, so a task cannot be created in it. Add one in Productive first.'
      );
    }
    return first.id;
  }

  async function createTask(input: CreateTaskInput) {
    const scope = store.projectScope(input.projectId, SCOPE_DEFAULTS);
    if (scope.productiveProjectId === '') {
      throw new Error('This bb project is not mapped to a Productive project.');
    }
    if (input.connectorRevision !== revision(input.projectId)) {
      throw new Error(
        'The Productive connection changed while this form was open. Reopen it and try again.'
      );
    }
    const api = await requireApi();
    const orgId = await organizationId();
    // Productive rejects a task with no task list ("task_list can't be blank").
    // The create form already falls back to the project's first list; do the
    // same here so the CLI and other plugins are not the odd one out.
    const taskListId = await resolveTaskListId(
      scope.productiveProjectId,
      input.taskListId ?? (scope.taskListId === '' ? null : scope.taskListId)
    );
    const created = await api.createTask({
      projectId: scope.productiveProjectId,
      taskListId,
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeId ?? undefined,
      workflowStatusId: input.statusId ?? undefined,
      dueDate: input.dueDate ?? undefined
    });
    const item = toWorkItem(created, input.projectId, orgId);
    store.upsert(input.projectId, item);
    bb.realtime.publish(ITEMS_CHANGED, { projectId: input.projectId });

    // Productive silently drops an assignee the caller may not assign, so the
    // result is reported rather than assumed.
    const warnings: string[] = [];
    const requestedAssignee = input.assigneeId;
    const assigneeConfirmation =
      requestedAssignee === null
        ? ({ confirmed: true, id: null } as const)
        : item.assigneeId === requestedAssignee
          ? ({ confirmed: true, id: item.assigneeId } as const)
          : ({ confirmed: false } as const);
    if (assigneeConfirmation.confirmed === false) {
      warnings.push('Productive did not apply the requested assignee.');
    }
    if (input.statusId !== null && item.statusId !== input.statusId) {
      warnings.push('Productive did not apply the requested status.');
    }

    return {
      item,
      warnings,
      assigneeConfirmation,
      mention: {
        provider: 'productive-task' as const,
        id: mentionId(item),
        label: item.key
      }
    };
  }

  // -------------------------------------------------------------------------
  // Composer mentions
  // -------------------------------------------------------------------------

  bb.ui.registerMentionProvider({
    id: 'productive-task',
    label: 'Productive',
    triggers: ['@', '#'],
    async search({ query, projectId }) {
      if (typeof projectId !== 'string') return [];
      const trimmed = query.trim();
      return store
        .list({ projectId, query: trimmed, limit: 10 })
        .map(item => ({
          id: mentionId(item),
          title: `${item.key} ${item.title}`,
          subtitle: `Productive · ${item.status}${
            item.assignee === null ? '' : ` · ${item.assignee}`
          }`
        }));
    },
    async resolve(id) {
      const parsed = parseMentionId(id);
      const item =
        parsed === null ? null : store.get(parsed.projectId, parsed.locator);
      if (item === null) {
        // The mention outlived its cache row (task deleted, or the project was
        // remapped). Say so rather than silently dropping the reference.
        return {
          context: `Productive task ${id} is no longer in this project's board cache.`
        };
      }
      return { context: formatWorkItemContext(item) };
    }
  });

  // -------------------------------------------------------------------------
  // Connection interaction (the form app.tsx renders for `productive-connection`)
  // -------------------------------------------------------------------------

  async function requestConnectionInput(
    threadId: string,
    signal: AbortSignal | undefined
  ): Promise<ConnectionView | null> {
    const [token, settings] = await Promise.all([
      readToken(),
      readConnectionSettings()
    ]);
    const result = await bb.ui.requestInput(
      {
        threadId,
        rendererId: 'productive-connection',
        title: 'Connect Productive',
        payload: {
          organizationId: settings.organizationId,
          personId: settings.personId,
          tokenConfigured: token !== null
        }
      },
      { signal }
    );
    if (result.outcome !== 'submitted') return null;
    const response = connectionInteractionResponseSchema.parse(result.value);
    await bb.storage.kv.set('connection', {
      organizationId: response.organizationId,
      personId: response.personId
    });
    if (response.apiToken.operation === 'set') {
      await writeSecretFile(tokenPath, response.apiToken.value);
    } else if (response.apiToken.operation === 'clear') {
      await deleteSecretFile(tokenPath);
    }
    apiCache = null;
    viewerCache = null;
    const connection = await connectionView();
    bb.realtime.publish(CONNECTION_CHANGED, {
      configured: connection.configured
    });
    return connection;
  }

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  const usage = [
    'Usage:',
    '  bb productive status [--project <proj_id>] [--json]',
    '  bb productive list [--project <proj_id>] [--query <text>] [--state <todo|in_progress|done>] [--cached] [--json]',
    '  bb productive show <locator> [--project <proj_id>] [--json]',
    '  bb productive start <locator> [--worktree] [--project <proj_id>] [--json]',
    '  bb productive transitions <locator> [--project <proj_id>] [--json]',
    '  bb productive move <locator> --status <status-id> [--project <proj_id>] [--json]',
    '  bb productive move-list <locator> --list <task-list-id> [--project <proj_id>] [--json]',
    '  bb productive comment <locator> <text> [--project <proj_id>] [--json]',
    '  bb productive edit <locator> [--title <text>] [--description <text>] [--project <proj_id>] [--json]',
    '  bb productive create --title <text> [--description <text>] [--list <task-list-id>]',
    '                       [--status <status-id>] [--assignee <person-id>] [--due <YYYY-MM-DD>]',
    '                       [--attach <file-path>]... [--project <proj_id>] [--json]',
    '  bb productive lists [--project <proj_id>] [--json]',
    '  bb productive refresh [--project <proj_id>] [--json]',
    '  bb productive config [--project <proj_id>] [--productive-project <id>] [--folder <id>] [--list <id>]',
    '                       [--assigned-to-me <on|off>] [--include-closed <on|off>] [--json]',
    '  bb productive connect [--json]',
    '  bb productive connect --org <organization-id> [--person <person-id>] --token-file <path>',
    '  bb productive disconnect [--json]',
    '  bb productive presets list [--project <proj_id>] [--json]'
  ].join('\n');

  function formatItem(item: WorkItem): string {
    return [
      item.key.padEnd(8),
      item.status.padEnd(14),
      (item.assignee ?? '—').padEnd(16),
      item.title
    ].join('  ');
  }

  bb.cli.register({
    name: 'productive',
    summary: 'Browse and update the current project\'s Productive tasks',
    commands: [
      {
        name: 'status',
        summary: 'Show the project mapping, last sync, and task count',
        usage: 'bb productive status [--project <proj_id>] [--json]'
      },
      {
        name: 'list',
        summary: 'List the project\'s Productive tasks',
        usage:
          'bb productive list [--project <proj_id>] [--query <text>] [--state <todo|in_progress|done>] [--cached] [--json]'
      },
      {
        name: 'show',
        summary: 'Show one task with its description and comments',
        usage: 'bb productive show <locator> [--project <proj_id>] [--json]'
      },
      {
        name: 'start',
        summary: 'Start a bb thread to work on a task',
        usage:
          'bb productive start <locator> [--worktree] [--project <proj_id>] [--json]'
      },
      {
        name: 'transitions',
        summary: 'List the workflow statuses a task can move to',
        usage: 'bb productive transitions <locator> [--json]'
      },
      {
        name: 'move',
        summary: 'Move a task to another workflow status',
        usage: 'bb productive move <locator> --status <status-id> [--json]'
      },
      {
        name: 'move-list',
        summary: "Move a task to another task list (the board's lanes)",
        usage: 'bb productive move-list <locator> --list <task-list-id> [--json]'
      },
      {
        name: 'comment',
        summary: 'Add a comment to a task',
        usage: 'bb productive comment <locator> <text> [--json]'
      },
      {
        name: 'edit',
        summary: "Edit a task's title or description",
        usage:
          'bb productive edit <locator> [--title <text>] [--description <text>] [--json]'
      },
      {
        name: 'create',
        summary: 'Create a task in the mapped Productive project',
        usage: 'bb productive create --title <text> [--description <text>] [--list <id>] [--attach <file-path>]... [--json]'
      },
      {
        name: 'lists',
        summary: "Task lists of the project's Productive project",
        usage: 'bb productive lists [--project <proj_id>] [--json]'
      },
      {
        name: 'refresh',
        summary: 'Force a sync with Productive',
        usage: 'bb productive refresh [--project <proj_id>] [--json]'
      },
      {
        name: 'config',
        summary: 'Show or change this bb project\'s Productive mapping',
        usage:
          'bb productive config [--productive-project <id>] [--folder <id>] [--list <id>] [--json]'
      },
      {
        name: 'connect',
        summary:
          'Show the Productive connection, or set it with --org and --token-file',
        usage:
          'bb productive connect [--org <id> [--person <id>] --token-file <path>] [--json]'
      },
      {
        name: 'disconnect',
        summary: 'Remove the stored Productive API token',
        usage: 'bb productive disconnect [--json]'
      },
      {
        name: 'presets',
        summary: 'List the board\'s saved filter presets',
        usage: 'bb productive presets list [--project <proj_id>] [--json]'
      }
    ],
    async run(argv, context) {
      const json = argv.includes('--json');
      const cached = argv.includes('--cached');
      const args = argv.filter(arg => arg !== '--json' && arg !== '--cached');
      const [command, ...rest] = positionalArgs(argv);

      const projectId =
        flagValue(args, '--project') ?? context?.projectId ?? null;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const needProject = () =>
        fail(
          'No bb project in context. Pass --project <proj_id>. Run "bb project list" to see ids.'
        );

      try {
        switch (command) {
          case undefined:
          case 'help':
          case '--help':
            return { exitCode: 0, stdout: usage };

          case 'disconnect': {
            await deleteSecretFile(tokenPath);
            apiCache = null;
      viewerCache = null;
            const connection = await connectionView();
            bb.realtime.publish(CONNECTION_CHANGED, { configured: false });
            return reply(connection, 'Disconnected. The stored token was removed.');
          }

          case 'connect': {
            // Why a file and not a flag value: a plugin CLI command runs inside
            // the BB server, so it has no stdin to pipe a secret through. A path
            // keeps the token out of argv, shell history, and agent transcripts.
            const tokenFile = flagValue(args, '--token-file');
            if (tokenFile !== null) {
              const organization = flagValue(args, '--org');
              if (organization === null || organization === '') {
                return fail(
                  'Pass --org <organization-id> with --token-file. Find it in your Productive URL.'
                );
              }
              let token: string;
              try {
                token = (await readFile(tokenFile, 'utf8')).trim();
              } catch {
                return fail(`Could not read a token from ${tokenFile}.`);
              }
              if (token === '') {
                return fail(`${tokenFile} is empty.`);
              }
              if (/[\r\n]/u.test(token)) {
                return fail('The API token must be a single line.');
              }
              await bb.storage.kv.set('connection', {
                organizationId: organization,
                personId: flagValue(args, '--person') ?? ''
              });
              await writeSecretFile(tokenPath, token);
              apiCache = null;
      viewerCache = null;
              const saved = await connectionView();
              bb.realtime.publish(CONNECTION_CHANGED, {
                configured: saved.configured
              });
              return reply(
                saved,
                saved.available
                  ? `Connected to organization ${saved.organizationId}${
                      saved.viewerName === null ? '' : ` as ${saved.viewerName}`
                    }`
                  : `Saved, but Productive is not reachable: ${saved.message ?? 'unknown error'}`
              );
            }
            const connection = await connectionView();
            return reply(
              connection,
              connection.configured
                ? `Connected to organization ${connection.organizationId}${
                    connection.viewerName === null
                      ? ''
                      : ` as ${connection.viewerName}`
                  }${
                    connection.available
                      ? ''
                      : ` — ${connection.message ?? 'unavailable'}`
                  }`
                : 'Not connected. Open the Productive panel in BB, or run:\n'
                  + '  bb productive connect --org <organization-id> --token-file <path>'
            );
          }

          case 'status': {
            if (projectId === null) return needProject();
            const [scope, status] = await Promise.all([
              scopeView(projectId),
              Promise.resolve(store.syncStatus(projectId))
            ]);
            return reply({ scope, status }, [
              `bb project:          ${projectId}`,
              `Productive project:  ${
                scope.productiveProjectId === ''
                  ? 'not mapped'
                  : `${scope.productiveProjectName ?? 'unknown'} (${scope.productiveProjectId})`
              }`,
              `Folder filter:       ${scope.folderId || 'all'}`,
              `Task list filter:    ${scope.taskListId || 'all'}`,
              `Assigned to me only: ${scope.assignedToMeOnly ? 'yes' : 'no'}`,
              `Include closed:      ${scope.includeClosed ? 'yes' : 'no'}`,
              `Last synced:         ${status.lastSyncedAt ?? 'never'}`,
              `Tasks cached:        ${status.itemCount}`,
              ...(status.message === null ? [] : [`Error:               ${status.message}`])
            ].join('\n'));
          }

          case 'list': {
            if (projectId === null) return needProject();
            if (!cached) await syncProject(projectId);
            const state = flagValue(args, '--state');
            const stateCategories =
              state === null ? undefined : [state as WorkStateCategory];
            const items = store.list({
              projectId,
              query: flagValue(args, '--query') ?? undefined,
              stateCategories,
              limit: 200
            });
            return reply(
              items,
              items.length === 0
                ? 'No tasks.'
                : items.map(formatItem).join('\n')
            );
          }

          case 'show': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            if (locator === undefined) return fail(usage);
            const item = await refreshItem(projectId, locator);
            return reply(item, formatWorkItemContext(item));
          }

          case 'start': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            if (locator === undefined) return fail(usage);
            const worktree = argv.includes('--worktree');
            const thread = await startThreadForScope(
              projectId,
              locator,
              worktree ? 'worktree' : 'project-default'
            );
            return reply(
              { ...thread, locator, worktree },
              `Started thread ${thread.threadId}${worktree && groupIdFromScope(projectId) === null ? ' in a new worktree' : ''} — ${thread.title}`
            );
          }

          case 'transitions': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            if (locator === undefined) return fail(usage);
            const options = await statusOptionsFor(projectId, locator);
            return reply(
              options,
              options
                .map(
                  option =>
                    `${option.current ? '*' : ' '} ${option.id.padEnd(10)} ${option.name} (${option.stateCategory})`
                )
                .join('\n')
            );
          }

          case 'move': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const statusId = flagValue(args, '--status');
            if (locator === undefined || statusId === null) return fail(usage);
            const api = await requireApi();
            await api.updateTask(locator, { workflowStatusId: statusId });
            const item = await refreshItem(projectId, locator);
            return reply(item, `Moved ${item.key} to ${item.status}`);
          }

          case 'move-list': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const taskListId = flagValue(args, '--list');
            if (locator === undefined || taskListId === null) return fail(usage);
            const api = await requireApi();
            await api.updateTask(locator, { taskListId });
            const item = await refreshItem(projectId, locator);
            return reply(
              item,
              `Moved ${item.key} to ${item.taskList ?? 'no task list'}`
            );
          }

          case 'comment': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const body = rest.slice(1).join(' ').trim();
            if (locator === undefined || body === '') return fail(usage);
            const api = await requireApi();
            await api.addTaskComment(locator, body);
            const item = await refreshItem(projectId, locator);
            return reply(
              { locator, added: true },
              `Commented on ${item.key}`
            );
          }

          case 'edit': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const title = flagValue(args, '--title');
            const description = flagValue(args, '--description');
            if (locator === undefined) return fail(usage);
            if (title === null && description === null) {
              return fail(
                'Pass --title and/or --description with the new value.'
              );
            }
            const api = await requireApi();
            await api.updateTask(locator, {
              ...(title === null ? {} : { title }),
              ...(description === null ? {} : { description })
            });
            const item = await refreshItem(projectId, locator);
            return reply(
              item,
              `Updated ${item.key}: ${item.title}`
            );
          }

          case 'create': {
            if (projectId === null) return needProject();
            const title = flagValue(args, '--title');
            if (title === null) return fail(usage);
            const result = await createTask({
              projectId,
              connectorRevision: revision(projectId),
              title,
              description: flagValue(args, '--description') ?? '',
              taskListId: flagValue(args, '--list'),
              statusId: flagValue(args, '--status'),
              assigneeId: flagValue(args, '--assignee'),
              dueDate: flagValue(args, '--due')
            });
            const attached = await attachFiles(
              result.item.locator,
              flagValues(args, '--attach')
            );
            return reply(
              { ...result, attachments: attached.uploaded },
              [
                `Created ${result.item.key}: ${result.item.title}`,
                result.item.url,
                ...(attached.uploaded.length === 0
                  ? []
                  : [`Attached ${attached.uploaded.join(', ')}`]),
                ...attached.warnings,
                ...result.warnings
              ].join('\n')
            );
          }

          case 'lists': {
            if (projectId === null) return needProject();
            const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
            if (scope.productiveProjectId === '') {
              return fail('This bb project is not mapped to a Productive project.');
            }
            const api = await requireApi();
            const taskLists = await api.listTaskLists(scope.productiveProjectId);
            const options = taskLists.map(taskList => ({
              id: taskList.id,
              name: taskList.name,
              isDefault:
                scope.taskListId === ''
                  ? taskList.id === taskLists[0]?.id
                  : taskList.id === scope.taskListId
            }));
            return reply(
              options,
              options.length === 0
                ? 'This Productive project has no task lists.'
                : options
                    .map(option => `${option.isDefault ? '*' : ' '} ${option.id}  ${option.name}`)
                    .join('\n')
            );
          }

          case 'refresh': {
            if (projectId === null) return needProject();
            const status = await syncProject(projectId);
            return reply(
              status,
              status.message === null
                ? `Synced ${status.itemCount} tasks.`
                : `Sync failed: ${status.message}`
            );
          }

          case 'config': {
            if (projectId === null) return needProject();
            const current = store.projectScope(projectId, SCOPE_DEFAULTS);
            const onOff = (flag: string, fallback: boolean): boolean => {
              const value = flagValue(args, flag);
              if (value === null) return fallback;
              return value === 'on' || value === 'true' || value === 'yes';
            };
            const next: ProjectScope = {
              projectId,
              productiveProjectId:
                flagValue(args, '--productive-project') ??
                current.productiveProjectId,
              folderId: flagValue(args, '--folder') ?? current.folderId,
              taskListId: flagValue(args, '--list') ?? current.taskListId,
              assignedToMeOnly: onOff(
                '--assigned-to-me',
                current.assignedToMeOnly
              ),
              includeClosed: onOff('--include-closed', current.includeClosed)
            };
            const changed =
              JSON.stringify(next) !== JSON.stringify(current);
            if (changed) {
              store.saveProjectScope(next);
              advanceRevision(projectId);
              await syncProject(projectId);
            }
            const view = await scopeView(projectId);
            return reply(
              view,
              [
                `Productive project:  ${view.productiveProjectId || 'not mapped'}`,
                `Folder filter:       ${view.folderId || 'all'}`,
                `Task list filter:    ${view.taskListId || 'all'}`,
                `Assigned to me only: ${view.assignedToMeOnly ? 'yes' : 'no'}`,
                `Include closed:      ${view.includeClosed ? 'yes' : 'no'}`
              ].join('\n')
            );
          }

          case 'presets': {
            if (projectId === null) return needProject();
            if (rest[0] !== 'list') return fail(usage);
            const presets = store.listPresets(projectId);
            return reply(
              presets,
              presets.length === 0
                ? 'No filter presets.'
                : presets.map(preset => `${preset.id}  ${preset.name}`).join('\n')
            );
          }
        }
      } catch (error) {
        return fail(
          error instanceof Error ? error.message : 'Command failed.'
        );
      }
      return fail(usage);
    }
  });

  // -------------------------------------------------------------------------
  // Background sync
  // -------------------------------------------------------------------------

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  bb.background.service('sync', {
    async start(signal) {
      while (!signal.aborted) {
        const api = await currentApi();
        if (api !== null) {
          const projectIds = store.configuredProjectIds();
          await Promise.all(
            projectIds.map(projectId =>
              syncProject(projectId).catch(error => {
                bb.log.warn(`sync loop: ${safeMessage(error)}`);
                return null;
              })
            )
          );
        }
        await sleep(SYNC_INTERVAL_MS, signal);
      }
    }
  });

  bb.onDispose(() => {
    apiCache = null;
    viewerCache = null;
    bb.log.info('disposed');
  });

  // Exported for tests and for the settings page's "connect" affordance.
  return { requestConnectionInput };
}
