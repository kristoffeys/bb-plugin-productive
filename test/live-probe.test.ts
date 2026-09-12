import { test } from 'vitest';
import { createProductiveApi } from '../productive/index.js';

// Opt-in: this suite talks to a real Productive organization. Run it with
//   PRODUCTIVE_API_TOKEN=... PRODUCTIVE_ORG_ID=... \
//   PRODUCTIVE_LIVE_TEST=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live-probe.test.ts
// Node's fetch ignores the proxy env vars without NODE_USE_ENV_PROXY=1.
const live = process.env.PRODUCTIVE_LIVE_TEST === '1';

function credentials() {
  return {
    apiToken: process.env.PRODUCTIVE_API_TOKEN ?? '',
    organizationId: process.env.PRODUCTIVE_ORG_ID ?? ''
  };
}

test.skipIf(!live)('live read-only probe', { timeout: 120_000 }, async () => {
  const api = createProductiveApi(credentials());

  const projects = await api.listProjects({ limit: 5 });
  console.log('projects:', projects.map(p => `${p.id} ${p.name}`));
  const probe = projects[0] ?? (await api.listProjects({ limit: 1 }))[0];
  console.log('probe project:', probe.id, probe.name);

  const workflowId = await api.getProjectWorkflowId(probe.id);
  console.log('workflow id:', workflowId);
  const statuses = await api.listWorkflowStatuses(workflowId ? { workflowId } : undefined);
  console.log('statuses:', statuses.slice(0, 8).map(s => `${s.id}:${s.name}:${s.stateCategory}`));
  const lists = await api.listTaskLists(probe.id);
  console.log('task lists:', lists.slice(0, 5).map(l => `${l.id}:${l.name}:folder=${l.folderId ?? '-'}`));

  const folders = await api.listFolders(probe.id);
  console.log('folders (active):', folders.map(f => `${f.id}:${f.name}:archived=${f.archived}`));
  const foldersWithArchived = await api.listFolders(probe.id, { includeArchived: true });
  console.log('folders (all):', foldersWithArchived.length);
  if (folders[0]) {
    const listsInFolder = await api.listTaskLists(probe.id, { folderId: folders[0].id });
    console.log(`task lists in folder ${folders[0].id}:`, listsInFolder.map(l => l.id));
  }

  const tasks = await api.listTasks({ projectId: probe.id, status: 'open', limit: 3 });
  console.log('tasks:', tasks.length);
  for (const t of tasks) {
    console.log(`  ${t.key} | ${t.status.name}(${t.status.stateCategory}) | ${t.assignee?.name ?? 'unassigned'} | list=${t.taskList?.name ?? '-'} | folder=${t.folderName ?? '-'} | labels=${JSON.stringify(t.labels)} | due=${t.dueDate ?? '-'}`);
    console.log(`    url: ${t.url}`);
    console.log(`    desc: ${JSON.stringify((t.description || '').slice(0, 70))}`);
  }
  if (tasks[0]) {
    const one = await api.getTask(tasks[0].id);
    console.log('getTask roundtrip:', one?.id === tasks[0].id, 'key:', one?.key);
    const comments = await api.getTaskComments(tasks[0].id);
    console.log('comments:', comments.length, comments[0] ? `${comments[0].user?.name}: ${comments[0].body.slice(0, 60)}` : '');
    for (const c of comments) {
      if (c.attachments.length > 0) {
        console.log(`  comment ${c.id} attachments:`, c.attachments.map(a => `${a.name}(${a.contentType || '?'})`));
      }
    }
    const taskAttachments = await api.listTaskAttachments(tasks[0].id);
    console.log('task attachments:', taskAttachments.map(a => `${a.name}(${a.contentType || '?'}) ${a.isImage ? 'image' : 'file'} ${a.size}b`));
  }
  const people = await api.listAssignablePeople('pieter');
  console.log('people search:', people.slice(0, 3).map(p => `${p.id}:${p.name}`));
});
