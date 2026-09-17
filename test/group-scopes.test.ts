import { describe, expect, it } from 'vitest';
import { groupIdFromScope, groupScopeId } from '../group-scopes.js';

describe('Sidebar group board scopes', () => {
  it('round-trips Sidebar group ids through project-shaped scope ids', () => {
    const groupId = 'pgrp_1234';
    expect(groupIdFromScope(groupScopeId(groupId))).toBe(groupId);
  });

  it('does not mistake BB projects for Sidebar groups', () => {
    expect(groupIdFromScope('proj_1234')).toBeNull();
    expect(groupIdFromScope('proj_group_not-a-group')).toBeNull();
  });
});
