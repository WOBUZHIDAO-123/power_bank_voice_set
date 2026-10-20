import { createVoiceMapping } from './voice-mapping.js';

export function packageFromClips(files) {
  const mapping = createVoiceMapping();
  mapping.language = 'zh-CN';
  mapping.loadFiles(files);
  mapping.autoGenerate();
  const counts = mapping.counts();
  if (counts.missing) throw new Error('有 ' + counts.missing + ' 条提示无法组合');
  return mapping.exportZip();
}
