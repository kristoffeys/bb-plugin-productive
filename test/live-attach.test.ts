import { expect, test } from 'vitest';
import { createProductiveApi } from '../productive/index.js';

// Opt-in: this suite talks to a real Productive organization. Run it with
//   PRODUCTIVE_API_TOKEN=... PRODUCTIVE_ORG_ID=... \
//   PRODUCTIVE_LIVE_TEST=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live-attach.test.ts
// Node's fetch ignores the proxy env vars without NODE_USE_ENV_PROXY=1.
const live = process.env.PRODUCTIVE_LIVE_TEST === '1';

function credentials() {
  return {
    apiToken: process.env.PRODUCTIVE_API_TOKEN ?? '',
    organizationId: process.env.PRODUCTIVE_ORG_ID ?? ''
  };
}

/**
 * The generic live probe usually samples a task with no attachments, so it
 * never exercises the mapping. This one discovers a task that genuinely has an
 * attachment and asserts the mapped shape — no hard-coded task id, so it keeps
 * working as the organization's data changes.
 */
test.skipIf(!live)(
  'maps a real task attachment',
  { timeout: 120_000 },
  async () => {
    const auth = credentials();
    const api = createProductiveApi(auth);

    // Find any attachment whose attachable_type is "task". The `task`
    // relationship is not inlined by default, hence include=task.
    const response = await fetch(
      'https://api.productive.io/api/v2/attachments?page%5Bsize%5D=100&include=task',
      {
        headers: {
          'X-Auth-Token': auth.apiToken,
          'X-Organization-Id': auth.organizationId,
          'Content-Type': 'application/vnd.api+json'
        }
      }
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      data: {
        attributes: Record<string, unknown>;
        relationships: Record<string, { data?: { id: string } }>;
      }[];
    };
    const sample = body.data.find(
      record =>
        record.attributes.attachable_type === 'task' &&
        record.relationships.task?.data?.id !== undefined &&
        record.attributes.deleted_at === null
    );
    if (sample === undefined) {
      console.log('no task attachments in this organization; nothing to map');
      return;
    }
    const taskId = sample.relationships.task!.data!.id;

    const attachments = await api.listTaskAttachments(taskId);
    expect(attachments.length).toBeGreaterThan(0);

    const mapped = attachments[0]!;
    expect(mapped.id).toBeTruthy();
    expect(mapped.name).toBeTruthy();
    expect(mapped.attachedTo).toBe('task');
    expect(mapped.size).toBeGreaterThan(0);
    expect(mapped.url.startsWith('https://')).toBe(true);
    expect(mapped.isImage).toBe(mapped.contentType.startsWith('image/'));
  }
);
