import { languageTag } from './binary.js';
const HISTORY_KEY='voice-writer.last-success.v1';
export function parseCatalog(data, base) {
  if (!Array.isArray(data)) throw new Error('语种清单必须是数组');
  const seen = new Set();
  return data.map(item => {
    if (!item || !['id', 'name', 'languageTag'].every(
      key => typeof item[key] === 'string' && item[key].trim()) || seen.has(item.id)) {
      throw new Error('语种条目不完整（需要 ZIP 地址和语言标识）或编号重复');
    }
    seen.add(item.id);
    const row = { id: item.id, name: item.name, languageTag: languageTag(item.languageTag) };
    if (item.package === null) return { ...row, package: null };
    if (typeof item.package !== 'string' || !item.package.trim()) throw new Error('语种条目不完整：需要 ZIP 地址或明确设为 null');
    for (const key of ['package']) {
      const url = new URL(item[key], base);
      if (url.origin !== new URL(base).origin || !['http:', 'https:'].includes(url.protocol) ||
          url.username || url.password || url.hash) throw new Error('语种资源必须位于同一站点');
      row[key] = url.href;
    }
    return row;
  });
}
export async function loadCatalog(){const url=new URL('./languages.json',import.meta.url);const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);return parseCatalog(await response.json(),url);}
export function readHistory(storage,catalog){try{if(!storage)throw new Error();const id=storage.getItem(HISTORY_KEY);if(!id)return {};const item=catalog.find(row=>row.id===id);if(item)return {item};if(id.startsWith('local:')){const tag=languageTag(id.slice(6));return {local:{name:tag,languageTag:tag}};}storage.removeItem(HISTORY_KEY);return {stale:true};}catch{return {unavailable:true};}}
export function saveHistory(storage,id){try{if(!storage)return false;storage.setItem(HISTORY_KEY,id);return true;}catch{return false;}}
export async function fetchBytes(url, { limit = 0x800000, label = '镜像', signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 60000);
  const tooLarge = `${label}超过大小上限（${limit} 字节）`;
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`${label}读取失败（HTTP ${response.status}）`);
    if (response.url && new URL(response.url).origin !== new URL(url).origin) {
      throw new Error(`${label}不能跳转到其他站点`);
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error(tooLarge);
    }
    if (!response.body) throw new Error(`${label}内容为空`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); throw new Error(tooLarge); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (error.name === 'AbortError') throw new Error(`${label}读取超时`);
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
