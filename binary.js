export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function languageTag(value) {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 16) {
    throw new Error('语言标识必须为不超过 16 字节的 BCP-47 标识');
  }
  try { return Intl.getCanonicalLocales(value)[0]; }
  catch { throw new Error('语言标识不符合 BCP-47 格式'); }
}

export function decodeLanguage(bytes) {
  try { return languageTag(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('设备或播放表中的语言标识无效'); }
}
