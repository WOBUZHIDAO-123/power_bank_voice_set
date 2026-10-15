import { languageTag } from './binary.js';
import { MAX_ZIP_SIZE, zipStore } from './zip.js';

export const MAX_FILE_ID = 255;
export const MAX_SEQUENCE = 8;
export const EVENT_BATTERY_REMAINING = 0x0001;
export const EVENT_CHARGING_PROGRESS = 0x0002;
const FIXED_EVENTS = [
  [0x0100, '开始充电', 'START_CHARGING'],
  [0x0104, '停止充电', 'STOP_CHARGING'],
  [0x0101, '开始放电', 'START_DISCHARGING'],
  [0x0105, '停止放电', 'STOP_DISCHARGING'],
  [0x0102, '电量已满', 'BATTERY_FULL'],
  [0x0103, '电量不足', 'LOW_BATTERY'],
  [0x0106, '切换为盲文模式', 'MODE_BRAILLE'],
  [0x0107, '切换为语音模式', 'MODE_VOICE'],
  [0x0108, '切换为盲文和语音模式', 'MODE_BRAILLE_AND_VOICE']
];
const EVENT_NAMES = {
  [EVENT_BATTERY_REMAINING]: 'BATTERY_REMAINING',
  [EVENT_CHARGING_PROGRESS]: 'CHARGING_PROGRESS'
};
for (const [id, , name] of FIXED_EVENTS) EVENT_NAMES[id] = name;
const DEFAULT_TEXT_ORDER = ['当前电量为百分之', '电量已充至百分之', '零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '一百', ...FIXED_EVENTS.map(([, text]) => text)];
const PREFIX_RE = /^(\d{3})(.*)$/;
const STATUS_LABEL = { auto: '自动', manual: '手动', missing: '缺失' };
const ILLEGAL_TEXT = /[\\/:\x00-\x1f]/;

function spokenText(text, label) {
  const spoken = String(text || '').trim();
  if (!spoken) throw new Error('文件名缺少朗读文本: ' + label);
  const filename = '000' + spoken + '.mp3';
  if (ILLEGAL_TEXT.test(spoken) || spoken === '.' || spoken === '..' || filename.length > 240) {
    throw new Error('朗读文本不能包含路径符号: ' + label);
  }
  return spoken;
}

function fileStem(name) {
  const parts = String(name || '').split(/[/\\]/);
  const earlier = parts.slice(0, -1).join('');
  if (earlier && PREFIX_RE.test(earlier.replace(/\.[^.]+$/, ''))) throw new Error('朗读文本不能包含路径符号: ' + name);
  return parts.at(-1).replace(/\.[^.]+$/, '');
}

export function mpegAudioPayload(bytes) {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const start = 10 + size;
    if (start <= bytes.length) return bytes.subarray(start);
  }
  return bytes;
}

export function concatMp3(parts) {
  if (!parts.length) throw new Error('没有可拼接的音频');
  if (parts.length === 1) return parts[0];
  const chunks = [parts[0], ...parts.slice(1).map(mpegAudioPayload)];
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

export function numberParts(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('数字超出 0～100');
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value === 0) return ['零'];
  if (value < 10) return [digits[value]];
  if (value === 10) return ['十'];
  if (value < 20) return ['十', digits[value - 10]];
  if (value === 100) return ['一百'];
  const tens = Math.floor(value / 10), ones = value % 10;
  return ones ? [digits[tens], '十', digits[ones]] : [digits[tens], '十'];
}

export function allEventKeys() {
  const ordered = [];
  for (let value = 0; value <= 100; value++) ordered.push([EVENT_BATTERY_REMAINING, value]);
  for (let value = 0; value <= 100; value++) ordered.push([EVENT_CHARGING_PROGRESS, value]);
  for (const [id] of FIXED_EVENTS) ordered.push([id, -1]);
  return ordered;
}

