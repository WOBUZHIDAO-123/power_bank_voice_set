import { compilePackage } from './voice-package.js';

self.onmessage = async ({ data }) => {
  try {
    const result = await compilePackage(data.bytes, data.languageTag, {
      audioOnly: data.audioOnly,
      onProgress: (stage, value) => self.postMessage({ progress: { stage, value } })
    });
    self.postMessage({ result }, [result.image.buffer, result.table.buffer, result.preview.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
