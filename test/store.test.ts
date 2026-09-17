import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { FILTER_PRESET_LIMIT, type FilterPreset, type WorkItem } from '../contract.js';
import { createWorkItemStore, type WorkItemStore } from '../store.js';

const PROJECT = 'proj_alpha';
const OTHER = 'proj_beta';

let db: Database.Database;
let store: WorkItemStore;

// Mirrors the real bb.storage.migrate contract: each migration in the array
// runs at most once per database, tracked by index, so re-creating a store
// against an already-migrated database only applies the migrations it hasn't
// seen yet.
function fakeBb(handle: Database.Database): BbPluginApi {
  return {
    storage: {
      database: () => handle,
      migrate: (target: Database.Database, statements: string[]) => {
        target.exec(
          'CREATE TABLE IF NOT EXISTS _applied_migrations (idx INTEGER PRIMARY KEY)'
        );
        const applied = new Set(
          target
            .prepare('SELECT idx FROM _applied_migrations')
            .all()
            .map((row: unknown) => (row as { idx: number }).idx)
        );
        statements.forEach((statement, index) => {
          if (applied.has(index)) return;
          target.exec(statement);
          target
            .prepare('INSERT INTO _applied_migrations (idx) VALUES (?)')
            .run(index);
        });
      }
    }
  } as unknown as BbPluginApi;
}

/** Marks migration index 0 as already applied, for a database that was built
 *  directly from the pre-folder schema (mimicking data on disk before this
 *  migration shipped). */
function markLegacyMigrationApplied(target: Database.Database): void {
  target.exec(
    'CREATE TABLE IF NOT EXISTS _applied_migrations (idx INTEGER PRIMARY KEY)'
  );
  target.prepare('INSERT INTO _applied_migrations (idx) VALUES (0)').run();
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: PROJECT,
    locator: '1',
    key: '#1',
    title: 'Ship the board',
    description: 'Board description',
    url: 'https://app.productive.io/1/tasks/1',
    status: 'To do',
    statusId: '10',
    stateCategory: 'todo',
    assignee: 'Kristof',
    assigneeId: '99',
    project: 'Antenna',
    productiveProjectId: '500',
    taskList: 'Sprint 1',
    taskListId: '700',
    folder: 'Backend',
    folderId: '300',
    labels: ['frontend'],
    dueDate: '2026-01-01',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function presetState(query = ''): FilterPreset['state'] {
  return {
    version: 1,
    view: 'list',
    query,
    stateCategories: [],
    statuses: [],
    assignees: [],
    folders: [],
    taskLists: [],
    labels: [],
    collapsedGroups: {}
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  store = createWorkItemStore(fakeBb(db));
});

describe('work item cache', () => {
  it('replaceAll swaps the previous set inside one project', () => {
    store.replaceAll(
      PROJECT,
      [item({ locator: '1' }), item({ locator: '2', key: '#2' })],
      '2026-01-01T10:00:00.000Z'
    );
    store.replaceAll(OTHER, [item({ bbProjectId: OTHER, locator: '9' })], 'x');

    store.replaceAll(
      PROJECT,
      [item({ locator: '2', key: '#2', title: 'Renamed' })],
      '2026-01-02T10:00:00.000Z'
    );

    const items = store.list({ projectId: PROJECT, limit: 50 });
    expect(items.map(entry => entry.locator)).toEqual(['2']);
    expect(items[0]?.title).toBe('Renamed');
    expect(store.get(PROJECT, '1')).toBeNull();
    // Another project's cache is untouched.
    expect(store.list({ projectId: OTHER, limit: 50 })).toHaveLength(1);

    const status = store.syncStatus(PROJECT);
    expect(status.lastSyncedAt).toBe('2026-01-02T10:00:00.000Z');
    expect(status.itemCount).toBe(1);
    expect(status.available).toBe(true);
  });

  it('rejects items from another bb project', () => {
    expect(() =>
      store.replaceAll(PROJECT, [item({ bbProjectId: OTHER })], 'now')
    ).toThrow();
    expect(() => store.upsert(PROJECT, item({ bbProjectId: OTHER }))).toThrow();
  });

  it('upsert refreshes a single cached row', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    store.upsert(PROJECT, item({ status: 'Done', statusId: '30', stateCategory: 'done' }));
    expect(store.get(PROJECT, '1')?.stateCategory).toBe('done');
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });

  it('filters by query and by state categories', () => {
    store.replaceAll(
      PROJECT,
      [
        item({ locator: '1', key: '#1', title: 'Fix login bug', stateCategory: 'todo' }),
        item({
          locator: '2',
          key: '#2',
          title: 'Write docs',
          description: 'nothing here',
          stateCategory: 'in_progress'
        }),
        item({
          locator: '3',
          key: '#3',
          title: 'Archive',
          description: 'login rewrite',
          stateCategory: 'done'
        })
      ],
      'now'
    );

    expect(
      store.list({ projectId: PROJECT, query: 'LOGIN', limit: 50 }).map(i => i.locator)
    ).toEqual(['1', '3']);
    expect(
      store
        .list({ projectId: PROJECT, stateCategories: ['todo', 'done'], limit: 50 })
        .map(i => i.locator)
    ).toEqual(['1', '3']);
    expect(
      store.list({
        projectId: PROJECT,
        query: 'login',
        stateCategories: ['done'],
        limit: 50
      }).map(i => i.locator)
    ).toEqual(['3']);
    // LIKE wildcards in the query are literal, not patterns.
    expect(store.list({ projectId: PROJECT, query: '%', limit: 50 })).toEqual([]);
    expect(store.list({ projectId: PROJECT, limit: 2 })).toHaveLength(2);
  });

  it('records a sync error without dropping cached rows', () => {
    store.replaceAll(PROJECT, [item()], '2026-01-01T10:00:00.000Z');
    store.setSyncError(PROJECT, 'Productive is down');
    const status = store.syncStatus(PROJECT);
    expect(status.available).toBe(false);
    expect(status.message).toBe('Productive is down');
    expect(status.itemCount).toBe(1);
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });
});

