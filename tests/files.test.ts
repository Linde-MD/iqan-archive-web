import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { matchScannedFiles, parseEngineeringName, registerCandidates, type FileCandidate } from '../src/domain/filenames';
import { createProject, normalizeVersion, type VersionNode } from '../src/domain/model';
import { release, validateGraph } from '../src/domain/graph';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';
import { checkPermission, locateFile, scanDirectory, type DirectoryHandle, type FileHandle } from '../src/files/directories';

const databases: Dexie[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });
function repo() {
  const db = new ArchiveDatabase(`files-${crypto.randomUUID()}`); databases.push(db);
  return new ArchiveRepository(db);
}
function candidate(name = '001 V1.0-3 20261022.idax', folder = ''): FileCandidate {
  return { fileName: name, relativePath: folder ? `${folder}/${name}` : name };
}
function file(name: string): FileHandle {
  return { kind: 'file', name, async getFile() { return new File([], name); } };
}
function directory(name: string, entries: (DirectoryHandle | FileHandle)[], permission: PermissionState = 'granted'): DirectoryHandle {
  return {
    kind: 'directory', name,
    async *values() { yield* entries; },
    async queryPermission() { return permission; },
    async requestPermission() { return permission; },
    async getDirectoryHandle(child) {
      const found = entries.find(item => item.kind === 'directory' && item.name === child);
      if (!found || found.kind !== 'directory') throw new DOMException('目录缺失', 'NotFoundError');
      return found;
    },
    async getFileHandle(child) {
      const found = entries.find(item => item.kind === 'file' && item.name === child);
      if (!found || found.kind !== 'file') throw new DOMException('文件缺失', 'NotFoundError');
      return found;
    },
  };
}

