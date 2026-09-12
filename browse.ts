// Shared, source-agnostic helpers ported from the Taskboard plugin's
// browse.ts. Only the pieces board-settings.ts needs are kept here — the
// rest of that file (592 lines) is Linear/GitHub/Jira browsing logic that
// has no Productive equivalent and lives in productive/ instead.

/**
 * Fallback lane order used when a project has no persisted `statusOrder`
 * yet. Productive workflow statuses are entirely org-defined (arbitrary
 * names per workflow), so there is no universal name list to port from
 * Taskboard. Every Productive workflow status does carry a `category_id` of
 * 1 (not started), 2 (started) or 3 (closed) though, so this fallback is
 * just a short, generic label per category — good enough for an initial
 * kanban lane order until the real per-project statuses are loaded and
 * `statusOrder` is persisted with their actual names.
 */
export const DEFAULT_WORKFLOW_STATUS_ORDER: readonly string[] = [
  'To Do',
  'In Progress',
  'Done'
];
