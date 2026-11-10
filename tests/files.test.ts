import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { engineeringFileAvailability, matchComparisonDocuments, matchScannedFiles, parseEngineeringName, registerCandidates, replaceRelativeFileName, type FileCandidate } from '../src/domain/filenames';
import { createProject, normalizeVersion, type VersionNode } from '../src/domain/model';
import { release, validateGraph } from '../src/domain/graph';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';
import { checkPermission, fileOperationErrorMessage, locateFile, projectDirectoryName, removeArchiveFile, resolveProjectDirectory, scanDirectory, type DirectoryHandle, type FileHandle } from '../src/files/directories';
import { JSON_BACKUP_LOCATION, listJsonBackups, MAX_ARCHIVE_ROOT_ENTRIES, writeJsonBackup } from '../src/files/archive-json';

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
    async removeEntry(child) {
      const index = entries.findIndex(item => item.kind === 'file' && item.name === child);
      if (index < 0) throw new DOMException('文件缺失', 'NotFoundError');
      entries.splice(index, 1);
    },
  };
}

function writableDirectory(name: string, initial: Record<string, string> = {}, permission: PermissionState = 'granted') {
  const contents = new Map(Object.entries(initial));
  const makeFile = (fileName: string): FileHandle => ({
    kind: 'file', name: fileName,
    async getFile() { return new File([contents.get(fileName) ?? ''], fileName); },
    async createWritable() {
      let value = '';
      return {
        async write(data: Blob | string) { value = typeof data === 'string' ? data : await data.text(); },
        async close() { contents.set(fileName, value); },
        async abort() {},
      } as FileSystemWritableFileStream;
    },
  });
  const handle: DirectoryHandle = {
    kind: 'directory', name,
    async *values() { for (const fileName of contents.keys()) yield makeFile(fileName); },
    async queryPermission() { return permission; },
    async requestPermission() { return permission; },
    async getDirectoryHandle(child) { throw new DOMException(`目录缺失：${child}`, 'NotFoundError'); },
    async getFileHandle(fileName, options) {
      if (contents.has(fileName)) return makeFile(fileName);
      if (options?.create) { contents.set(fileName, ''); return makeFile(fileName); }
      throw new DOMException(`文件缺失：${fileName}`, 'NotFoundError');
    },
  };
  return { handle, contents };
}

