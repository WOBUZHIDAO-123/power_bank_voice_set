// Deterministic FAT12/FAT16 superfloppy: 512-byte sectors, two FATs, root files only.
// Audio bytes are unchanged; ASCII 8.3 names keep the protocol's three-digit FileId.
export function buildFatImage(files) {
  if (!Array.isArray(files) || !files.length || files.length > 255) throw new Error('音频文件数量必须为 1～255');
  const sorted = [...files].sort((a, b) => a.id - b.id), ids = new Set();
  for (const file of sorted) {
    if (!Number.isInteger(file.id) || file.id < 1 || file.id > 255 || ids.has(file.id) ||
        !(file.bytes instanceof Uint8Array) || !file.bytes.length || !['mp3', 'wav'].includes(file.extension)) throw new Error('镜像音频文件不合法');
    ids.add(file.id);
  }
  const needed = sorted.reduce((sum, file) => sum + Math.ceil(file.bytes.length / 512), 0);
  // Leave margin at the FAT12/FAT16 boundary and avoid reserved FAT12 cluster IDs.
  const bits = needed <= 4078 ? 12 : 16;
  const clusters = bits === 12 ? needed : Math.max(4096, needed);
  const fatSectors = Math.ceil(Math.ceil((clusters + 2) * bits / 8) / 512);
  const rootEntries = Math.ceil((sorted.length + 1) / 16) * 16;
  const rootSectors = rootEntries / 16;
  const totalSectors = 1 + 2 * fatSectors + rootSectors + clusters;
  if (totalSectors * 512 > 0x800000) throw new Error('音频加文件系统信息后超过 8 MiB，请缩小语音包');
  const bytes = new Uint8Array(totalSectors * 512), view = new DataView(bytes.buffer);
  const ascii = (text, offset) => bytes.set(new TextEncoder().encode(text), offset);
  bytes.set([0xeb, 0x3c, 0x90]); ascii('VOICE120', 3);
  view.setUint16(11, 512, true); bytes[13] = 1; view.setUint16(14, 1, true);
  bytes[16] = 2; view.setUint16(17, rootEntries, true); view.setUint16(19, totalSectors, true);
  bytes[21] = 0xf8; view.setUint16(22, fatSectors, true);
  view.setUint16(24, 32, true); view.setUint16(26, 64, true);
  bytes[36] = 0x80; bytes[38] = 0x29; view.setUint32(39, 0x12000001, true);
  ascii('NO NAME    ', 43); ascii(bits === 12 ? 'FAT12   ' : 'FAT16   ', 54);
  bytes.set([0xeb, 0xfe], 62); bytes[510] = 0x55; bytes[511] = 0xaa;
  const fat = bytes.subarray(512, 512 + fatSectors * 512);
  const setCluster = (cluster, value) => {
    if (bits === 16) { fat[cluster * 2] = value & 255; fat[cluster * 2 + 1] = value >>> 8; }
    else {
      const offset = Math.floor(cluster * 3 / 2);
      if (cluster & 1) { fat[offset] = (fat[offset] & 15) | ((value & 15) << 4); fat[offset + 1] = value >>> 4; }
      else { fat[offset] = value & 255; fat[offset + 1] = (fat[offset + 1] & 240) | (value >>> 8); }
    }
  };
  setCluster(0, bits === 12 ? 0xff8 : 0xfff8); setCluster(1, bits === 12 ? 0xfff : 0xffff);
  const root = (1 + 2 * fatSectors) * 512, data = root + rootSectors * 512;
  let next = 2;
  sorted.forEach((file, index) => {
    const entry = root + index * 32, count = Math.ceil(file.bytes.length / 512);
    ascii(String(file.id).padStart(3, '0').padEnd(8, ' ') + file.extension.toUpperCase(), entry);
    bytes[entry + 11] = 0x20;
    for (const offset of [16, 18, 24]) view.setUint16(entry + offset, 0x21, true); // 1980-01-01
    view.setUint16(entry + 26, next, true); view.setUint32(entry + 28, file.bytes.length, true);
    bytes.set(file.bytes, data + (next - 2) * 512);
    for (let i = 0; i < count; i++) setCluster(next + i, i === count - 1 ? (bits === 12 ? 0xfff : 0xffff) : next + i + 1);
    next += count;
  });
  bytes.set(fat, 512 + fatSectors * 512);
  return bytes;
}
