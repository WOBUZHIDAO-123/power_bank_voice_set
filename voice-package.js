import { crc32, languageTag } from './binary.js';
import { unzip, packagePath, checkCancelled } from './zip.js';
import { buildFatImage } from './fat-image.js';
import { validateTable, readTableLanguage } from './voice-table.js';
import { validateImage } from './protocol.js';

export const EVENTS = { BATTERY_REMAINING: 1, CHARGING_PROGRESS: 2, START_CHARGING: 256,
  START_DISCHARGING: 257, BATTERY_FULL: 258, LOW_BATTERY: 259 };

function audioType(path, bytes) {
  const extension = path.split('.').at(-1).toLowerCase();
  const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  const mp3 = bytes.length >= 4 && (ascii(0, 3) === 'ID3' ||
    (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0 && (bytes[2] & 0xf0) !== 0xf0));
  const wav = bytes.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE';
  if (!(extension === 'mp3' && mp3 || extension === 'wav' && wav)) throw new Error(`音频扩展名或文件头不正确：${path}`);
  return extension;
}

export function buildVoiceTable(entries, tag, imageCRC) {
  // Sort longest first and share existing subsequences to fit the 4096-byte table.
  const pool = [], offsets = new Map();
  const key = sequence => sequence.join(',');
  const sequences = [...entries.map(row => row.sequence)].sort((a, b) => b.length - a.length || key(a).localeCompare(key(b), 'en'));
  for (const sequence of sequences) {
    if (offsets.has(key(sequence))) continue;
    let found = -1;
    for (let i = 0; i + sequence.length <= pool.length; i++) {
      if (sequence.every((id, j) => pool[i + j] === id)) { found = i; break; }
    }
    if (found < 0) {
      let overlap = Math.min(pool.length, sequence.length - 1);
      while (overlap > 0 && !sequence.slice(0, overlap).every((id, i) => pool[pool.length - overlap + i] === id)) overlap--;
      found = pool.length - overlap;
      pool.push(...sequence.slice(overlap));
    }
    offsets.set(key(sequence), found);
  }
  const poolOffset = 48 + entries.length * 8, total = poolOffset + pool.length * 2;
  if (total > 4096) throw new Error('播放规则生成后超过 4096 字节，请减少或复用播放组合');
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('VPT1'));
  view.setUint16(4, 1, true); view.setUint16(6, 48, true); view.setUint32(8, total, true);
  view.setUint32(16, imageCRC, true); bytes.set(new TextEncoder().encode(tag), 20);
  view.setUint16(36, entries.length, true); bytes[38] = Math.max(...entries.map(row => row.sequence.length));
  view.setUint32(40, 48, true); view.setUint32(44, poolOffset, true);
  entries.forEach((row, index) => {
    const offset = 48 + index * 8;
    view.setUint16(offset, row.eventId, true); view.setInt16(offset + 2, row.value, true);
    view.setUint16(offset + 4, offsets.get(key(row.sequence)), true); bytes[offset + 6] = row.sequence.length;
  });
  pool.forEach((id, index) => view.setUint16(poolOffset + index * 2, id, true));
  view.setUint32(12, crc32(bytes.subarray(48)), true);
  validateTable(bytes, imageCRC, tag);
  return bytes;
}