describe('文件名和版本身份', () => {
  it('只有两侧目录都扫描成功后才返回四种确定文件状态', () => {
    const scanned = new Set(['local', 'shared'] as const);
    expect(engineeringFileAvailability(new Set(['local']), scanned)).toBe('local');
    expect(engineeringFileAvailability(new Set(['shared']), scanned)).toBe('shared');
    expect(engineeringFileAvailability(new Set(['local', 'shared']), scanned)).toBe('both');
    expect(engineeringFileAvailability(new Set(), scanned)).toBe('none');
    expect(engineeringFileAvailability(new Set(['local']), new Set(['local']))).toBe('unknown');
  });
  it('删除已授权根目录内的指定工程文件并拒绝越界或无读写权限', async () => {
    const target = file('001 V1.idax');
    const nested = directory('nested', [target]);
    const root = directory('archive', [nested]);
    await removeArchiveFile(root, 'nested/001 V1.idax');
    const remaining: (DirectoryHandle | FileHandle)[] = [];
    for await (const entry of nested.values()) remaining.push(entry);
    expect(remaining).toEqual([]);
    await expect(removeArchiveFile(root, '../outside.idax')).rejects.toThrow('安全的相对路径');
    const readOnlyRoot = directory('read-only', [file('001 V1.idax')], 'denied');
    await expect(removeArchiveFile(readOnlyRoot, '001 V1.idax')).rejects.toThrow('读写授权');
  });
  it('按项目名推导统一根目录下的工程和文档子目录，并拒绝非法 Windows 名称', async () => {
    expect(projectDirectoryName('项目 A', 'engineering')).toBe('项目 A_iqan_project_files');
    expect(projectDirectoryName('项目 A', 'word')).toBe('项目 A_software_changes_docs');
    const root = directory('IQAN_Archive', [directory('项目 A_iqan_project_files', []), directory('项目 A_software_changes_docs', [])]);
    expect((await resolveProjectDirectory(root, '项目 A', 'engineering')).name).toBe('项目 A_iqan_project_files');
    expect((await resolveProjectDirectory(root, '项目 A', 'word')).name).toBe('项目 A_software_changes_docs');
    expect(() => projectDirectoryName('项目/逃逸', 'engineering')).toThrow();
    expect(() => projectDirectoryName(' '.repeat(2), 'engineering')).toThrow();
    expect(() => projectDirectoryName('A'.repeat(256), 'engineering')).toThrow();
    expect(projectDirectoryName('CON', 'word')).toBe('CON_software_changes_docs');
  });
  it('保留前导零和完整日期文本，空白归一，不校验版本中的日历日期', () => {
    expect(parseEngineeringName(' 001\t V1.0-3  \t20261399.IDAX ')).toEqual({ partNumber: '001', version: 'V1.0-3 20261399', extension: '.idax' });
    expect(parseEngineeringName('001 vA-B.1.idsx').version).toBe('vA-B.1');
    expect(parseEngineeringName('001 V1.idvx').extension).toBe('.idvx');
    expect(normalizeVersion(' V1 \t 2026 ')).toBe('V1 2026');
  });
  it('替换工程相对路径的文件名时保留所有子目录且不重复项目目录', () => {
    expect(replaceRelativeFileName('001 V1.idax', '001 V2.idax')).toBe('001 V2.idax');
    expect(replaceRelativeFileName('nested/deeper/001 V1.idax', '001 V2.idax')).toBe('nested/deeper/001 V2.idax');
    expect(() => replaceRelativeFileName('nested/001 V1.idax', '../001 V2.idax')).toThrow();
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

describe('JSON 备份根目录策略', () => {
  it('默认使用共享根目录，不隐式回退本地根目录', () => {
    expect(JSON_BACKUP_LOCATION).toBe('shared');
  });
});

describe('软件对比文档版本匹配', () => {
  it('按项目零件号和完整版本前缀临时匹配，保留任意后缀与多份文档', () => {
    const graph = registerCandidates(createProject('项目', '14798046800'), [
      candidate('14798046800 V1.0-2.idax'),
      candidate('14798046800 V1.0-28.idax'),
    ]);
    const documents = [
      candidate('14798046800 V1.0-28 20260108软件对比文档.docx'),
      candidate('14798046800 V1.0-28 第二份说明.doc', 'docs'),
      candidate('14798046800 V1.0-2 20260101 任意内容.docx'),
      candidate('其他零件 V1.0-28 20260108.docx'),
      candidate('14798046800 V1.0-28.pdf'),
      candidate('14798046800 V1.0-28 ../非法.docx'),
    ];
    const result = matchComparisonDocuments(graph, documents);
    const longVersion = graph.nodes.find(node => node.version === 'V1.0-28')!;
    const shortVersion = graph.nodes.find(node => node.version === 'V1.0-2')!;
    expect(result.get(longVersion.id)?.map(file => file.fileName)).toEqual([
      '14798046800 V1.0-28 20260108软件对比文档.docx',
      '14798046800 V1.0-28 第二份说明.doc',
    ]);
    expect(result.get(shortVersion.id)?.map(file => file.fileName)).toEqual(['14798046800 V1.0-2 20260101 任意内容.docx']);
  });

  it('不匹配只有前缀相似但版本不完整的文件', () => {
    const graph = registerCandidates(createProject('项目', '001'), [candidate('001 V1.0-28.idax')]);
    const [node] = graph.nodes;
    expect(matchComparisonDocuments(graph, [candidate('001 V1.0-280说明.docx')]).get(node!.id)).toEqual([]);
  });

  it('匹配日期后紧连中文说明的完整版本名', () => {
    const graph = registerCandidates(createProject('项目', '14798046800'), [
      candidate('14798046800 V1.0-29 20260430.idax'),
      candidate('14798046800 V1.0-29 20260421.idax'),
    ]);
    const current = graph.nodes.find(node => node.version === 'V1.0-29 20260430')!;
    const earlier = graph.nodes.find(node => node.version === 'V1.0-29 20260421')!;
    const matches = matchComparisonDocuments(graph, [
      candidate('14798046800 V1.0-29 20260430软件对比文档.docx'),
      candidate('14798046800 V1.0-29 20260421软件对比文档.docx'),
    ]);
    expect(matches.get(current.id)?.map(file => file.fileName)).toEqual(['14798046800 V1.0-29 20260430软件对比文档.docx']);
    expect(matches.get(earlier.id)?.map(file => file.fileName)).toEqual(['14798046800 V1.0-29 20260421软件对比文档.docx']);
  });
});

describe('只读目录扫描与定位', () => {
  it('将文件或目录不存在的浏览器错误转换为中文原因和恢复建议', () => {
    const message = fileOperationErrorMessage(new DOMException('A requested file or directory could not be found at the time an operation was processed.', 'NotFoundError'));
    expect(message).toContain('找不到所需的文件或目录');
    expect(message).toContain('归档根目录及对应项目子目录存在后重试扫描');
    expect(message).not.toContain('A requested');
    expect(fileOperationErrorMessage(new Error('项目修订冲突'))).toBe('项目修订冲突');
    expect(fileOperationErrorMessage(undefined)).toBe('文件操作失败，请重试。');
  });
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

describe('统一归档根目录 JSON 文件', () => {
  it('仅列出根目录直接子级 JSON，并受 5000 项扫描上限约束', async () => {
    const root = writableDirectory('IQAN_Archive', {
      'b.json': '{}',
      'A.JSON': '{}',
      'readme.txt': 'not json',
    });
    const names = (await listJsonBackups(root.handle)).map(file => file.name);
    expect(names).toEqual(['A.JSON', 'b.json']);

    const oversized: DirectoryHandle = {
      ...root.handle,
      async *values() { for (let index = 0; index <= MAX_ARCHIVE_ROOT_ENTRIES; index++) yield file(`entry-${index}.txt`); },
    };
    await expect(listJsonBackups(oversized)).rejects.toThrow('超过 5000 个');
    await expect(listJsonBackups({ ...root.handle, async queryPermission() { return 'denied'; } }))
      .rejects.toThrow('授权已失效');
  });

  it('导出在归档根目录创建唯一 JSON，遇到重名则换名，不覆盖旧备份', async () => {
    const stamp = '2026-11-06T12-00-00-000Z';
    const root = writableDirectory('IQAN_Archive', { [`IQAN-项目-${stamp}-first.json`]: 'existing backup' });
    const ids = ['first', 'second'];
    const name = await writeJsonBackup(root.handle, '项目', '{"schemaVersion":3}', new Date('2026-11-06T12:00:00.000Z'), () => ids.shift()!);
    expect(name).toBe(`IQAN-项目-${stamp}-second.json`);
    expect(root.contents.get(`IQAN-项目-${stamp}-first.json`)).toBe('existing backup');
    expect(root.contents.get(name)).toBe('{"schemaVersion":3}');
    await expect(writeJsonBackup({ ...root.handle, async queryPermission() { return 'denied'; } }, '项目', '{}'))
      .rejects.toThrow('读写授权已失效');
  });
});

describe('项目事务及v3迁移', () => {
  it('统一归档根目录跨项目共享且不进入项目快照或项目删除事务', async () => {
    const archiveRepository = repo();
    const first = await archiveRepository.create('项目甲', '001');
    const second = await archiveRepository.create('项目乙', '002');
    const root = { kind: 'directory' as const, name: 'IQAN_Archive' } as DirectoryHandle;
    await archiveRepository.setArchiveRoot(root);
    expect((await archiveRepository.getArchiveRoot())?.name).toBe('IQAN_Archive');
    expect(await archiveRepository.snapshot(first.project.id)).not.toHaveProperty('archiveRoot');
    await archiveRepository.deleteProject(first.project.id, first.project.revision, first.project.name);
    expect((await archiveRepository.getArchiveRoot())?.name).toBe('IQAN_Archive');
    expect(await archiveRepository.get(second.project.id)).toEqual(second);
  });
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
    expect(snapshot.schemaVersion).toBe(3);
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
    db.version(1).stores({ projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId', branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]', files: 'id, projectId, nodeId' });
    const graph = createProject('旧项目', '001');
    await db.table('projects').add(graph.project);
    const nodes: VersionNode[] = (conflict ? ['V1  2026', 'V1 2026'] : ['V1  2026']).map((version, index) => ({
      id: `old-${index}`, projectId: graph.project.id, version, releasedAt: null, description: '', taskId: null,
    }));
    await db.table('nodes').bulkAdd(nodes); db.close();
    const next = new ArchiveDatabase(name); databases.push(next);
    return { db, next, nodes, project: graph.project };
  }
  it('v1升级到v6保留原图和版本身份', async () => {
    const { next, nodes, project } = await oldDatabase(false);
    const graph = await new ArchiveRepository(next).get(project.id);
    expect(graph.nodes).toEqual(nodes);
    expect(await next.directoryBindings.count()).toBe(0);
    expect(next.backendDB().version).toBe(60);
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
  it('v2升级到v6移除文件表、保留旧绑定并初始化全局根目录表', async () => {
    const name = `v2-${crypto.randomUUID()}`;
    const old = new Dexie(name); databases.push(old);
    old.version(2).stores({ projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId', branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]', files: 'id, projectId, nodeId', directoryBindings: '[projectId+role], projectId' });
    let graph = registerCandidates(createProject('旧项目', '001'), [candidate(), candidate('001 V2.idax')]);
    graph.edges.push({ id: 'edge', projectId: graph.project.id, parentId: graph.nodes[0]!.id, childId: graph.nodes[1]!.id });
    graph.branches.push({ id: 'main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: graph.nodes[1]!.id });
    graph = release(graph, graph.nodes[1]!.id, new Date().toISOString());
    graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
    await old.table('projects').add(graph.project);
    await old.table('nodes').bulkAdd(graph.nodes);
    await old.table('edges').bulkAdd(graph.edges);
    await old.table('branches').bulkAdd(graph.branches);
    await old.table('files').add({ id: 'legacy', projectId: graph.project.id, nodeId: graph.nodes[0]!.id, relativePath: 'old.idax' });
    await old.table('directoryBindings').add({ projectId: graph.project.id, role: 'engineering', handle: { name: 'root', kind: 'directory' } });
    old.close();
    const next = new ArchiveDatabase(name); databases.push(next);
    const repository = new ArchiveRepository(next);
    const migrated = await repository.get(graph.project.id);
    expect(migrated.tasks).toEqual([]);
    expect(migrated.nodes).toEqual(graph.nodes);
    expect(migrated.edges).toEqual(graph.edges);
    expect(migrated.branches).toEqual(graph.branches.map((branch, order) => ({ ...branch, order })));
    expect(next.backendDB().version).toBe(60);
    expect(next.tables.map(table => table.name)).toContain('archiveRoots');
    expect(next.tables.map(table => table.name)).not.toContain('files');
    expect((await next.directoryBindings.get([graph.project.id, 'engineering']))?.handle.name).toBe('root');
    const changed = await repository.setPartNumber(graph.project.id, 0, '002');
    expect(changed.nodes).toEqual(graph.nodes);
    expect((await next.directoryBindings.get([graph.project.id, 'engineering']))?.handle.name).toBe('root');
  });
  it('v5旧单根句柄迁移为shared，local保持未设置', async () => {
    const name = `v5-root-${crypto.randomUUID()}`;
    const old = new Dexie(name); databases.push(old);
    old.version(5).stores({
      projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId',
      branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]',
      directoryBindings: '[projectId+role], projectId', archiveRoots: 'id',
    });
    await old.table('archiveRoots').add({ id: 'root', handle: { name: 'LegacyArchive', kind: 'directory' } });
    old.close();
    const current = new ArchiveDatabase(name); databases.push(current);
    const repository = new ArchiveRepository(current);
    expect((await repository.getArchiveRoot('shared'))?.name).toBe('LegacyArchive');
    expect(await repository.getArchiveRoot('local')).toBeUndefined();
    expect(await current.archiveRoots.get('root')).toBeUndefined();
  });
});
