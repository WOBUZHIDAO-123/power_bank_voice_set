import { crc32, languageTag, decodeLanguage } from './binary.js';

export function readTableLanguage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 48 || bytes.length > 4096) {
    throw new Error('播放表大小必须为 48～4096 字节');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'VPT1' || view.getUint16(4, true) !== 1 ||
      view.getUint16(6, true) !== 48 || view.getUint32(8, true) !== bytes.length) {
    throw new Error('播放表表头不合法');
  }
  const tagBytes = bytes.subarray(20, 36), zero = tagBytes.indexOf(0);
  if (zero >= 0 && tagBytes.subarray(zero).some(byte => byte !== 0)) throw new Error('播放表语言标识填充错误');
  return decodeLanguage(zero < 0 ? tagBytes : tagBytes.subarray(0, zero));
}

export function validateTable(bytes, imageCRC, selectedLanguage, maxSize = 4096) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 48 || bytes.length > Math.min(4096, maxSize)) {
    throw new Error('播放表大小必须为 48～4096 字节，且不超过设备上限');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint16(4, true);
  const entryCount = view.getUint16(36, true);
  const maxSequenceLength = bytes[38];
  const entriesOffset = view.getUint32(40, true);
  const poolOffset = view.getUint32(44, true);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'VPT1' || format !== 1 ||
      view.getUint16(6, true) !== 48 || view.getUint32(8, true) !== bytes.length ||
      bytes[39] !== 0 || maxSequenceLength < 1 || maxSequenceLength > 8 ||
      entriesOffset < 48 || entriesOffset > bytes.length ||
      poolOffset !== entriesOffset + entryCount * 8 || poolOffset > bytes.length ||
      (bytes.length - poolOffset) % 2 !== 0) {
    throw new Error('播放表表头、条目或序列池边界不合法');
  }
  if (view.getUint32(12, true) !== crc32(bytes.subarray(48))) throw new Error('播放表内容校验失败');
  if (view.getUint32(16, true) !== imageCRC) throw new Error('播放表与音频镜像不配套');

  const tag = readTableLanguage(bytes);
  if (tag !== languageTag(selectedLanguage)) throw new Error('播放表语言与所选语种不一致');

  const poolLength = (bytes.length - poolOffset) / 2;
  for (let index = 0; index < poolLength; index++) {
    const fileId = view.getUint16(poolOffset + index * 2, true);
    if (fileId < 1 || fileId > 999) throw new Error('播放表文件编号必须为 1～999');
  }
  const keys = new Set();
  for (let index = 0; index < entryCount; index++) {
    const offset = entriesOffset + index * 8;
    const event = view.getUint16(offset, true);
    const value = view.getInt16(offset + 2, true);
    const sequenceOffset = view.getUint16(offset + 4, true); // uint16 FileId units, not bytes.
    const length = bytes[offset + 6];
    const key = `${event}:${value}`;
    const knownEvent = (event === 1 || event === 2) ? value >= 0 && value <= 100 :
      [0x100, 0x101, 0x102, 0x103].includes(event) && value === -1;
    if (!knownEvent || keys.has(key) || bytes[offset + 7] !== 0 ||
        length < 1 || length > maxSequenceLength || sequenceOffset + length > poolLength) {
      throw new Error('播放表包含重复、非法条目或越界播放序列');
    }
    keys.add(key);
  }
  // Both numeric events need a mapping for every integer battery percentage.
  for (const event of [1, 2]) {
    for (let value = 0; value <= 100; value++) {
      if (!keys.has(`${event}:${value}`)) throw new Error('播放表必须覆盖两类电量提示的 0～100');
    }
  }
  for (const event of [0x100, 0x101, 0x102, 0x103]) {
    if (!keys.has(`${event}:-1`)) throw new Error('播放表缺少固定提示条目');
  }
  return { crc: crc32(bytes), imageCRC, languageTag: tag, entryCount, size: bytes.length, format, maxSequenceLength };
}

export function verifyTableInfo(info, table) {
  if (info.valid !== 1 || info.format !== table.format || info.size !== table.size ||
      info.crc !== table.crc || info.imageCRC !== table.imageCRC ||
      info.languageTag !== table.languageTag || info.entryCount !== table.entryCount ||
      info.maxSequenceLength < table.maxSequenceLength || info.maxSequenceLength > 8) {
    throw new Error('设备内容核对失败：播放表摘要与本次语种资源不一致');
  }
}
