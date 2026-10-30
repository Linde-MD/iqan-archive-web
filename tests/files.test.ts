import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { candidateState, parseEngineeringName, rebindReference, registerCandidates, type FileCandidate } from '../src/domain/filenames';
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
  it('完整版本不同形成不同根节点，相同完整版本多快照，不推进分支', () => {
    const graph = registerCandidates(createProject('项目', '001'), [
      candidate(), candidate('001 V1.0-3 20261023.idax'), candidate('001 V1.0-3  20261022.idsx', 'other'),
    ]);
    expect(graph.nodes.map(node => node.version)).toEqual(['V1.0-3 20261022', 'V1.0-3 20261023']);
    expect(graph.files).toHaveLength(3);
    expect(graph.files.every(item => item.candidateDate === null)).toBe(true);
    expect(graph.edges).toEqual([]); expect(graph.branches).toEqual([]);
    expect(candidateState(graph, candidate())).toContain('跳过');
    expect(candidateState(graph, candidate('002 V1.idax'))).toContain('零件号不匹配');
    expect(() => registerCandidates(graph, [candidate()])).toThrow('跳过');
  });
  it('版本大小写区分；空白归一冲突拒绝，路径字段不一致拒绝', () => {
    const graph = registerCandidates(createProject('项目', '001'), [candidate('001 V1.idax'), candidate('001 v1.idax')]);
    expect(graph.nodes).toHaveLength(2);
    graph.nodes[1]!.version = 'V1';
    expect(() => validateGraph(graph)).toThrow('重复');
    expect(candidateState(createProject('项目', '001'), { fileName: '001 V1.idax', relativePath: '../001 V1.idax' })).toContain('安全的相对路径');
  });
  it('重绑保留内部ID，只允许同项目完整版本，放行后新增/替换引用拒绝', () => {
    const graph = registerCandidates(createProject('项目', '001'), [candidate()]);
    const id = graph.files[0]!.id;
    const next = rebindReference(graph, id, candidate(undefined, 'moved'));
    expect(next.files[0]!.id).toBe(id);
    expect(next.files[0]!.relativePath).toContain('moved/');
    expect(() => rebindReference(graph, id, candidate('001 V2.idax'))).toThrow('同完整版本');
    const released = release(graph, graph.nodes[0]!.id, new Date().toISOString());
    expect(() => rebindReference(released, id, candidate(undefined, 'moved'))).toThrow('已锁定');
    expect(candidateState(released, candidate(undefined, 'other'))).toContain('已放行');
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

describe('项目事务及v2迁移', () => {
  it('登记/重绑/提示往返，修订冲突及批次非法输入完整回滚，快照无绑定', async () => {
    const repository = repo();
    let graph = await repository.create('项目', '001');
    const old = graph.project.revision;
    graph = await repository.register(graph.project.id, old, [candidate()]);
    await expect(repository.register(graph.project.id, old, [candidate(undefined, 'other')])).rejects.toThrow('其他标签页');
    await expect(repository.register(graph.project.id, graph.project.revision, [candidate('001 V2.idax'), candidate('002 V3.idax')])).rejects.toThrow('零件号');
    expect(await repository.get(graph.project.id)).toEqual(graph);
    graph = await repository.rebind(graph.project.id, graph.project.revision, graph.files[0]!.id, candidate(undefined, 'new'));
    graph = await repository.directoryHint(graph.project.id, graph.project.revision, 'word', ' C:\\Reports ');
    expect(graph.project.wordDirectoryHint).toBe('C:\\Reports');
    expect(await repository.snapshot(graph.project.id)).not.toHaveProperty('directoryBindings');
    expect(graph.nodes[0]!.version).toBe('V1.0-3 20261022');
    const other = await repository.create('其他项目', '001');
    expect((await repository.get(other.project.id)).files).toEqual([]);
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
  it('v1升级到v2保留原图和旧文本，不自动重写身份', async () => {
    const { next, nodes, project } = await oldDatabase(false);
    const graph = await new ArchiveRepository(next).get(project.id);
    expect(graph.nodes).toEqual(nodes);
    expect(await next.directoryBindings.count()).toBe(0);
    expect(next.backendDB().version).toBe(20);
  });
  it('v1规范化碰撞拒绝升级且回滚，旧数据库可恢复', async () => {
    const { db, next, nodes } = await oldDatabase(true);
    await expect(next.open()).rejects.toThrow('升级已取消');
    await db.open();
    expect(db.backendDB().version).toBe(10);
    expect(await db.table('nodes').toArray()).toEqual(nodes);
  });
});
