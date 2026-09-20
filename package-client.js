import { compilePackage } from './voice-package.js';
import { checkCancelled } from './zip.js';

export function preparePackage(bytes, languageTag, { signal, onProgress = () => {} } = {}) {
  checkCancelled(signal);
  // Worker keeps the browser's cancel button responsive during FAT/CRC generation.
  if (typeof Worker === 'undefined') return compilePackage(bytes, languageTag, { signal, onProgress });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./package-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new DOMException('操作已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('语音包处理失败，请检查页面是否完整部署'));
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.progress) onProgress(data.progress.stage, data.progress.value);
      else if (data.error) finish(new Error(data.error));
      else finish(null, data.result);
    };
    worker.postMessage({ bytes, languageTag }, [bytes.buffer]);
  });
}