export async function compilePackage(zipBytes, expectedLanguage, { signal, onProgress = () => {}, audioOnly = false } = {}) {
  onProgress('解压语音包', 0);
  const isAudio = name => /\.(mp3|wav)$/i.test(name) && !name.startsWith('__MACOSX/') &&
    !name.split('/').some(part => part.startsWith('.'));
  const archive = await unzip(zipBytes, { signal, include: audioOnly ? isAudio : undefined });
  if (audioOnly) {
    const rows = [...archive].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (!rows.length) throw new Error('ZIP 中没有 MP3 或 WAV 音频文件');
    if (rows.length > 255) throw new Error('音频试烧最多支持 255 个文件');
    const used = new Set();
    const files = rows.map(([path, bytes]) => {
      const prefix = /^(\d{3})(?:[-_.]|$)/.exec(path.split('/').at(-1));
      const candidate = prefix ? Number(prefix[1]) : 0;
      const id = candidate >= 1 && candidate <= 255 && !used.has(candidate) ? candidate : null;
      if (id) used.add(id);
      return { id, path, bytes, extension: path.split('.').at(-1).toLowerCase() };
    });
    for (const file of files) {
      if (!file.bytes.length) throw new Error('音频文件为空：' + file.path);
      if (!file.id) {
        let id = 1; while (used.has(id)) id++;
        file.id = id; used.add(id);
      }
    }
    checkCancelled(signal);
    onProgress('生成音频试烧镜像', 0);
    const image = buildFatImage(files);
    validateImage(image);
    checkCancelled(signal);
    const first = files[0];
    return { image, table: new Uint8Array(), languageTag: expectedLanguage ? languageTag(expectedLanguage) : 'und',
      fileCount: files.length, entryCount: 0, audioOnly: true,
      audioFiles: files.map(({ id, path }) => ({ id, path })),
      preview: first.bytes.length <= 4 * 1024 * 1024 ? first.bytes.slice() : new Uint8Array(),
      previewType: first.extension === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
  }
  if (archive.has('table.bin') || archive.has('audio.img')) {
    if (archive.has('voice.json')) throw new Error('不能混用 table.bin 资源包与 voice.json 清单');
    const image = archive.get('audio.img'), table = archive.get('table.bin');
    if (!image || !table) throw new Error('ZIP 根目录需要配套的 audio.img 和 table.bin');
    for (const name of archive.keys()) {
      if (!['audio.img', 'table.bin', 'preview.mp3'].includes(name)) throw new Error(`直接资源包包含未知文件：${name}`);
    }
    checkCancelled(signal);
    onProgress('检查镜像和播放表', 0);
    const checksum = validateImage(image);
    const metadata = validateTable(table, checksum, expectedLanguage ?? readTableLanguage(table));
    // Preview failure must not prevent writing a valid image/table pair.
    let preview = archive.get('preview.mp3'), previewType = 'audio/mpeg';
    try {
      if (!preview || !preview.length || preview.length > 4 * 1024 * 1024) throw new Error('试听不可用');
      audioType('preview.mp3', preview);
    } catch { preview = new Uint8Array(); }
    checkCancelled(signal);
    return { image: image.slice(), table: table.slice(), languageTag: readTableLanguage(table),
      fileCount: null, entryCount: metadata.entryCount, preview: preview.slice(), previewType };
  }
  const manifestBytes = archive.get('voice.json');
  if (!manifestBytes || manifestBytes.length > 256 * 1024) throw new Error('ZIP 根目录需要 voice.json（最多 256 KiB）');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { throw new Error('voice.json 不是有效的 UTF-8 JSON'); }
  if (!manifest || manifest.formatVersion !== 1 || !Array.isArray(manifest.files) ||
      !manifest.files.length || manifest.files.length > 255 || !Array.isArray(manifest.entries) || manifest.entries.length !== 206) {
    throw new Error('voice.json 需包含版本 1、1～255 个音频和 206 条完整事件映射');
  }
  const tag = languageTag(manifest.languageTag);
  if (tag !== languageTag(expectedLanguage ?? tag)) throw new Error('ZIP 的语言标识与所选语种不一致');
  const used = new Set(['voice.json']), ids = new Set();
  let audioSize = 0;
  const files = manifest.files.map(file => {
    if (!file || !Number.isInteger(file.id) || file.id < 1 || file.id > 255 || ids.has(file.id)) throw new Error('音频编号必须为不重复的 1～255');
    const path = packagePath(file.path), basename = path.split('/').at(-1);
    if (!new RegExp('^' + String(file.id).padStart(3, '0') + '(?:[-_.])').test(basename)) throw new Error('音频文件名需以对应的三位编号开头');
    const bytes = archive.get(path);
    if (!bytes || !bytes.length || used.has(path)) throw new Error(`音频缺失、为空或被重复引用：${path}`);
    audioSize += bytes.length;
    if (audioSize > 0x800000) throw new Error('音频总大小超过 8 MiB');
    const extension = audioType(path, bytes);
    ids.add(file.id); used.add(path);
    return { id: file.id, bytes, extension };
  });
  const seen = new Set();
  const entries = manifest.entries.map(row => {
    const eventId = typeof row?.event === 'string' && Object.hasOwn(EVENTS, row.event) ? EVENTS[row.event] : row?.event;
    const value = row?.value;
    if (!Object.values(EVENTS).includes(eventId) || !Number.isInteger(value) ||
        (eventId <= 2 ? value < 0 || value > 100 : value !== -1) ||
        !Array.isArray(row.sequence) || row.sequence.length < 1 || row.sequence.length > 8 ||
        row.sequence.some(id => !Number.isInteger(id) || !ids.has(id))) {
      throw new Error('播放事件、数值或顺序无效，或引用了不存在的音频编号');
    }
    const key = `${eventId}:${value}`;
    if (seen.has(key)) throw new Error('播放表包含重复事件');
    seen.add(key);
    return { eventId, value, sequence: row.sequence };
  }).sort((a, b) => a.eventId - b.eventId || a.value - b.value);
  // Fixed event set + 206 distinct valid keys means both 0..100 ranges and four prompts are covered.
  const previewPath = packagePath(manifest.preview ?? manifest.files[0].path);
  const preview = archive.get(previewPath);
  if (!preview || !preview.length || preview.length > 4 * 1024 * 1024) throw new Error('试听文件缺失、为空或超过 4 MiB');
  const previewType = audioType(previewPath, preview);
  used.add(previewPath);
  for (const path of archive.keys()) if (!used.has(path)) throw new Error(`ZIP 包含清单未声明的文件：${path}`);
  checkCancelled(signal);
  onProgress('生成语音镜像', 0);
  const image = buildFatImage(files);
  checkCancelled(signal);
  onProgress('生成播放规则', 0);
  const table = buildVoiceTable(entries, tag, crc32(image));
  checkCancelled(signal);
  return { image, table, languageTag: tag, fileCount: files.length, entryCount: entries.length,
    preview: preview.slice(), previewType: previewType === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
}