describe('文件名和版本身份', () => {
  it('保留前导零和完整日期文本，空白归一，不校验版本中的日历日期', () => {
    expect(parseEngineeringName(' 001\t V1.0-3  \t20261399.IDAX ')).toEqual({ partNumber: '001', version: 'V1.0-3 20261399', extension: '.idax' });
    expect(parseEngineeringName('001 vA-B.1.idsx').version).toBe('vA-B.1');
    expect(parseEngineeringName('001 V1.idvx').extension).toBe('.idvx');
    expect(normalizeVersion(' V1 \t 2026 ')).toBe('V1 2026');
  });
  it.each(['001 V.idax', '001 v---.idax', '001 V1_2.idax', '001 R1.idax', 'abc V1.idax', '001 V1.idax.idsx', '001 V1.exe', '001 V中文.idax', '001 V1\n2026.idax'])('拒绝非法文件名：%s', name => {
    expect(() => parseEngineeringName(name)).toThrow();
  });
  it('登记仅创建缺失根节点，同完整版本去重，不保存文件、不推进分支', () => {
    const graph = registerCandidates(createProject('项目', '001'), [
      candidate(), candidate('001 V1.0-3 20261023.idax'), candidate('001 V1.0-3  20261022.idsx', 'other'),
    ]);
    expect(graph.nodes.map(node => node.version)).toEqual(['V1.0-3 20261022', 'V1.0-3 20261023']);
    expect(graph).not.toHaveProperty('files');
    expect(graph.edges).toEqual([]); expect(graph.branches).toEqual([]);
    expect(matchScannedFiles(graph, [candidate()]).rows[0]!.nodeId).toBe(graph.nodes[0]!.id);
    expect(matchScannedFiles(graph, [candidate('002 V1.idax')]).rows[0]!.reason).toContain('零件号不匹配');
    expect(() => registerCandidates(graph, [candidate()])).toThrow('无需登记');
  });
  it('版本大小写区分；空白归一冲突拒绝，路径字段不一致拒绝', () => {
    const graph = registerCandidates(createProject('项目', '001'), [candidate('001 V1.idax'), candidate('001 v1.idax')]);
    expect(graph.nodes).toHaveLength(2);
    graph.nodes[1]!.version = 'V1';
    expect(() => validateGraph(graph)).toThrow('重复');
    expect(matchScannedFiles(createProject('项目', '001'), [{ fileName: '001 V1.idax', relativePath: '../001 V1.idax' }]).rows[0]!.reason).toContain('安全的相对路径');
  });
  it('自动匹配使用精确零件号和区分大小写的归一化完整版本，不推断日期或关系', () => {
    const graph = registerCandidates(createProject('项目', '001'), [candidate('001 V1  20261022.idax')]);
    const result = matchScannedFiles(graph, [candidate('001 V1\t20261022.IDSX'), candidate('001 v1 20261022.idax'), candidate('001 V1 20261023.idax'), candidate('1 V1 20261022.idax')]);
    expect(result.rows.map(row => row.nodeId)).toEqual([graph.nodes[0]!.id, null, null, null]);
    expect(result.rows[3]!.reason).toContain('零件号不匹配');
    expect(graph.edges).toEqual([]);
    expect(graph.branches).toEqual([]);
  });
  it('自动匹配已有放行版本的全部文件，无需登记，不写图；缺失和非法输入可区分', () => {
    const graph = registerCandidates(createProject('项目', '001'), [candidate()]);
    const released = release(graph, graph.nodes[0]!.id, new Date().toISOString());
    const before = structuredClone(released);
    const result = matchScannedFiles(released, [candidate(), candidate(undefined, 'other'), candidate('001 V2.idax'), candidate('002 V3.idax'), candidate('bad.idax')]);
    expect(result.matches.get(released.nodes[0]!.id)).toHaveLength(2);
    expect(result.missing).toEqual([]);
    expect(result.rows[2]!.nodeId).toBeNull();
    expect(result.rows[2]!.reason).toBeNull();
    expect(result.rows[3]!.reason).toContain('零件号');
    expect(result.rows[4]!.reason).not.toBeNull();
    expect(matchScannedFiles(released, []).missing).toEqual(released.nodes);
    expect(released).toEqual(before);
    const added = registerCandidates(released, [candidate(), candidate('001 V2.idax')]);
    expect(added.nodes[0]).toEqual(released.nodes[0]);
    expect(added.nodes).toHaveLength(2);
  });
});

