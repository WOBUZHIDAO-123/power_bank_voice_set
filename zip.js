import { crc32 } from './binary.js';

export const MAX_ZIP_SIZE = 16 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 12 * 1024 * 1024;
export function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}
export function packagePath(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\\:\x00-\x1f]/.test(name) ||
      name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('ZIP 包含不合法的文件路径');
  }
  return name.normalize('NFC');
}

async function inflate(bytes, expected, signal) {
  checkCancelled(signal);
  let stream;
  try { stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
  catch { throw new Error('当前浏览器不支持 ZIP 解压，请使用新版 Chrome'); }
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkCancelled(signal);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected) { await reader.cancel(); throw new Error('ZIP 解压大小超过声明值'); }
      chunks.push(value);
    }
    checkCancelled(signal);
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  if (size !== expected) throw new Error('ZIP 文件长度不一致');
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

// PKWARE APPNOTE 6.3.10: ordinary single-disk ZIP, stored and Deflate only.
export async function unzip(bytes, { signal } = {}) {
  checkCancelled(signal);
  if (!(bytes instanceof Uint8Array) || bytes.length < 22 || bytes.length > MAX_ZIP_SIZE) {
    throw new Error('ZIP 文件无效或超过 16 MiB');
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bound = (offset, length, end = bytes.length) => {
    if (offset < 0 || length < 0 || offset + length > end) throw new Error('ZIP 数据截断或边界错误');
  };
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 文件目录');
  const count = v.getUint16(eocd + 10, true), cdSize = v.getUint32(eocd + 12, true), cdStart = v.getUint32(eocd + 16, true);
  if (v.getUint16(eocd + 4, true) || v.getUint16(eocd + 6, true) ||
      v.getUint16(eocd + 8, true) !== count || !count || count > 2048 || cdStart + cdSize !== eocd) {
    throw new Error('ZIP 目录无效，不支持分卷或 ZIP64');
  }
  const decodeName = (raw, flags) => {
    if (!(flags & 0x800) && raw.some(byte => byte > 127)) throw new Error('ZIP 中文文件名需使用 UTF-8 编码');
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  };
  const checkExtra = (offset, size) => {
    const end = offset + size;
    while (offset < end) {
      bound(offset, 4, end);
      if (v.getUint16(offset, true) === 1) throw new Error('不支持 ZIP64');
      const length = v.getUint16(offset + 2, true);
      bound(offset + 4, length, end); offset += 4 + length;
    }
  };
  const entries = [], names = new Set(), ranges = [];
  let offset = cdStart, expanded = 0;
  for (let index = 0; index < count; index++) {
    bound(offset, 46, eocd);
    if (v.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录记录损坏');
    const flags = v.getUint16(offset + 8, true), method = v.getUint16(offset + 10, true);
    const crc = v.getUint32(offset + 16, true), compressed = v.getUint32(offset + 20, true), size = v.getUint32(offset + 24, true);
    const nameLen = v.getUint16(offset + 28, true), extraLen = v.getUint16(offset + 30, true), commentLen = v.getUint16(offset + 32, true);
    const local = v.getUint32(offset + 42, true), mode = v.getUint32(offset + 38, true) >>> 16;
    if ((flags & ~0x80e) || ![0, 8].includes(method) || v.getUint16(offset + 34, true) ||
        v.getUint16(offset + 6, true) > 20 || (mode & 0xf000) === 0xa000) {
      throw new Error('ZIP 不支持加密、链接或此压缩方式，请使用普通 ZIP（存储或 Deflate）');
    }
    bound(offset + 46, nameLen + extraLen + commentLen, eocd);
    checkExtra(offset + 46 + nameLen, extraLen);
    const rawName = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLen), flags);
    const directory = rawName.endsWith('/');
    const name = packagePath(directory ? rawName.slice(0, -1) : rawName);
    const folded = name.toLowerCase();
    if (names.has(folded)) throw new Error('ZIP 包含重复或大小写冲突的路径');
    names.add(folded);
    expanded += size;
    if (expanded > MAX_EXPANDED_SIZE || size > MAX_EXPANDED_SIZE || directory && size !== 0) throw new Error('ZIP 解压内容超过上限');
    bound(local, 30, cdStart);
    if (v.getUint32(local, true) !== 0x04034b50 || v.getUint16(local + 6, true) !== flags ||
        v.getUint16(local + 8, true) !== method) throw new Error('ZIP 本地文件头与目录不一致');
    const localNameLen = v.getUint16(local + 26, true), localExtraLen = v.getUint16(local + 28, true);
    bound(local + 30, localNameLen + localExtraLen, cdStart);
    checkExtra(local + 30 + localNameLen, localExtraLen);
    if (decodeName(bytes.subarray(local + 30, local + 30 + localNameLen), flags) !== rawName) throw new Error('ZIP 文件名不一致');
    const start = local + 30 + localNameLen + localExtraLen;
    bound(start, compressed, cdStart);
    let end = start + compressed;
    if (flags & 8) {
      bound(end, 12, cdStart);
      if (v.getUint32(end, true) === 0x08074b50) { end += 4; bound(end, 12, cdStart); }
      if (v.getUint32(end, true) !== crc || v.getUint32(end + 4, true) !== compressed || v.getUint32(end + 8, true) !== size) throw new Error('ZIP 数据描述不一致');
      end += 12;
    } else if (v.getUint32(local + 14, true) !== crc || v.getUint32(local + 18, true) !== compressed || v.getUint32(local + 22, true) !== size) {
      throw new Error('ZIP 文件长度或校验声明不一致');
    }
    ranges.push([local, end]);
    entries.push({ name, directory, method, crc, size, start, compressed });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (offset !== eocd) throw new Error('ZIP 目录大小不一致');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw new Error('ZIP 文件数据重叠');
  const files = new Map();
  for (const entry of entries) {
    checkCancelled(signal);
    const compressed = bytes.subarray(entry.start, entry.start + entry.compressed);
    const data = entry.method === 0 ? compressed.slice() : await inflate(compressed, entry.size, signal);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`ZIP 文件校验失败：${entry.name}`);
    if (!entry.directory) files.set(entry.name, data);
  }
  return files;
}
