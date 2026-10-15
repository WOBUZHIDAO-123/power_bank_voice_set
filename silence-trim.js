// Leading and trailing silence, matching the desktop script's auto mode.
// A sample is silent only when every channel stays under the threshold.

const DEFAULTS = { thresholdDb: -45, minSilenceMs: 50, padStartMs: 0, padEndMs: 0 };

function linearThreshold(thresholdDb) {
  return 10 ** (thresholdDb / 20);
}

export function silenceIntervals(channels, sampleRate, options = {}) {
  const { thresholdDb, minSilenceMs } = { ...DEFAULTS, ...options };
  const limit = linearThreshold(thresholdDb);
  const minSamples = Math.max(1, Math.round(minSilenceMs / 1000 * sampleRate));
  const length = channels[0]?.length ?? 0;
  const intervals = [];
  let runStart = null;
  const silentAt = index => channels.every(channel => Math.abs(channel[index]) < limit);
  for (let index = 0; index < length; index++) {
    if (silentAt(index)) {
      if (runStart === null) runStart = index;
    } else if (runStart !== null) {
      if (index - runStart >= minSamples) intervals.push([runStart / sampleRate, index / sampleRate]);
      runStart = null;
    }
  }
  if (runStart !== null && length - runStart >= minSamples) intervals.push([runStart / sampleRate, length / sampleRate]);
  return intervals;
}

export function waveformBounds(channels, sampleRate, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const length = channels[0]?.length ?? 0;
  const duration = length / sampleRate;
  const intervals = silenceIntervals(channels, sampleRate, settings);
  let contentStart = 0;
  let contentEnd = duration;
  if (intervals.length && intervals[0][0] <= 0.02) contentStart = intervals[0][1];
  for (let index = intervals.length - 1; index >= 0; index--) {
    const [start, end] = intervals[index];
    if (end >= duration - 0.05) { contentEnd = start; break; }
  }
  contentStart = Math.max(0, contentStart - Math.max(settings.padStartMs, 0) / 1000);
  contentEnd = Math.min(duration, contentEnd + Math.max(settings.padEndMs, 0) / 1000);
  if (!Number.isFinite(duration) || duration <= 0 || contentStart >= contentEnd - 0.005) {
    throw new Error('没有检测到有效声音');
  }
  return {
    start: Math.max(0, Math.round(contentStart * sampleRate)),
    end: Math.min(length, Math.round(contentEnd * sampleRate)),
  };
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
}

export function checkRecordingDuration(seconds, maxSeconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('这段录音无法读取，请重新录。');
  if (seconds > maxSeconds) throw new Error('音频超过 ' + maxSeconds + ' 秒，请换一段更短的。');
}

export async function decodeRecording(blob, { maxSeconds } = {}) {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (maxSeconds != null) checkRecordingDuration(audio.duration, maxSeconds);
    const channels = [];
    for (let index = 0; index < audio.numberOfChannels; index++) channels.push(new Float32Array(audio.getChannelData(index)));
    return { channels, sampleRate: audio.sampleRate };
  } finally {
    await context.close();
  }
}

export function encodeWav(channels, sampleRate, start, end) {
  const count = end - start;
  const channelCount = channels.length;
  const dataBytes = count * channelCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let index = start; index < end; index++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][index] || 0));
      view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
      offset += 2;
    }
  }
  return bytes;
}