describe('project scope', () => {
  const defaults = {
    productiveProjectId: '',
    folderId: '',
    taskListId: '',
    assignedToMeOnly: false,
    includeClosed: false
  };

  it('falls back to defaults and round-trips a saved scope', () => {
    expect(store.projectScope(PROJECT, defaults)).toEqual({
      projectId: PROJECT,
      ...defaults
    });
    const saved = store.saveProjectScope({
      projectId: PROJECT,
      productiveProjectId: '500',
      folderId: '300',
      taskListId: '700',
      assignedToMeOnly: true,
      includeClosed: false
    });
    expect(saved.assignedToMeOnly).toBe(true);
    expect(store.projectScope(PROJECT, defaults)).toEqual(saved);
  });

  it('configuredProjectIds lists only mapped projects', () => {
    store.saveProjectScope({ projectId: PROJECT, ...defaults, productiveProjectId: '500' });
    store.saveProjectScope({ projectId: OTHER, ...defaults });
    expect(store.configuredProjectIds()).toEqual([PROJECT]);
  });

  it('drops the cache when the project is retargeted', () => {
    store.saveProjectScope({ projectId: PROJECT, ...defaults, productiveProjectId: '500' });
    store.replaceAll(PROJECT, [item()], 'now');
    store.saveProjectScope({ projectId: PROJECT, ...defaults, productiveProjectId: '501' });
    expect(store.list({ projectId: PROJECT, limit: 50 })).toEqual([]);
    expect(store.syncStatus(PROJECT).lastSyncedAt).toBeNull();
  });
});

describe('board settings', () => {
  it('defaults, saves, and survives a malformed json column', () => {
    const defaults = store.boardSettings(PROJECT);
    expect(defaults.projectId).toBe(PROJECT);

    const saved = store.saveBoardSettings({ ...defaults, defaultView: 'kanban' });
    expect(saved.defaultView).toBe('kanban');

    db.prepare('UPDATE project_board_settings SET status_order_json = ?').run('{oops');
    expect(store.boardSettings(PROJECT).statusOrder).toEqual(defaults.statusOrder);
  });
});

