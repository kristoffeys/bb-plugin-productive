const GROUP_SCOPE_PREFIX = 'proj_group_';

/** Productive's existing persistence is keyed by a project-shaped scope id.
 * Keep group boards in the same proven path while preserving the Sidebar id. */
export function groupScopeId(groupId: string): string {
  return `${GROUP_SCOPE_PREFIX}${groupId}`;
}

export function groupIdFromScope(scopeId: string): string | null {
  if (!scopeId.startsWith(GROUP_SCOPE_PREFIX)) return null;
  const groupId = scopeId.slice(GROUP_SCOPE_PREFIX.length);
  return groupId.startsWith('pgrp_') ? groupId : null;
}

export function inheritedBoardScopeId(
  projectId: string,
  groups: readonly { id: string; projectIds: readonly string[] }[]
): string {
  if (groupIdFromScope(projectId) !== null) return projectId;
  const group = groups.find(candidate => candidate.projectIds.includes(projectId));
  return group ? groupScopeId(group.id) : projectId;
}
