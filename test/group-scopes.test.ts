import { describe, expect, it } from 'vitest';
import {
  groupIdFromScope,
  groupScopeId,
  inheritedBoardScopeId
} from '../group-scopes.js';

describe('Sidebar group board scopes', () => {
  it('round-trips Sidebar group ids through project-shaped scope ids', () => {
    const groupId = 'pgrp_1234';
    expect(groupIdFromScope(groupScopeId(groupId))).toBe(groupId);
  });

  it('does not mistake BB projects for Sidebar groups', () => {
    expect(groupIdFromScope('proj_1234')).toBeNull();
    expect(groupIdFromScope('proj_group_not-a-group')).toBeNull();
  });

  it('makes a group board authoritative for every member project', () => {
    const groups = [{ id: 'pgrp_shop', projectIds: ['proj_web', 'proj_api'] }];
    expect(inheritedBoardScopeId('proj_web', groups)).toBe(
      groupScopeId('pgrp_shop')
    );
    expect(inheritedBoardScopeId('proj_other', groups)).toBe('proj_other');
    expect(inheritedBoardScopeId(groupScopeId('pgrp_shop'), groups)).toBe(
      groupScopeId('pgrp_shop')
    );
  });
});