describe('filter presets', () => {
  it('enforces the preset limit', () => {
    for (let index = 0; index < FILTER_PRESET_LIMIT; index += 1) {
      store.savePreset({ projectId: PROJECT, name: `Preset ${index}`, state: presetState() });
    }
    expect(store.listPresets(PROJECT)).toHaveLength(FILTER_PRESET_LIMIT);
    expect(() =>
      store.savePreset({ projectId: PROJECT, name: 'One too many', state: presetState() })
    ).toThrow(/at most/u);
  });

  it('rejects a duplicate normalized name but allows renaming in place', () => {
    const first = store.savePreset({
      projectId: PROJECT,
      name: 'My Filter',
      state: presetState()
    });
    expect(() =>
      store.savePreset({ projectId: PROJECT, name: 'my filter', state: presetState() })
    ).toThrow(/already exists/u);
    // Same name on the same id is an update, not a conflict.
    const updated = store.savePreset({
      projectId: PROJECT,
      id: first.id,
      name: 'My Filter',
      state: presetState('changed')
    });
    expect(updated.id).toBe(first.id);
    expect(updated.state.query).toBe('changed');
    // The name is free in a different project.
    expect(
      store.savePreset({ projectId: OTHER, name: 'My Filter', state: presetState() }).id
    ).not.toBe(first.id);
    expect(store.listPresets(PROJECT)).toHaveLength(1);
  });

  it('reorders and renumbers after a delete', () => {
    const a = store.savePreset({ projectId: PROJECT, name: 'A', state: presetState() });
    const b = store.savePreset({ projectId: PROJECT, name: 'B', state: presetState() });
    const c = store.savePreset({ projectId: PROJECT, name: 'C', state: presetState() });

    const reordered = store.reorderPresets(PROJECT, [c.id, a.id, b.id]);
    expect(reordered.map(preset => preset.name)).toEqual(['C', 'A', 'B']);

    const remaining = store.deletePreset(PROJECT, a.id);
    expect(remaining.map(preset => preset.name)).toEqual(['C', 'B']);
    expect(remaining.map(preset => preset.position)).toEqual([0, 1]);
    // Deleting an unknown id is a no-op.
    expect(store.deletePreset(PROJECT, b.id)).toHaveLength(1);
    expect(store.deletePreset(PROJECT, b.id)).toHaveLength(1);
  });

  it('hides a preset with a malformed filters_json instead of throwing', () => {
    const good = store.savePreset({ projectId: PROJECT, name: 'Good', state: presetState() });
    const bad = store.savePreset({ projectId: PROJECT, name: 'Bad', state: presetState() });
    db.prepare('UPDATE project_filter_presets SET filters_json = ? WHERE id = ?').run(
      'not json',
      bad.id
    );

    expect(store.listPresets(PROJECT).map(preset => preset.id)).toEqual([good.id]);
    // A corrupt row must not block reordering the readable ones.
    expect(store.reorderPresets(PROJECT, [good.id])).toHaveLength(1);
  });

  it('keeps a work item readable when labels_json is corrupt', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    db.prepare('UPDATE work_items SET labels_json = ?').run('<not json>');
    expect(store.get(PROJECT, '1')?.labels).toEqual([]);
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });
});