const eventKey = (eventId, value) => eventId + ':' + value;
const sameSequence = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

function naturalTextKey(text) {
  return text.split(/(\d+)/).map(part => /^\d+$/.test(part) ? Number(part) : part);
}

function compareNatural(left, right) {
  const a = naturalTextKey(left), b = naturalTextKey(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export function createVoiceMapping() {
  const clips = [];
  const byId = new Map(), byText = new Map(), events = new Map(), manual = new Map();
  let language = 'zh-CN';

  const indexClips = assigned => {
    const sorted = [...assigned].sort((a, b) => a.fileId - b.fileId);
    const seen = new Set();
    let total = 0;
    for (const clip of sorted) {
      if (seen.has(clip.text)) throw new Error('朗读文本重复: ' + clip.text);
      seen.add(clip.text);
      total += clip.bytes.length;
      if (total > MAX_ZIP_SIZE) throw new Error('音频总大小超过 16 MiB');
    }
    clips.splice(0, clips.length, ...sorted);
    byId.clear(); byText.clear();
    for (const clip of clips) { byId.set(clip.fileId, clip); byText.set(clip.text, clip); }
    events.clear();
  };

  const lookup = parts => {
    const joined = parts.join('');
    if (byText.has(joined)) return { sequence: [byText.get(joined).fileId], error: '' };
    const missing = parts.filter(part => !byText.has(part));
    if (missing.length) return { sequence: [], error: '缺少音频: ' + missing.join('、') };
    return { sequence: parts.map(part => byText.get(part).fileId), error: '' };
  };

  const mapping = {
    get language() { return language; },
    set language(value) { language = value; },
    get clips() { return clips; },
    get events() { return events; },
    clip(fileId) { return byId.get(fileId); },
    loadFiles(files) {
      const explicit = [], implicit = [];
      for (const file of files) {
        const stem = fileStem(file.name);
        const match = PREFIX_RE.exec(stem);
        const prefixed = match && Number(match[1]) >= 1 && Number(match[1]) <= MAX_FILE_ID;
        const text = spokenText((prefixed ? match[2] : stem).replace(/^[-_.\s]+/, ''), file.name);
        if (!(file.bytes instanceof Uint8Array) || !file.bytes.length) throw new Error('音频文件为空: ' + file.name);
        if (prefixed) explicit.push({ name: file.name.split(/[/\\]/).at(-1), bytes: file.bytes, fileId: Number(match[1]), text });
        else implicit.push({ name: file.name.split(/[/\\]/).at(-1), bytes: file.bytes, text });
      }
      if (!explicit.length && !implicit.length) throw new Error('没有 MP3 文件');
      if (explicit.length + implicit.length > MAX_FILE_ID) throw new Error('音频文件超过 255 个');
      const used = new Set(explicit.map(file => file.fileId));
      if (used.size !== explicit.length) throw new Error('文件名中存在重复的三位 FileId');
      const order = new Map(DEFAULT_TEXT_ORDER.map((text, index) => [text, index]));
      implicit.sort((a, b) => (order.get(a.text) ?? 10000) - (order.get(b.text) ?? 10000) || compareNatural(a.text, b.text));
      let nextId = 1;
      const assigned = explicit.map(file => ({ ...file }));
      for (const file of implicit) {
        while (used.has(nextId)) nextId++;
        if (nextId > MAX_FILE_ID) throw new Error('自动分配 FileId 超出 1..255');
        used.add(nextId);
        assigned.push({ ...file, fileId: nextId });
        nextId++;
      }
      indexClips(assigned);
      manual.clear();
    },
    loadAssigned(assigned) {
      if (!assigned.length || assigned.length > MAX_FILE_ID) throw new Error('音频文件数量必须为 1～255');
      const used = new Set();
      const clips = assigned.map(file => {
        if (!Number.isInteger(file.fileId) || file.fileId < 1 || file.fileId > MAX_FILE_ID || used.has(file.fileId)) throw new Error('音频编号必须为不重复的 1～255');
        used.add(file.fileId);
        const text = spokenText(file.text, file.name || file.text);
        if (!(file.bytes instanceof Uint8Array) || !file.bytes.length) throw new Error('音频文件为空');
        return { fileId: file.fileId, text, bytes: file.bytes, name: file.name || String(file.fileId).padStart(3, '0') + text + '.mp3' };
      });
      indexClips(clips);
      manual.clear();
    },
    flattenToFullSentences() {
      this.autoGenerate();
      const assigned = [];
      const seen = new Map();
      for (const [eventId, value] of allEventKeys()) {
        const event = events.get(eventKey(eventId, value));
        if (!event || event.status === 'missing' || !event.sequence.length) continue;
        const text = event.sequence.map(fileId => byId.get(fileId).text).join('');
        if (seen.has(text)) continue;
        if (assigned.length >= MAX_FILE_ID) throw new Error('完整句音频超过 255 个');
        const fileId = assigned.length + 1;
        seen.set(text, fileId);
        assigned.push({
          fileId,
          text,
          bytes: concatMp3(event.sequence.map(fileId => byId.get(fileId).bytes)),
          name: String(fileId).padStart(3, '0') + text + '.mp3'
        });
      }
      if (!assigned.length) throw new Error('没有可拼成完整句的映射');
      this.loadAssigned(assigned);
      this.autoGenerate();
    },
    autoGenerate() {
      if (!clips.length) throw new Error('请先加载音频');
      const next = new Map();
      const add = (eventId, value, groups) => {
        const sequence = [];
        let error = '';
        for (const parts of groups) {
          const found = lookup(parts);
          error = found.error;
          if (error) break;
          sequence.push(...found.sequence);
        }
        if (!error && sequence.length > MAX_SEQUENCE) error = '组合长度 ' + sequence.length + ' 超过 ' + MAX_SEQUENCE;
        next.set(eventKey(eventId, value), { eventId, value, sequence, status: error ? 'missing' : 'auto', error });
      };
      const groupsFor = (prefix, value) => {
        const spoken = numberParts(value).join('');
        const percent = '百分之' + spoken;
        const full = prefix + percent;
        if (byText.has(full)) return [[full]];
        if (byText.has(percent) && byText.has(prefix)) return [[prefix], [percent]];
        const oldPrefix = prefix + '百分之';
        if (byText.has(oldPrefix) && byText.has(spoken)) return [[oldPrefix], [spoken]];
        if (byText.has(oldPrefix)) return [[oldPrefix], numberParts(value)];
        return [[full]];
      };
      for (let value = 0; value <= 100; value++) {
        add(EVENT_BATTERY_REMAINING, value, groupsFor('当前电量为', value));
        add(EVENT_CHARGING_PROGRESS, value, groupsFor('电量已充至', value));
      }
      for (const [eventId, text] of FIXED_EVENTS) add(eventId, -1, [[text]]);
      for (const [key, sequence] of manual) {
        if (!next.has(key)) continue;
        const [eventId, value] = key.split(':').map(Number);
        next.set(key, { eventId, value, sequence: [...sequence], status: 'manual', error: '' });
      }
      events.clear();
      for (const [key, event] of next) events.set(key, event);
    },
    adoptEntries(entries) {
      this.autoGenerate();
      for (const entry of entries) {
        const current = events.get(eventKey(entry.eventId, entry.value));
        if (current && sameSequence(current.sequence, entry.sequence)) continue;
        this.setManual(entry.eventId, entry.value, entry.sequence);
      }
    },
    setManual(eventId, value, sequence) {
      const key = eventKey(eventId, value);
      if (!events.has(key)) throw new Error('没有这条播放事件');
      if (!Array.isArray(sequence) || sequence.length < 1 || sequence.length > MAX_SEQUENCE) throw new Error('手动序列长度必须为 1～8');
      if (sequence.some(fileId => !byId.has(fileId))) throw new Error('手动序列引用了不存在的 FileId');
      manual.set(key, [...sequence]);
      events.set(key, { eventId, value, sequence: [...sequence], status: 'manual', error: '' });
    },
    clearManual(eventId, value) {
      manual.delete(eventKey(eventId, value));
      this.autoGenerate();
    },
    counts() {
      let auto = 0, manualCount = 0, missing = 0;
      for (const event of events.values()) {
        if (event.status === 'auto') auto++;
        else if (event.status === 'manual') manualCount++;
        else missing++;
      }
      return { total: events.size, auto, manual: manualCount, missing };
    },
    sequenceText(event) {
      if (event.status === 'missing') return event.error || '无可用组合';
      return event.sequence.map(fileId => {
        const clip = byId.get(fileId);
        return clip ? String(fileId).padStart(3, '0') + ':' + clip.text : String(fileId).padStart(3, '0');
      }).join(' + ');
    },
    statusLabel(status) { return STATUS_LABEL[status] || status; },
    eventName(eventId) { return EVENT_NAMES[eventId]; },
    manifest(includeMissing = false) {
      languageTag(language);
      const rows = [];
      for (const [eventId, value] of allEventKeys()) {
        const event = events.get(eventKey(eventId, value));
        if (!event || event.status === 'missing') {
          if (includeMissing) continue;
          throw new Error(event?.error || ('事件缺失: 0x' + eventId.toString(16).padStart(4, '0') + ', value=' + value));
        }
        rows.push({ event_id: event.eventId, event_name: EVENT_NAMES[event.eventId], value: event.value, sequence: [...event.sequence] });
      }
      return {
        schema_version: 1, language,
        audio_files: clips.map(clip => ({ file_id: clip.fileId, file: String(clip.fileId).padStart(3, '0') + clip.text + '.mp3', text: clip.text })),
        events: rows
      };
    },
    exportZip(includeMissing = false) {
      const data = this.manifest(includeMissing);
      const entries = [['voice.json', new TextEncoder().encode(JSON.stringify(data, null, 2))]];
      for (const clip of clips) entries.push([String(clip.fileId).padStart(3, '0') + clip.text + '.mp3', clip.bytes]);
      return zipStore(entries);
    },
    mappingDocument() {
      return {
        schema_version: 1, language,
        audio_files: clips.map(clip => ({ file_id: clip.fileId, source: clip.name, text: clip.text })),
        events: [...events.values()].map(event => ({ event_id: event.eventId, event_name: EVENT_NAMES[event.eventId], value: event.value, sequence: [...event.sequence], status: event.status }))
      };
    },
    applyMapping(data) {
      if (!clips.length) throw new Error('请先加载音频，再加载映射');
      if (data?.language) language = data.language;
      const textToId = new Map(clips.map(clip => [clip.text, clip.fileId]));
      const sourceToId = new Map(clips.map(clip => [clip.name, clip.fileId]));
      const remap = new Map();
      for (const item of data?.audio_files || []) {
        const nextId = textToId.get(item?.text) ?? sourceToId.get(item?.source);
        if (item?.file_id != null && nextId != null) remap.set(item.file_id, nextId);
      }
      manual.clear();
      for (const item of data?.events || []) {
        if (item?.status !== 'manual') continue;
        const sequence = (item.sequence || []).map(fileId => remap.get(fileId) ?? fileId);
        const missingIds = sequence.filter(fileId => !byId.has(fileId));
        if (missingIds.length) throw new Error('映射文件手动组合引用了未找到的音频 FileId: ' + missingIds.map(id => String(id).padStart(3, '0')).join(', '));
        manual.set(eventKey(item.event_id, item.value), sequence);
      }
      this.autoGenerate();
    }
  };
  return mapping;
}
