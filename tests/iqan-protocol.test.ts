import { describe, expect, it } from 'vitest';
import { buildArchiveRootOpenUri, buildCompareUri, buildDocumentOpenUri, buildEngineeringCopyUri, buildOpenUri, type ArchiveLocation } from '../src/domain/iqan-protocol';
import fixture from '../specs/fixtures/launcher-uri-v1.json';

const projectId = '550e8400-e29b-41d4-a716-446655440000';

describe('Launcher 工程 URI v1', () => {
  it('只能请求打开本机配置的共享或本地归档根目录', () => {
    expect(buildArchiveRootOpenUri('shared')).toBe('iqanarchive://open-archive-root?v=1&location=shared');
    expect(buildArchiveRootOpenUri('local')).toBe('iqanarchive://open-archive-root?v=1&location=local');
  });
  it('生成共享夹具定义的归档根目录打开请求', () => {
    for (const testCase of fixture.openArchiveRootValid) {
      expect(buildArchiveRootOpenUri(testCase.location.toLocaleLowerCase() as ArchiveLocation)).toBe(testCase.uri);
    }
  });
  it('生成共享夹具定义的归档根目录打开请求', () => {
    for (const testCase of fixture.openArchiveRootValid) {
      expect(buildArchiveRootOpenUri(testCase.location.toLocaleLowerCase() as ArchiveLocation)).toBe(testCase.uri);
    }
  });
  it('生成共享夹具定义的归档根目录打开请求', () => {
    for (const testCase of fixture.openArchiveRootValid) {
      expect(buildArchiveRootOpenUri(testCase.location.toLocaleLowerCase() as ArchiveLocation)).toBe(testCase.uri);
    }
  });
  it('文档使用独立 v2 操作，限定格式并复用路径校验', () => {
    expect(buildDocumentOpenUri(projectId, 'documents', '说明 A.DOCX')).toBe(`iqanarchive://open-document?v=3&project=${projectId}&location=shared&file=documents%2F%E8%AF%B4%E6%98%8E%20A.DOCX`);
    expect(buildDocumentOpenUri(projectId, 'documents', 'release.docx', 'local')).toBe(`iqanarchive://open-document?v=3&project=${projectId}&location=local&file=documents%2Frelease.docx`);
    expect(() => buildDocumentOpenUri(projectId, 'documents', 'file.exe')).toThrow();
    expect(() => buildDocumentOpenUri(projectId, 'documents', '../file.doc')).toThrow();
  });
  it('生成共享夹具定义的文档 v3 来源请求', () => {
    for (const testCase of fixture.documentV3Valid) {
      const filePath = testCase.files[0]!;
      const separator = filePath.indexOf('/');
      expect(buildDocumentOpenUri(
        testCase.projectId,
        filePath.slice(0, separator),
        filePath.slice(separator + 1),
        testCase.location.toLocaleLowerCase() as ArchiveLocation,
      )).toBe(testCase.uri);
    }
  });
  it('生成共享夹具定义的工程副本 v1 请求', () => {
    for (const testCase of fixture.copyValid) {
      const sourceFile = testCase.files[0]!;
      const targetFile = testCase.files[1]!;
      const sourceSeparator = sourceFile.indexOf('/');
      const targetSeparator = targetFile.indexOf('/');
      expect(buildEngineeringCopyUri(
        testCase.projectId,
        testCase.sourceLocation.toLocaleLowerCase() as ArchiveLocation,
        sourceFile.slice(0, sourceSeparator),
        sourceFile.slice(sourceSeparator + 1),
        targetFile.slice(0, targetSeparator),
        targetFile.slice(targetSeparator + 1),
      )).toBe(testCase.uri);
    }
  });
  it('生成本地上传到共享目录的工程副本 v2 请求', () => {
    for (const testCase of fixture.copyV2Valid) {
      const sourceFile = testCase.files[0]!;
      const targetFile = testCase.files[1]!;
      const sourceSeparator = sourceFile.indexOf('/');
      const targetSeparator = targetFile.indexOf('/');
      expect(buildEngineeringCopyUri(
        testCase.projectId,
        testCase.sourceLocation.toLocaleLowerCase() as ArchiveLocation,
        sourceFile.slice(0, sourceSeparator),
        sourceFile.slice(sourceSeparator + 1),
        targetFile.slice(0, targetSeparator),
        targetFile.slice(targetSeparator + 1),
        testCase.targetLocation.toLocaleLowerCase() as ArchiveLocation,
      )).toBe(testCase.uri);
    }
  });
  it('显式编码工程文件位置并保留 compare 两端各自位置', () => {
    expect(buildOpenUri(projectId, 'Demo_iqan_project_files', 'v1/model.idax', 'local'))
      .toBe(`iqanarchive://open?v=2&project=${projectId}&location=local&file=Demo_iqan_project_files%2Fv1%2Fmodel.idax`);
    expect(buildCompareUri(projectId, 'Demo_iqan_project_files', 'v1/model-a.idax', 'Demo_iqan_project_files', 'v2/model-b.idax', 'shared', 'local'))
      .toBe(`iqanarchive://compare?v=2&project=${projectId}&locationA=shared&fileA=Demo_iqan_project_files%2Fv1%2Fmodel-a.idax&locationB=local&fileB=Demo_iqan_project_files%2Fv2%2Fmodel-b.idax`);
  });

  it('工程副本请求明确来源与本地目标，保留扩展名并拒绝越界/不匹配目标', () => {
    expect(buildEngineeringCopyUri(projectId, 'shared', 'Demo_iqan_project_files', 'nested/99887766554 V1.0.idax', 'Demo_iqan_project_files', 'nested/99887766554 V1.1.idax'))
      .toBe(`iqanarchive://copy-engineering?v=1&project=${projectId}&sourceLocation=shared&sourceFile=Demo_iqan_project_files%2Fnested%2F99887766554%20V1.0.idax&targetLocation=local&targetFile=Demo_iqan_project_files%2Fnested%2F99887766554%20V1.1.idax`);
    expect(() => buildEngineeringCopyUri(projectId, 'local', 'Demo_iqan_project_files', '../model.idax', 'Demo_iqan_project_files', 'model.idax')).toThrow();
    expect(() => buildEngineeringCopyUri(projectId, 'local', 'Demo_iqan_project_files', 'model.idax', 'Demo_iqan_project_files', 'model.idsx')).toThrow('扩展名');
  });
  it('工程副本 v2 支持本地源上传到共享目录', () => {
    expect(buildEngineeringCopyUri(projectId, 'local', 'Demo_iqan_project_files', 'nested/99887766554 V1.0.idax', 'Demo_iqan_project_files', 'nested/99887766554 V1.0.idax', 'shared'))
      .toBe(`iqanarchive://copy-engineering?v=2&project=${projectId}&sourceLocation=local&sourceFile=Demo_iqan_project_files%2Fnested%2F99887766554%20V1.0.idax&targetLocation=shared&targetFile=Demo_iqan_project_files%2Fnested%2F99887766554%20V1.0.idax`);
    expect(() => buildEngineeringCopyUri(projectId, 'local', 'Demo_iqan_project_files', 'model.idax', 'Demo_iqan_project_files', 'model.idax', 'local'))
      .toThrow('同一个文件');
  });

  it.each([
    ['utf8-space-plus-percent', '中文 dir/plus+percent%.idax'],
    ['double-encoded-separator-is-not-decoded-twice', 'name%2Ftext.idax'],
  ])('匹配共享夹具中的编码边界：%s', (name, relativePath) => {
    const expected = fixture.valid.find(item => item.name === name)!;
    expect(buildOpenUri(expected.projectId, '1479_iqan_project_files', relativePath)).toContain(`&location=shared&file=${expected.uri.split('&file=')[1]}`);
  });

  it('按 UTF-8 字节和 RFC 3986 编码空格、加号、百分号及保留标点', () => {
    expect(buildOpenUri(projectId, '工程 项目', "子目录/a+b!'().idax")).toBe(
      'iqanarchive://open?v=2&project=550e8400-e29b-41d4-a716-446655440000&location=shared&file=%E5%B7%A5%E7%A8%8B%20%E9%A1%B9%E7%9B%AE%2F%E5%AD%90%E7%9B%AE%E5%BD%95%2Fa%2Bb%21%27%28%29.idax',
    );
  });

  it.each([
    ['大写 UUID', '550E8400-E29B-41D4-A716-446655440000', 'dir', 'file.idax'],
    ['越界路径', projectId, 'dir', '../file.idax'],
    ['反斜线路径', projectId, 'dir', 'sub\\file.idax'],
    ['Windows 保留设备名', projectId, 'dir', 'CON.idax'],
    ['控制台设备名', projectId, 'dir', 'CONOUT$.idax'],
    ['尾随点', projectId, 'dir', 'file.idax.'],
    ['非法字符', projectId, 'dir', 'bad?.idax'],
  ])('拒绝不符合协议的路径或项目标识（%s）', (_name, id, directory, path) => {
    expect(() => buildOpenUri(id, directory, path)).toThrow();
  });

  it('拒绝同一个文件的大小写变体和超限路径', () => {
    expect(() => buildCompareUri(projectId, 'dir', 'V1/model.idax', 'v1/MODEL.IDAX')).toThrow('同一个工程文件');
    expect(() => buildOpenUri(projectId, 'dir', `${'a'.repeat(256)}.idax`)).toThrow('Windows 不支持');
    expect(() => buildOpenUri(projectId, 'dir', Array.from({ length: 3 }, () => '中'.repeat(250)).join('/') + '/model.idax')).toThrow('2048');
  });
});
