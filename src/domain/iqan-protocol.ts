import { requireCondition } from './model';

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reservedDeviceNamePattern = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
export type ArchiveLocation = 'shared' | 'local';

function assertSafePath(path: string): void {
  requireCondition(path.length > 0 && !path.includes('\\'), 'URI_PATH', '协议文件路径必须是非空的正斜线相对路径。');
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = path.charCodeAt(index + 1);
      requireCondition(next >= 0xdc00 && next <= 0xdfff, 'URI_PATH', '协议文件路径包含无效的 Unicode 字符。');
      index++;
    } else {
      requireCondition(code < 0xdc00 || code > 0xdfff, 'URI_PATH', '协议文件路径包含无效的 Unicode 字符。');
    }
  }
  requireCondition(!/^[\\/]|^[a-z]:|[\u0000:]/i.test(path), 'URI_PATH', '协议文件路径不能是绝对路径、盘符路径或数据流路径。');

  const parts = path.split('/');
  requireCondition(!parts.some(part => !part || part === '.' || part === '..'), 'URI_PATH', '协议文件路径包含无效或越界路径段。');
  requireCondition(
    parts.every(part => part.length <= 255
      && !/[<>:"|?*\u0000-\u001f]/.test(part)
      && !/[. ]$/.test(part)
      && !reservedDeviceNamePattern.test(part)),
    'URI_PATH',
    '协议文件路径包含 Windows 不支持的路径段。',
  );
  requireCondition(new TextEncoder().encode(path).length <= 2048, 'URI_PATH_LENGTH', '协议文件相对路径不能超过 2048 个 UTF-8 字节。');
}

function encodeRfc3986(value: string): string {
  return Array.from(new TextEncoder().encode(value), byte => {
    if ((byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e) {
      return String.fromCharCode(byte);
    }
    return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function archiveRelativePath(directoryName: string, fileRelativePath: string): string {
  requireCondition(directoryName.length > 0 && !directoryName.includes('/') && !directoryName.includes('\\'), 'URI_DIRECTORY', '工程目录名必须是单个路径段。');
  const path = `${directoryName}/${fileRelativePath}`;
  assertSafePath(path);
  return path;
}

function assertProjectId(projectId: string): void {
  requireCondition(projectIdPattern.test(projectId), 'URI_PROJECT', '项目 ID 必须是小写 UUID v4。');
}

function assertArchiveLocation(location: ArchiveLocation): void {
  requireCondition(location === 'shared' || location === 'local', 'URI_LOCATION', '归档位置必须是 shared 或 local。');
}

function assertUriLength(uri: string): string {
  requireCondition(uri.length <= 16_384, 'URI_LENGTH', '协议请求超过 16,384 个字符。');
  return uri;
}

export function buildOpenUri(projectId: string, directoryName: string, fileRelativePath: string, location: ArchiveLocation = 'shared'): string {
  assertProjectId(projectId);
  assertArchiveLocation(location);
  const path = archiveRelativePath(directoryName, fileRelativePath);
  return assertUriLength(`iqanarchive://open?v=2&project=${projectId}&location=${location}&file=${encodeRfc3986(path)}`);
}

export function buildDocumentOpenUri(projectId: string, directoryName: string, fileRelativePath: string, location: ArchiveLocation = 'shared'): string {
  assertProjectId(projectId);
  assertArchiveLocation(location);
  const path = archiveRelativePath(directoryName, fileRelativePath);
  requireCondition(/\.(doc|docx)$/i.test(fileRelativePath), 'URI_DOCUMENT', '仅支持打开 .doc/.docx 软件对比文档。');
  return assertUriLength(`iqanarchive://open-document?v=3&project=${projectId}&location=${location}&file=${encodeRfc3986(path)}`);
}

export function buildArchiveRootOpenUri(location: ArchiveLocation): string {
  assertArchiveLocation(location);
  return `iqanarchive://open-archive-root?v=1&location=${location}`;
}

export function buildEngineeringCopyUri(
  projectId: string,
  sourceLocation: ArchiveLocation,
  sourceDirectoryName: string,
  sourceRelativePath: string,
  targetDirectoryName: string,
  targetRelativePath: string,
  targetLocation: ArchiveLocation = 'local',
): string {
  assertProjectId(projectId);
  assertArchiveLocation(sourceLocation);
  assertArchiveLocation(targetLocation);
  const source = archiveRelativePath(sourceDirectoryName, sourceRelativePath);
  const target = archiveRelativePath(targetDirectoryName, targetRelativePath);
  requireCondition(/\.(idax|idsx|idvx)$/i.test(sourceRelativePath), 'URI_COPY_EXTENSION', '仅支持复制 .idax/.idsx/.idvx 工程文件。');
  requireCondition(pathExtension(targetRelativePath).toLowerCase() === pathExtension(sourceRelativePath).toLowerCase(), 'URI_COPY_EXTENSION', '复制目标必须保留源工程文件扩展名。');
  requireCondition(
    source.normalize('NFC').toLowerCase() !== target.normalize('NFC').toLowerCase()
      || sourceLocation !== targetLocation,
    'URI_COPY_SAME_FILE',
    '复制源与目标不能是同一个文件。',
  );
  const version = targetLocation === 'shared' ? '2' : '1';
  return assertUriLength(`iqanarchive://copy-engineering?v=${version}&project=${projectId}&sourceLocation=${sourceLocation}&sourceFile=${encodeRfc3986(source)}&targetLocation=${targetLocation}&targetFile=${encodeRfc3986(target)}`);
}

function pathExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

export function buildCompareUri(projectId: string, directoryName: string, fileARelativePath: string, fileBRelativePath: string): string;
export function buildCompareUri(
  projectId: string,
  directoryNameA: string,
  fileARelativePath: string,
  directoryNameB: string,
  fileBRelativePath: string,
  locationA?: ArchiveLocation,
  locationB?: ArchiveLocation,
): string;
export function buildCompareUri(
  projectId: string,
  directoryNameA: string,
  fileARelativePath: string,
  directoryNameBOrFileB: string,
  fileBOrLocationA?: string,
  locationA: ArchiveLocation = 'shared',
  locationB: ArchiveLocation = 'shared',
): string {
  const sameDirectory = fileBOrLocationA === undefined;
  const directoryNameB = sameDirectory ? directoryNameA : directoryNameBOrFileB;
  const fileBRelativePath = sameDirectory ? directoryNameBOrFileB : fileBOrLocationA!;
  assertProjectId(projectId);
  assertArchiveLocation(locationA);
  assertArchiveLocation(locationB);
  const fileA = archiveRelativePath(directoryNameA, fileARelativePath);
  const fileB = archiveRelativePath(directoryNameB, fileBRelativePath);
  requireCondition(
    fileA.normalize('NFC').toLowerCase() !== fileB.normalize('NFC').toLowerCase(),
    'URI_SAME_FILE',
    '两个版本选择了同一个工程文件，无法对比。',
  );
  return assertUriLength(`iqanarchive://compare?v=2&project=${projectId}&locationA=${locationA}&fileA=${encodeRfc3986(fileA)}&locationB=${locationB}&fileB=${encodeRfc3986(fileB)}`);
}