describe('只读目录扫描与定位', () => {
  it('递归扫描区分角色，返回完整相对路径，不读取文件内容', async () => {
    const root = directory('root', [file('ignore.txt'), directory('sub', [
      file('001 V1.IDAX'), file('报告.DOC'), file('对比.docx'), file('错误.dox'),
    ])]);
    expect(await scanDirectory(root, 'engineering', new AbortController().signal, () => {})).toEqual([candidate('001 V1.IDAX', 'sub')]);
    expect((await scanDirectory(root, 'word', new AbortController().signal, () => {})).map(item => item.fileName).sort()).toEqual(['对比.docx', '报告.DOC'].sort());
    expect((await locateFile(root, 'sub/001 V1.IDAX')).name).toBe('001 V1.IDAX');
    await expect(locateFile(root, 'sub/missing.idax')).rejects.toThrow('文件缺失');
  });
  it.each(['../x.idax', 'C:\\x.idax', '/x.idax', 'sub//x.idax', 'sub/./x.idax', 'sub/x:evil'])('拒绝越界/非法定位：%s', async path => {
    await expect(locateFile(directory('root', []), path)).rejects.toThrow('安全的相对路径');
  });
  it('精确验证5000/5001枚举条目阈值，目录及不支持文件计入', async () => {
    const entries = Array.from({ length: 4999 }, (_, i) => file(`${i}.txt`));
    const root = directory('root', [directory('nested', entries)]);
    let progress = 0;
    expect(await scanDirectory(root, 'engineering', new AbortController().signal, count => { progress = count; })).toEqual([]);
    expect(progress).toBe(5000);
    entries.push(file('001 V1.idax'));
    await expect(scanDirectory(root, 'engineering', new AbortController().signal, () => {})).rejects.toThrow('5000');
  });
  it('取消、权限拒绝及遍历错误不返回成功形状的部分结果', async () => {
    const root = directory('root', [file('001 V1.idax')], 'denied');
    expect(await checkPermission(root)).toBe(false);
    await expect(scanDirectory(root, 'engineering', new AbortController().signal, () => {})).rejects.toThrow('授权');
    const controller = new AbortController();
    controller.abort();
    await expect(scanDirectory(directory('root', []), 'engineering', controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' });
    const broken = directory('root', []);
    broken.values = async function* () { yield file('001 V1.idax'); throw new DOMException('权限失效', 'NotAllowedError'); };
    await expect(scanDirectory(broken, 'engineering', new AbortController().signal, () => {})).rejects.toThrow('权限失效');
  });
});

describe('项目事务及v3迁移', () => {
  it('登记/零件号修改往返，修订冲突及批次非法输入完整回滚，快照无本地文件/目录', async () => {
    const repository = repo();
    let graph = await repository.create('项目', '001');
    const old = graph.project.revision;
    graph = await repository.register(graph.project.id, old, [candidate()]);
    await expect(repository.register(graph.project.id, old, [candidate(undefined, 'other')])).rejects.toThrow('其他标签页');
    await expect(repository.register(graph.project.id, graph.project.revision, [candidate('001 V2.idax'), candidate('002 V3.idax')])).rejects.toThrow('零件号');
    expect(await repository.get(graph.project.id)).toEqual(graph);
    graph = await repository.directoryHint(graph.project.id, graph.project.revision, 'word', ' C:\\Reports ');
    expect(graph.project.wordDirectoryHint).toBe('C:\\Reports');
    const before = structuredClone(graph);
    graph = await repository.setPartNumber(graph.project.id, graph.project.revision, ' 002 ');
    expect(graph.project.id).toBe(before.project.id);
    expect(graph.nodes).toEqual(before.nodes);
    expect(graph.project.partNumber).toBe('002');
    expect(matchScannedFiles(graph, [candidate()]).missing).toHaveLength(1);
    expect(matchScannedFiles(graph, [candidate('002 V1.0-3 20261022.idax')]).missing).toEqual([]);
    await expect(repository.setPartNumber(graph.project.id, before.project.revision, '003')).rejects.toThrow('其他标签页');
    await expect(repository.setPartNumber(graph.project.id, graph.project.revision, ' ')).rejects.toThrow('不能为空');
    expect(await repository.get(graph.project.id)).toEqual(graph);
    const snapshot = await repository.snapshot(graph.project.id);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.graph).not.toHaveProperty('files');
    expect(snapshot.graph.project).not.toHaveProperty('wordDirectoryHint');
    expect(snapshot.graph.project).not.toHaveProperty('engineeringDirectoryHint');
    expect(snapshot).not.toHaveProperty('directoryBindings');
    expect(graph.nodes[0]!.version).toBe('V1.0-3 20261022');
    const other = await repository.create('其他项目', '001');
    expect((await repository.get(other.project.id)).nodes).toEqual([]);
  });
  async function oldDatabase(conflict: boolean) {
    const name = `migration-${crypto.randomUUID()}`;
    const db = new Dexie(name); databases.push(db);
    db.version(1).stores({ projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId', branches: 'id, projectId', tasks: 'id, projectId, &[projectId+loopId]', files: 'id, projectId, nodeId' });
    const graph = createProject('旧项目', '001');
    await db.table('projects').add(graph.project);
    const nodes: VersionNode[] = (conflict ? ['V1  2026', 'V1 2026'] : ['V1  2026']).map((version, index) => ({
      id: `old-${index}`, projectId: graph.project.id, version, releasedAt: null, description: '', taskId: null,
    }));
    await db.table('nodes').bulkAdd(nodes); db.close();
    const next = new ArchiveDatabase(name); databases.push(next);
    return { db, next, nodes, project: graph.project };
  }
  it('v1升级到v3保留原图和旧文本，不自动重写身份', async () => {
    const { next, nodes, project } = await oldDatabase(false);
    const graph = await new ArchiveRepository(next).get(project.id);
    expect(graph.nodes).toEqual(nodes);
    expect(await next.directoryBindings.count()).toBe(0);
    expect(next.backendDB().version).toBe(30);
  });
  it('v1规范化碰撞拒绝升级且回滚，旧数据库可恢复', async () => {
    const { db, next, nodes } = await oldDatabase(true);
    await expect(next.open()).rejects.toThrow('升级已取消');
    await db.open();
    expect(db.backendDB().version).toBe(10);
    expect(await db.table('nodes').toArray()).toEqual(nodes);
  });
  it('零件号更新写入失败完整回滚，重新打开保留最新成功号码与图', async () => {
    const repository = repo();
    let graph = await repository.create('项目', '001');
    graph = await repository.register(graph.project.id, 0, [candidate()]);
    graph = await repository.setPartNumber(graph.project.id, graph.project.revision, '002');
    repository.db.projects.hook('updating', () => { throw new DOMException('空间不足', 'QuotaExceededError'); });
    await expect(repository.setPartNumber(graph.project.id, graph.project.revision, '003')).rejects.toThrow('空间不足');
    repository.db.close();
    await repository.db.open();
    expect(await repository.get(graph.project.id)).toEqual(graph);
  });
  it('v2升级到v3移除文件表，保留放行图、任务、分支及目录绑定', async () => {
    const name = `v2-${crypto.randomUUID()}`;
    const old = new Dexie(name); databases.push(old);
    old.version(2).stores({ projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId', branches: 'id, projectId', tasks: 'id, projectId, &[projectId+loopId]', files: 'id, projectId, nodeId', directoryBindings: '[projectId+role], projectId' });
    let graph = registerCandidates(createProject('旧项目', '001'), [candidate(), candidate('001 V2.idax')]);
    graph.edges.push({ id: 'edge', projectId: graph.project.id, parentId: graph.nodes[0]!.id, childId: graph.nodes[1]!.id });
    graph.tasks.push({ id: 'task', projectId: graph.project.id, name: '任务', description: '', loopId: '1479-1' });
    graph.nodes[1]!.taskId = 'task';
    graph.branches.push({ id: 'main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: graph.nodes[1]!.id });
    graph = release(graph, graph.nodes[1]!.id, new Date().toISOString());
    graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
    await old.table('projects').add(graph.project);
    await old.table('nodes').bulkAdd(graph.nodes);
    await old.table('edges').bulkAdd(graph.edges);
    await old.table('tasks').bulkAdd(graph.tasks);
    await old.table('branches').bulkAdd(graph.branches);
    await old.table('files').add({ id: 'legacy', projectId: graph.project.id, nodeId: graph.nodes[0]!.id, relativePath: 'old.idax' });
    await old.table('directoryBindings').add({ projectId: graph.project.id, role: 'engineering', handle: { name: 'root', kind: 'directory' } });
    old.close();
    const next = new ArchiveDatabase(name); databases.push(next);
    const repository = new ArchiveRepository(next);
    expect(await repository.get(graph.project.id)).toEqual(graph);
    expect(next.tables.map(table => table.name)).not.toContain('files');
    expect((await next.directoryBindings.get([graph.project.id, 'engineering']))?.handle.name).toBe('root');
    const changed = await repository.setPartNumber(graph.project.id, 0, '002');
    expect(changed.nodes).toEqual(graph.nodes);
    expect((await next.directoryBindings.get([graph.project.id, 'engineering']))?.handle.name).toBe('root');
  });
});
