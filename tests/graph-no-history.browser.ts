import { createApp, h, nextTick } from 'vue';
import VersionGraph from '../src/components/VersionGraph.vue';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';
import '../src/style.css';

const result = document.querySelector<HTMLElement>('#result')!;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await nextTick();
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待版本图状态超时');
}

async function run() {
  const db = new ArchiveDatabase(`graph-no-history-${crypto.randomUUID()}`);
  const repository = new ArchiveRepository(db);
  const project = await repository.create('无业务撤销测试', 'TEST');
  const nodeId = crypto.randomUUID();
  await repository.addNode(project.project.id, project.project.revision, {
    id: nodeId, projectId: project.project.id, version: 'V1', description: '原说明',
    taskId: null, releasedAt: null, testingAt: null,
  }, [], null);
  const app = createApp({ render: () => h(VersionGraph, { repository, projectId: project.project.id }) });
  app.mount('#app');
  try {
    await waitFor(() => !!document.querySelector('.git-row-commit'));
    assert(!document.querySelector('[aria-label="撤销上一步"]'), '仍显示图操作撤销入口');
    document.querySelector<HTMLElement>('.git-row-commit')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => !!document.querySelector('#git-version'));
    const mode = document.querySelector<HTMLSelectElement>('[aria-label="改动说明编辑方式"]')!;
    assert(mode, '缺少编辑模式选择');
    mode.value = 'source';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => !!document.querySelector('#git-description'));
    const description = document.querySelector<HTMLTextAreaElement>('#git-description')!;
    description.value = '修改后的说明';
    description.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const form = document.querySelector<HTMLFormElement>('[role="dialog"][aria-label="编辑版本"] form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('#git-version'));
    const saved = await repository.get(project.project.id);
    assert(saved.nodes[0]?.description === '修改后的说明', '正常编辑未保存');
    for (const key of ['z', 'y']) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const event = new KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true });
        document.querySelector<HTMLElement>('.git-row-commit')!.dispatchEvent(event);
        assert(!event.defaultPrevented, '图操作仍接管文字撤销快捷键');
      }
    }
    assert((await repository.get(project.project.id)).project.revision === saved.project.revision,
      '快捷键修改了已保存的业务图');
    const bounds = document.querySelector<HTMLElement>('#graph-command-toolbar')!.getBoundingClientRect();
    assert(bounds.left >= -1 && bounds.right <= innerWidth + 1, '工具栏超出视口');
    document.querySelector<HTMLElement>('.git-row-commit')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => !!document.querySelector('#git-version'));
    const version = document.querySelector<HTMLInputElement>('#git-version')!;
    version.focus();
    assert(document.execCommand('insertText', false, '-draft'), '无法在输入框输入文字');
    assert(document.execCommand('undo') && version.value === 'V1', '输入框原生撤销失效');
    result.textContent = 'PASS：编辑保存、无图历史入口、快捷键不改业务图、输入框原生撤销及工具栏边界';
    result.dataset.passed = 'true';
  } finally {
    app.unmount();
    await db.delete();
  }
}

run().catch((cause: unknown) => {
  result.textContent = `FAIL: ${cause instanceof Error ? cause.stack : String(cause)}`;
  result.dataset.passed = 'false';
});
