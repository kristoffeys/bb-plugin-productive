/**
 * Settings and policy for the optional Productive composer action.
 *
 * This stays separate from connection and per-project board data so changing
 * the UI preference has no effect on either kind of Productive configuration.
 */
export const productiveSettings = {
  composerTaskActionEnabled: {
    type: 'boolean' as const,
    label: 'Show “Turn prompt into Productive task” in the chat composer',
    description:
      'Adds the Productive task action to thread and new-thread composers.',
    default: true
  }
};

/** Missing values are treated as the backward-compatible enabled default. */
export function isComposerTaskActionEnabled(
  settings: Readonly<Record<string, string | number | boolean>> | undefined
): boolean {
  return settings?.composerTaskActionEnabled !== false;
}
