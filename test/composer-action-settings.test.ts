import { describe, expect, test } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.js';
import {
  isComposerTaskActionEnabled,
  productiveSettings
} from '../composer-action-settings.js';

describe('composer task action setting', () => {
  test('defaults to enabled for existing installations', async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: 'productive' });
    await plugin(bb);

    expect(harness.inspection.registrations.settingsDescriptors).toMatchObject({
      composerTaskActionEnabled: {
        type: 'boolean',
        default: true,
        label: 'Show “Turn prompt into Productive task” in the chat composer'
      }
    });
  });

  test('persists an explicit disabled value across plugin reloads', async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: 'productive' });
    await plugin(bb);

    await harness.behavior.setSettings({ composerTaskActionEnabled: false });
    let reloadedValue: boolean | undefined;
    await harness.lifecycle.reload(async nextBb => {
      const settings = nextBb.settings.define(productiveSettings);
      reloadedValue = (await settings.get()).composerTaskActionEnabled;
    });

    expect(reloadedValue).toBe(false);
  });

  test('removes the action only for an explicitly disabled setting', () => {
    expect(isComposerTaskActionEnabled(undefined)).toBe(true);
    expect(isComposerTaskActionEnabled({})).toBe(true);
    expect(isComposerTaskActionEnabled({ composerTaskActionEnabled: false })).toBe(false);
  });
});
