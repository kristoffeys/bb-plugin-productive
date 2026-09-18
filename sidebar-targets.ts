import type { TrackerProject } from './contract.js';

/**
 * Board targets shown in normal navigation. Group members resolve through the
 * group scope, so the group is the single navigable target for those projects.
 */
export function navigationTargets(projects: readonly TrackerProject[]): TrackerProject[] {
  return projects.filter(
    project =>
      project.mapped &&
      (project.kind === 'group' || project.inheritedFromGroup === null)
  );
}

/** Manage deliberately sees every independently configurable BB target. */
export function configurableTargets(projects: readonly TrackerProject[]): TrackerProject[] {
  return projects.filter(
    project => project.kind === 'group' || project.inheritedFromGroup === null
  );
}