describe('folder columns', () => {
  const defaults = {
    productiveProjectId: '',
    folderId: '',
    taskListId: '',
    assignedToMeOnly: false,
    includeClosed: false
  };

  it('round-trip folder fields through upsert, replaceAll, get, and list', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    expect(store.get(PROJECT, '1')).toMatchObject({ folder: 'Backend', folderId: '300' });
    expect(store.list({ projectId: PROJECT, limit: 50 })[0]).toMatchObject({
      folder: 'Backend',
      folderId: '300'
    });

    store.upsert(PROJECT, item({ folder: 'Frontend', folderId: '301' }));
    expect(store.get(PROJECT, '1')).toMatchObject({ folder: 'Frontend', folderId: '301' });
  });

  it('the new migration adds folder columns to a database built on the old schema', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE work_items (
        bb_project_id TEXT NOT NULL,
        locator TEXT NOT NULL,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        status_id TEXT NOT NULL,
        state_category TEXT NOT NULL CHECK (
          state_category IN ('todo', 'in_progress', 'done')
        ),
        assignee TEXT,
        assignee_id TEXT,
        project TEXT,
        productive_project_id TEXT,
        task_list TEXT,
        task_list_id TEXT,
        labels_json TEXT NOT NULL,
        due_date TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bb_project_id, locator)
      );
      CREATE INDEX idx_work_items_project
        ON work_items(bb_project_id, updated_at DESC, locator);
      CREATE TABLE project_sync (
        bb_project_id TEXT PRIMARY KEY,
        last_synced_at TEXT,
        error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0)
      );
      CREATE TABLE project_scope (
        bb_project_id TEXT PRIMARY KEY,
        productive_project_id TEXT NOT NULL,
        task_list_id TEXT NOT NULL,
        assigned_to_me_only INTEGER NOT NULL CHECK (
          assigned_to_me_only IN (0, 1)
        ),
        include_closed INTEGER NOT NULL CHECK (include_closed IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_board_settings (
        bb_project_id TEXT PRIMARY KEY,
        default_view TEXT NOT NULL,
        enabled_filters_json TEXT NOT NULL,
        status_order_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_filter_presets (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(id) BETWEEN 1 AND 100),
        bb_project_id TEXT NOT NULL
          CHECK (
            substr(bb_project_id, 1, 5) = 'proj_' AND
            length(bb_project_id) BETWEEN 6 AND 500
          ),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        name_normalized TEXT NOT NULL
          CHECK (length(name_normalized) BETWEEN 1 AND 240),
        filters_json TEXT NOT NULL
          CHECK (length(CAST(filters_json AS BLOB)) BETWEEN 1 AND 910000),
        position INTEGER NOT NULL CHECK (position >= 0 AND position < 50),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bb_project_id, name_normalized)
      );
      CREATE INDEX idx_filter_presets_project
        ON project_filter_presets(bb_project_id, position, created_at, id);
    `);
    legacyDb
      .prepare(
        `INSERT INTO work_items (
          bb_project_id, locator, item_key, title, description, url, status,
          status_id, state_category, assignee, assignee_id, project,
          productive_project_id, task_list, task_list_id, labels_json,
          due_date, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        PROJECT,
        '1',
        '#1',
        'Existing task',
        'desc',
        'https://example.test/1',
        'To do',
        '10',
        'todo',
        null,
        null,
        'Antenna',
        '500',
        'Sprint 1',
        '700',
        '[]',
        null,
        '2026-01-01T00:00:00.000Z'
      );
    legacyDb
      .prepare(
        `INSERT INTO project_scope (
          bb_project_id, productive_project_id, task_list_id,
          assigned_to_me_only, include_closed, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(PROJECT, '500', '700', 0, 0, '2026-01-01T00:00:00.000Z');
    markLegacyMigrationApplied(legacyDb);

    const migratedStore = createWorkItemStore(fakeBb(legacyDb));

    const migratedItem = migratedStore.get(PROJECT, '1');
    expect(migratedItem).toMatchObject({
      title: 'Existing task',
      folder: null,
      folderId: null
    });
    const scope = migratedStore.projectScope(PROJECT, defaults);
    expect(scope.folderId).toBe('');
    expect(scope.productiveProjectId).toBe('500');
  });

  it('saveProjectScope clears the cache when only folderId changes', () => {
    store.saveProjectScope({ projectId: PROJECT, ...defaults, productiveProjectId: '500' });
    store.replaceAll(PROJECT, [item()], 'now');
    store.saveProjectScope({
      projectId: PROJECT,
      ...defaults,
      productiveProjectId: '500',
      folderId: '301'
    });
    expect(store.list({ projectId: PROJECT, limit: 50 })).toEqual([]);
    expect(store.syncStatus(PROJECT).lastSyncedAt).toBeNull();
  });

  it('reads a row with NULL folder columns defensively', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    db.prepare('UPDATE work_items SET folder = NULL, folder_id = NULL').run();
    const read = store.get(PROJECT, '1');
    expect(read).toMatchObject({ folder: null, folderId: null });
  });

  it('removes one cached item and updates the project item count', () => {
    store.replaceAll(PROJECT, [item(), item({ locator: '2', key: '#2' })], 'now');

    expect(store.remove(PROJECT, '1')).toBe(true);
    expect(store.get(PROJECT, '1')).toBeNull();
    expect(store.get(PROJECT, '2')).not.toBeNull();
    expect(store.syncStatus(PROJECT).itemCount).toBe(1);
    expect(store.remove(PROJECT, 'missing')).toBe(false);
  });
});
