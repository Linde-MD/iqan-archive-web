import { createApp, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import CollaborationPanel from '../src/components/CollaborationPanel.vue';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';
import { CollaborationDatabase, CollaborationRepository } from '../src/storage/collaboration';
import '../src/style.css';

const result = document.querySelector<HTMLElement>('#result')!;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await nextTick();
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('等待恢复面板超时');
}
async function run() {
  const db = new ArchiveDatabase(`collab-recovery-local-${crypto.randomUUID()}`);
  const cache = new CollaborationDatabase(`collab-recovery-cache-${crypto.randomUUID()}`);
  const client = new CollaborationRepository(new ArchiveRepository(db), cache);
  const source = crypto.randomUUID(), owner = crypto.randomUUID(), key = `${source}:${owner}`;
  const pending = {
    key, source, owner, requestId: 'slot:0:1:1', phase: 'mutation' as const, recovery: 'retired' as const,
    method: 'POST', path: '/projects', body: { name: '需核对的原文', partNumber: '123' }, projectId: null, clearDraft: false,
  };
  const router = createRouter({
    history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
  });
  const app = createApp({ render: () => h(CollaborationPanel, { client, projectId: '', disabled: false }) });
  const originalClick = HTMLAnchorElement.prototype.click;
  let downloadRequested = false;
  try {
    client.state.source = source;
    client.state.user = {
      id: owner, username: 'test-member', displayName: '测试成员', email: 'test@example.invalid',
      role: 'member', disabled: false, mustChangePassword: false, avatar: null,
    };
    client.state.connected = true; client.state.authenticated = true;
    await cache.contexts.put({ id: 'active', source, actorId: owner, user: null, token: '', expiresAt: 0 });
    await cache.pending.put(pending);
    await cache.clients.put({ key, clientId: crypto.randomUUID(), binding: { slot: 0, generation: 1, sequence: 1 } });
    await client.updateCounts();
    app.use(router);
    await router.push('/account/sync');
    app.mount('#app');
    await waitFor(() => !!document.querySelector('[aria-label="过期提交恢复"]'));
    const recovery = document.querySelector<HTMLElement>('[aria-label="过期提交恢复"]')!;
    assert(recovery.querySelector('[role="alert"]'), '恢复风险未作为警告展示');
    assert(!recovery.querySelector('input'), '未导出就显示放弃确认');
    HTMLAnchorElement.prototype.click = function () {
      downloadRequested = this.download === 'iqan-pending-recovery.json' && this.href.startsWith('blob:');
    };
    recovery.querySelector<HTMLButtonElement>('button')!.click();
    await waitFor(() => !!recovery.querySelector('input'));
    assert(downloadRequested, '未提供原始请求下载');
    assert(JSON.parse(await client.exportPending()).body.name === pending.body.name, '导出内容丢失');
    const checkbox = recovery.querySelector<HTMLInputElement>('input')!;
    const discard = [...recovery.querySelectorAll('button')].find(button => button.textContent?.includes('确认放弃'))!;
    assert(discard.disabled, '未经确认即可放弃');
    checkbox.focus();
    assert(document.activeElement === checkbox, '确认控件无法聚焦');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();
    assert(!discard.disabled, '明确核对后仍无法恢复');
    discard.click();
    await waitFor(() => !client.state.pending);
    assert(await cache.pending.count() === 0 && await cache.clients.count() === 0, '恢复后未清理绑定及原请求');
    assert(document.documentElement.scrollWidth <= innerWidth + 1, '恢复页面出现横向溢出');
    result.textContent = 'PASS：过期原文导出、风险警告、键盘焦点、显式核对后放弃与绑定清理';
    result.dataset.passed = 'true';
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    app.unmount();
    await Promise.all([db.delete(), cache.delete()]);
  }
}
run().catch((cause: unknown) => {
  result.textContent = `FAIL: ${cause instanceof Error ? cause.stack : String(cause)}`;
  result.dataset.passed = 'false';
});
