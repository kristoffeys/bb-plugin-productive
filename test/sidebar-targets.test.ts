import { describe, expect, it } from 'vitest';
import type { TrackerProject } from '../contract.js';
import { configurableTargets, navigationTargets } from '../sidebar-targets.js';

const group = (mapped: boolean): TrackerProject => ({
  id: 'proj_group_pgrp_web',
  boardId: 'proj_group_pgrp_web',
  name: 'Web team',
  kind: 'group',
  groupId: 'pgrp_web',
  inheritedFromGroup: null,
  mapped
});
const project = (id: string, mapped: boolean, inheritedFromGroup: string | null = null): TrackerProject => ({
  id,
  boardId: inheritedFromGroup ? 'proj_group_pgrp_web' : id,
  name: id,
  kind: 'project',
  groupId: inheritedFromGroup ? 'pgrp_web' : null,
  inheritedFromGroup,
  mapped
});

describe('linked project sidebar targets', () => {
  it('shows only effectively mapped targets and deduplicates group members', () => {
    const targets = navigationTargets([
      group(true),
      project('proj_member', true, 'Web team'),
      project('proj_mapped', true),
      project('proj_unmapped', false)
    ]);

    expect(targets.map(target => target.id)).toEqual([
      'proj_group_pgrp_web',
      'proj_mapped'
    ]);
  });

  it('uses the group mapping as a member’s effective mapping', () => {
    const targets = navigationTargets([
      group(false),
      project('proj_member', false, 'Web team')
    ]);

    expect(targets).toEqual([]);
  });

  it('keeps unmapped projects in Manage so they can be linked', () => {
    const targets = configurableTargets([
      group(false),
      project('proj_member', false, 'Web team'),
      project('proj_unmapped', false)
    ]);

    expect(targets.map(target => target.id)).toEqual([
      'proj_group_pgrp_web',
      'proj_unmapped'
    ]);
  });
});
