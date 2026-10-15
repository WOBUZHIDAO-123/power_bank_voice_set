import { createRowRecording } from './row-recording.js';
import { packageFromClips } from './clone-flow.js';
import { decodeRecording, encodeWav, waveformBounds } from './silence-trim.js';
import { SerialLink, Burner } from './protocol.js';
import { loadCatalog, readHistory, saveHistory } from './resources.js';
import { preparePackage } from './package-client.js';
import { MAX_ZIP_SIZE, checkCancelled, unzip } from './zip.js';
import { checkConnection } from './connection-check.js';
import { mountMappingEditor } from './mapping-editor.js';

const $ = id => document.getElementById(id);
const audio = new Audio();
let catalog = [], link = null, burner = null, prepared = null, previewURL = null;
let busy = false, connecting = false, playing = false, audioToken = 0, operation = null;
let connectedBefore = false, localItem = null;
let rowRecordingBusy = false;
function announce(message) {
  const node = $('announcer');
  if (!node || !message) return;
  const text = String(message);
  node.textContent = '';
  globalThis.setTimeout(() => { node.textContent = text; }, 30);
}
function customStatus(message) {
  $('custom-status').textContent = message;
  if (message) announce(message);
}
function audioMessage(message) {
  $('audio-message').textContent = message;
  if (message) announce(message);
}
const rowRecording = createRowRecording({ document, window, navigator, URL, decode: decodeRecording, report: customStatus, onBusy: value => { rowRecordingBusy = value; render(); } });
let selectedAudioId = null, listSource = null, currentListAudioId = null;
const listAudioViews = new Map();
const listDurationCache = new Map();
let seekingListAudio = false;
function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}
function listDurationKey(file) {
  return file.id + ':' + (file.bytes?.byteLength ?? 0) + ':' + (file.extension || '');
}
function rememberListDuration(file, seconds) {
  if (!file?.bytes || !Number.isFinite(seconds) || seconds <= 0) return;
  const key = listDurationKey(file);
  if (listDurationCache.get(key) === seconds) return;
  listDurationCache.set(key, seconds);
}
function ensureListDuration(file) {
  if (!file?.bytes) return;
  const key = listDurationKey(file);
  if (listDurationCache.has(key)) return;
  listDurationCache.set(key, null);
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.extension === 'mp3' ? 'audio/mpeg' : 'audio/wav' }));
  const probe = new Audio();
  const finish = seconds => {
    if (Number.isFinite(seconds) && seconds > 0) listDurationCache.set(key, seconds);
    else listDurationCache.delete(key);
    URL.revokeObjectURL(url);
    probe.removeAttribute('src'); probe.load();
    updateListAudioProgress();
  };
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', () => finish(probe.duration), { once: true });
  probe.addEventListener('error', () => finish(NaN), { once: true });
  probe.src = url;
}
function renderAudioList() {
  const files = prepared?.editable?.files ?? (prepared?.audioFiles?.length ? prepared.audioFiles : null);
  $('custom-panel').hidden = !files;
  if (!files) {
    if (listSource) { listSource = null; $('custom-list').replaceChildren(); rowRecording.clearViews(); listAudioViews.clear(); }
    return;
  }
  const source = files;
  $('custom-count').textContent = source.length + ' 条';
  $('custom-help').textContent = prepared?.editable ? '选择任意音频，可试听并上传替换。列表来自当前语音包。' : '此包暂不支持编辑。';
  if (!source.some(file => file.id === selectedAudioId)) selectedAudioId = source[0]?.id ?? null;
  if (source !== listSource) {
    listSource = source;
    $('custom-list').replaceChildren(); rowRecording.clearViews();
    for (const file of source) {
      const row = document.createElement('div'); row.className = 'voice-item';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'custom-audio'; radio.value = String(file.id);
      const filename = file.path?.split('/').at(-1) ?? ('音频 ' + file.id);
      radio.setAttribute('aria-label', String(file.id).padStart(3, '0') + ' ' + (file.text || filename));
      radio.addEventListener('change', () => { if (busy || connecting || rowRecordingBusy) return; selectedAudioId = file.id; render(); playListAudio(file); });
      const number = document.createElement('span'); number.className = 'voice-number'; number.textContent = String(file.id).padStart(3, '0'); number.setAttribute('aria-hidden', 'true');
      const info = document.createElement('span'); info.className = 'voice-info';
      const name = document.createElement('span'); name.className = 'voice-name'; name.textContent = file.text || filename; name.setAttribute('aria-hidden', 'true');
      const meta = document.createElement('div'); meta.className = 'source-progress';
      const sourceCaption = document.createElement('span'); sourceCaption.className = 'source-time'; sourceCaption.setAttribute('aria-hidden', 'true');
      const sourceBar = document.createElement('input'); sourceBar.type = 'range'; sourceBar.min = '0'; sourceBar.max = '1000'; sourceBar.value = '0'; sourceBar.step = '1';
      sourceBar.setAttribute('aria-label', '拖动编号 ' + file.id + ' 的播放进度');
      const seek = event => {
        event.stopPropagation();
        if (currentListAudioId !== file.id || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
        seekingListAudio = true;
        audio.currentTime = (Number(sourceBar.value) / 1000) * audio.duration;
        updateListAudioProgress();
      };
      sourceBar.addEventListener('pointerdown', seek);
      sourceBar.addEventListener('input', seek);
      sourceBar.addEventListener('change', event => { seek(event); seekingListAudio = false; });
      sourceBar.addEventListener('click', event => event.stopPropagation());
      meta.append(sourceCaption, sourceBar);
      meta.addEventListener('click', event => { if (event.target === sourceBar) return; event.stopPropagation(); playListAudio(file, true); });
      listAudioViews.set(file.id, { caption: sourceCaption, bar: sourceBar, file });
      info.append(name, meta); row.append(radio, number, info);
      const controls = document.createElement('div'); controls.className = 'voice-row-actions';
      const progressButton = document.createElement('button'); progressButton.type = 'button'; progressButton.className = 'clip-progress';
      const caption = document.createElement('span'); const bar = document.createElement('progress'); bar.max = 100; bar.value = 0;
      progressButton.append(caption, bar); bar.setAttribute('aria-hidden', 'true');
      const record = document.createElement('button'); record.type = 'button'; record.className = 'row-record';
      record.addEventListener('click', () => stopAudio());
      const upload = document.createElement('label'); upload.className = 'row-upload'; upload.textContent = '上传音频';
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.mp3,.wav,audio/mpeg,audio/wav'; input.setAttribute('aria-label','替换编号 ' + file.id);
      input.addEventListener('change', async () => {
        if (busy || connecting || rowRecordingBusy || !prepared?.editable) return;
        selectedAudioId = file.id;
        await replaceSelectedFile(input.files?.[0]); input.value = '';
      });
      upload.append(input); controls.append(progressButton, record, upload); row.append(controls); $('custom-list').append(row);
      rowRecording.mount(file.id, {record, progress:progressButton, caption, bar});
      row.addEventListener('click', event => { if (event.target === row || event.target === info || event.target === name || event.target === number || event.target === meta) { if (!busy && !connecting && !rowRecordingBusy) { selectedAudioId = file.id; render(); playListAudio(file); } } });
    }
  }
  for (const row of $('custom-list').children) {
    const radio = row.children[0]; radio.checked = Number(radio.value) === selectedAudioId; radio.disabled = busy || connecting || rowRecordingBusy;
    const actions = row.children[3]; actions.children[1].disabled = busy || connecting; actions.children[2].children[0].disabled = busy || connecting || rowRecordingBusy || !files;
    row.classList.toggle('selected', radio.checked);
  }
  for (const file of source) ensureListDuration(file);
  updateListAudioProgress();
  const selected = source.find(file => file.id === selectedAudioId);
  $('custom-selected').textContent = selected ? '已选择：' + (selected.path?.split('/').at(-1) ?? selected.id) : '请选择一条音频';
  $('custom-file').disabled = busy || connecting || !files || !selected;
  $('custom-preview').disabled = busy || connecting || !files || !selected;
}
function updateListAudioProgress() {
  for (const [id, view] of listAudioViews) {
    const active = currentListAudioId === id && audio.hasAttribute('src');
    if (active && Number.isFinite(audio.duration)) rememberListDuration(view.file, audio.duration);
    const known = listDurationCache.get(listDurationKey(view.file));
    const duration = active && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (Number.isFinite(known) ? known : 0);
    const elapsed = active && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const unavailable = busy || connecting || rowRecordingBusy || !view.file.bytes;
    view.bar.disabled = unavailable || !active || !duration;
    view.caption.textContent = (active && !audio.paused ? '❚❚ ' : '▶ ') + formatClock(elapsed) + ' / ' + (duration ? formatClock(duration) : '--:--');
    view.bar.setAttribute('aria-label', '编号 ' + id + ' 的播放进度，' + formatClock(elapsed) + ' / ' + (duration ? formatClock(duration) : '未知时长'));
    if (!(active && seekingListAudio)) view.bar.value = duration ? String(Math.round(elapsed / duration * 1000)) : '0';
  }
}
const chosen = () => localItem;

function readingStops() {
  if (typeof document.querySelectorAll !== 'function') return;
  for (const el of document.querySelectorAll('main h1, main h2, main p, main li, #connection, #stage, #percent, footer')) {
    if (el.closest('summary, button, a, label, select')) continue;
    if (!el.textContent.trim()) {
      if (el.getAttribute('tabindex') === '0') el.removeAttribute('tabindex');
      continue;
    }
    if (el.tabIndex < 0) el.tabIndex = 0;
  }
}
function placeInitialFocus() {
  if (typeof document.querySelector !== 'function') return;
  const start = document.querySelector('main h1');
  if (!start) return;
  start.tabIndex = 0;
  start.focus();
}
function render() {
  renderAudioList();
  readingStops();
  const controlsBusy = busy || rowRecordingBusy;
  const supported = window.isSecureContext && 'serial' in navigator;
  $('connect').disabled = controlsBusy || connecting || !supported;
  $('connect').textContent = connecting ? '正在连接…' : link && !link.closed ? '重新连接' : '连接设备';
  $('local-package').disabled = controlsBusy || connecting;
  $('clone-record').disabled = controlsBusy || cloneRecording || cloneCue;
  $('clone-stop').disabled = !cloneRecording;
  $('clone-file').disabled = controlsBusy || cloneRecording || cloneCue;
  $('start').textContent = prepared?.audioOnly ? '开始音频试烧' : '开始烧录';
  $('start').disabled = controlsBusy || connecting || rowRecordingBusy || !prepared || !link || link.closed;
  for (const id of ['voice-event','voice-value','voice-ids','voice-play','voice-queue','voice-stop','voice-sleep','voice-wake']) {
    $(id).disabled = controlsBusy || connecting || !link || link.closed;
  }
  $('cancel').disabled = !busy || !operation || operation.signal.aborted;
}
function stopAudio() {
  audioToken++; audio.pause(); audio.removeAttribute('src'); audio.load();
  currentListAudioId = null; playing = false; render();
}
function discardPrepared() {
  rowRecording.reset();
  stopAudio();
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null; prepared = null; selectedAudioId = null; $('custom-status').textContent = '';
}
function showHistory() {}
function progress(stage, value) {
  $('stage').textContent = stage; $('progress').value = value;
  const percentLabel = ['写入语音', '写入播放规则'].includes(stage) ? '本阶段 ' + Math.floor(value) + '%' : '';
  $('percent').textContent = percentLabel;
  $('progress').setAttribute('aria-valuetext', percentLabel ? stage + '，' + percentLabel : stage);
}
function result(message, error = false) {
  $('result').textContent = message; $('result').classList.toggle('error', error);
  if (message) announce(message);
}
function localStorageSafe() { try { return window.localStorage; } catch { return null; } }

function showPrepared(bundle, item) {
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(new Blob([bundle.preview], { type: bundle.previewType }));
    prepared = { ...bundle, id: item.id };
    $('audio-message').textContent = '';
    $('resource').textContent = '语言：' + bundle.languageTag + '。语音包已检查：' + (bundle.fileCount === null ? '配套镜像，' : bundle.fileCount + ' 个音频，') +
      bundle.entryCount + ' 条播放规则，镜像 ' + (bundle.image.length / 1024).toFixed(1) + ' KiB。' +
      (bundle.partial ? ' 这是部分映射测试包，只能测试清单中已有的提示。' : '');
    if (bundle.audioOnly) {
      $('resource').textContent = '检测到 ' + bundle.fileCount + ' 个音频，已生成试烧镜像。不读取播放表或语种清单；所选语种仅作参考。';
      $('voice-ids').value = String(bundle.audioFiles[0].id);
    }
    progress(bundle.audioOnly ? '音频试烧已就绪（仅写镜像）' : bundle.partial ? '部分映射测试包已就绪' : '语音包已就绪，可以试听或烧录', 0);
}

async function playListAudio(file, toggle = false) {
  rowRecording.pause();
  if (toggle && currentListAudioId === file.id && audio.hasAttribute('src')) {
    if (audio.paused) { try { await audio.play(); } catch { audioMessage('选中的音频无法试听。'); } }
    else audio.pause();
    updateListAudioProgress();
    return;
  }
  stopAudio();
  if (!file.bytes) { customStatus('示例音频没有原始声音；可点击录音测试并试听。'); return; }
  const token = audioToken;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = URL.createObjectURL(new Blob([file.bytes], {type:file.extension === 'mp3' ? 'audio/mpeg' : 'audio/wav'}));
  audio.src = previewURL; currentListAudioId = file.id; playing = true; render();
  try { await audio.play(); } catch { if (token === audioToken) { currentListAudioId = null; playing = false; render(); audioMessage('选中的音频无法试听。'); } }
}

$('custom-preview').addEventListener('click', async () => {
  if (busy || connecting) return;
  const file = prepared?.editable?.files.find(row => row.id === selectedAudioId);
  if (!file) return;
  stopAudio(); const token = audioToken;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = URL.createObjectURL(new Blob([file.bytes], { type: file.extension === 'mp3' ? 'audio/mpeg' : 'audio/wav' }));
  audio.src = previewURL; currentListAudioId = file.id; playing = true; render();
  try { await audio.play(); } catch { if (token === audioToken) { playing = false; audioMessage('此音频无法在浏览器试听。'); render(); } }
});

$('custom-file').addEventListener('change', () => replaceSelectedFile($('custom-file').files?.[0]));
async function replaceSelectedFile(file) {
  if (busy || connecting || !prepared?.editable) return;
  if (!file) return;
  $('custom-file').value = '';
  const fileId = selectedAudioId, item = chosen();
  busy = true; operation = new AbortController(); stopAudio(); render();
  const signal = operation.signal;
  try {
    if (!file.size || file.size > 4 * 1024 * 1024) throw new Error('录音必须非空且不超过 4 MiB');
    progress('正在替换提示音', 0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkCancelled(signal);
    const bundle = await preparePackage(bytes, prepared.languageTag, { signal, replacement: { bundle: prepared, fileId, filename: file.name } });
    checkCancelled(signal);
    showPrepared(bundle, item);
    customStatus('已替换音频：' + bundle.customAudio.map(id => String(id).padStart(3, '0')).join('、'));
    result('提示音已替换，可试听最新录音。尚未写入设备；点击开始烧录将写入完整语音包。');
  } catch (error) {
    progress('保留原准备结果', 0);
    result(signal.aborted ? '替换已取消，未写入设备。' : error.message + '。替换未生效，未写入设备。', !signal.aborted);
  } finally { busy = false; operation = null; render(); }
}

async function loadPackageBytes(bytes, name, languageTag, announceReady = true) {
  if (busy || connecting) throw new Error('请等待当前操作结束。');
  const selected = languageTag ? { languageTag } : null;
  discardPrepared(); localItem = null;
  $('audio-message').textContent = ''; $('resource').textContent = ''; result('');
  busy = true; operation = new AbortController(); render();
  const signal = operation.signal;
  try {
    if (!bytes?.length || bytes.length > MAX_ZIP_SIZE) throw new Error('语音 ZIP 必须非空且不超过 16 MiB');
    progress('读取本地语音包', 0);
    checkCancelled(signal);
    const bundle = await preparePackage(bytes, selected?.languageTag, { signal, onProgress: progress, audioOnly: false });
    checkCancelled(signal);
    const match = catalog.find(item => item.languageTag === bundle.languageTag);
    localItem = { id: 'local:' + bundle.languageTag, name: match?.name ?? bundle.languageTag, languageTag: bundle.languageTag };
    showPrepared(bundle, localItem);
    $('resource').textContent = '本地文件：' + name + (bundle.audioOnly ? '。' : '；语种：' + bundle.languageTag + '。') + $('resource').textContent;
    if (announceReady) announce($('resource').textContent);
  } catch (error) {
    discardPrepared(); localItem = null;
    if (signal.aborted || error.name === 'AbortError') {
      progress('准备已取消', 0); result('已取消准备，尚未写入设备。');
    } else {
      progress('语音包准备失败', 0); result(error.message + '。设备未被修改，请重新选择 ZIP。', true);
    }
    throw error;
  } finally { busy = false; operation = null; render(); }
}
let cloneRecording = false, cloneSession = null, cloneTimer = null, cloneCue = false;
function formatPackageSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
function cloneStatus(message) { $('clone-status').textContent = message; if (message) announce(message); }
function stopCloneClock() { if (cloneTimer !== null) window.clearInterval(cloneTimer); cloneTimer = null; }
async function generatedPackage(bytes) {
  const archive = await unzip(bytes);
  if (archive.has('voice.json')) return bytes;
  const files = [];
  for (const [name, data] of archive) if (/\.mp3$/i.test(name)) files.push({ name: name.split('/').at(-1), bytes: data });
  if (!files.length) throw new Error('复刻服务没有返回提示音');
  return packageFromClips(files);
}
async function submitCloneRecording(blob) {
  const endpoint = 'http://192.168.3.153:8766/clone';
  cloneStatus('正在去掉首尾空白。');
  let wav;
  try {
    const decoded = await decodeRecording(blob);
    const { start, end } = waveformBounds(decoded.channels, decoded.sampleRate);
    const seconds = (end - start) / decoded.sampleRate;
    if (seconds < 5) { cloneStatus('去掉空白后不足 5 秒，请重新录一段更长的话。'); return; }
    wav = new Blob([encodeWav(decoded.channels, decoded.sampleRate, start, end)], { type: 'audio/wav' });
  } catch (error) {
    cloneStatus(String(error?.message || '').includes('没有检测到有效声音') ? '没有检测到有效声音，请重新录。' : '这段录音无法读取，请重新录。');
    return;
  }
  cloneStatus('已去掉首尾空白。正在并行生成百分之数字和固定提示，遇到限流会自动重试。');
  let response;
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set('scheme', 'percent');
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  } catch { cloneStatus('无法连接复刻服务。'); return; }
  if (!response.ok) { cloneStatus(await response.text()); return; }
  try {
    const zip = await generatedPackage(new Uint8Array(await response.arrayBuffer()));
    const packageBytes = zip.byteLength;
    await loadPackageBytes(zip, '我的声音.zip', 'zh-CN', false);
    const size = formatPackageSize(packageBytes);
    $('resource').textContent += '语音包大小：' + size + '。';
    cloneStatus('语音包已生成，大小 ' + size + '。可以试听，连接设备后可以烧录。');
  } catch (error) { cloneStatus(error.message || '语音包生成失败。'); }
}
function beep(frequency) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(context.destination);
  const now = context.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
  oscillator.start(now);
  oscillator.stop(now + 0.3);
  return new Promise(resolve => { oscillator.onended = () => { context.close(); resolve(); }; });
}
function playCue(text, frequency) {
  if (!window.speechSynthesis) return beep(frequency);
  return new Promise(resolve => {
    let settled = false;
    const finish = spoken => { if (settled) return; settled = true; if (spoken) resolve(); else beep(frequency).then(resolve); };
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    window.setTimeout(() => { window.speechSynthesis.cancel(); finish(false); }, 4000);
  });
}
async function startCloneRecording() {
  if (busy || connecting || cloneRecording) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { cloneStatus('录音需要 HTTPS 或 localhost，以及支持麦克风的浏览器。'); return; }
  cloneCue = true; render();
  cloneStatus('请听提示音，随后开始录音。');
  try { await playCue('开始录音', 880); }
  finally { cloneCue = false; render(); }
  if (busy || connecting || cloneRecording) return;
  cloneStatus('请允许麦克风访问。');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch { cloneStatus('无法使用麦克风。'); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  cloneSession = { recorder, stream }; cloneRecording = true; render();
  const began = Date.now();
  $('clone-time').textContent = '0 秒';
  cloneTimer = window.setInterval(() => { $('clone-time').textContent = Math.floor((Date.now() - began) / 1000) + ' 秒'; }, 200);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => {
    stopCloneClock();
    stream.getTracks().forEach(track => track.stop());
    cloneRecording = false; cloneSession = null; render();
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    cloneCue = true; render();
    playCue('录音结束', 520).finally(() => {
      cloneCue = false; render();
      if (!blob.size) { cloneStatus('录音为空，请重试。'); return; }
      submitCloneRecording(blob);
    });
  };
  recorder.start(250);
  window.setTimeout(() => { if (cloneSession?.recorder === recorder && recorder.state === 'recording') recorder.stop(); }, 20000);
  cloneStatus('正在录音。说满约 20 秒，或点击停止并生成。');
  $('clone-stop').focus?.();
}
$('clone-file').addEventListener('change', () => {
  const file = $('clone-file').files?.[0];
  $('clone-file').value = '';
  if (!file || busy || connecting || cloneRecording) return;
  if (!/\.(wav|mp3|m4a)$/i.test(file.name)) { cloneStatus('请上传 wav、mp3 或 m4a。'); return; }
  if (!file.size || file.size > 10 * 1024 * 1024) { cloneStatus('音频必须非空且不超过 10 MB。'); return; }
  submitCloneRecording(file);
});
$('clone-record').addEventListener('click', () => { startCloneRecording(); });
$('clone-stop').addEventListener('click', () => { if (cloneSession?.recorder?.state === 'recording') cloneSession.recorder.stop(); });
$('local-package').addEventListener('change', async () => {
  if (busy || connecting) return;
  const file = $('local-package').files?.[0];
  if (!file) return;
  $('local-package').value = ''; // Permit choosing the same file again after a failure.
  try {
    if (!/\.zip$/i.test(file.name)) { result('请选择 ZIP 格式的语音包。设备未被修改。', true); return; }
    if (!file.size || file.size > MAX_ZIP_SIZE) { result('语音 ZIP 必须非空且不超过 16 MiB。设备未被修改。', true); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) { result('本地文件读取不完整，请重新选择。设备未被修改。', true); return; }
    await loadPackageBytes(bytes, file.name);
  } catch { /* loadPackageBytes already reported the failure */ }
});

audio.addEventListener('timeupdate', updateListAudioProgress);
audio.addEventListener('loadedmetadata', updateListAudioProgress);
audio.addEventListener('play', updateListAudioProgress);
audio.addEventListener('pause', updateListAudioProgress);
audio.addEventListener('ended', () => { playing = false; updateListAudioProgress(); render(); });
audio.addEventListener('error', () => {
  if (!audio.hasAttribute('src')) return;
  playing = false; audioMessage('试听暂不可用，不影响烧录。'); render();
});
$('cancel').addEventListener('click', () => {
  if (!busy || !operation) return;
  operation.abort();
  progress('正在停止，请等待设备确认', $('progress').value); render();
});
$('connect').addEventListener('click', async () => {
  if (busy || connecting) return;
  connecting = true; render(); result('');
  const diagnostics = [];
  const report = message => { diagnostics.push(message); $('diagnostic').textContent = diagnostics.join(' → '); announce(message); };
  report('浏览器允许串口访问，等待选择设备');
  try {
    const port = await navigator.serial.requestPort();
    if (link) { await link.close(); link = null; }
    const candidate = new SerialLink(port); link = candidate;
    candidate.onDisconnect = () => {
      if (link !== candidate) return;
      $('connection').textContent = '未连接';
      if (busy) { operation?.abort(); result('设备连接已断开，请重新连接后完整烧录。', true); }
      else announce('设备未连接。');
      render();
    };
    report('已选择设备，正在打开串口');
    await candidate.open();
    report('串口已打开');
    burner = new Burner(candidate, { onProgress: progress });
    // Reconnect observes current transfer status before any cleanup or restart.
    await checkConnection(burner, { reconnect: connectedBefore, report });
    connectedBefore = true;
    $('connection').textContent = '已连接';
    result('设备已连接，语音包准备好后可开始烧录。');
  } catch (error) {
    if (error.name === 'NotFoundError') report('未选择设备；如列表为空，请检查 USB 数据线、驱动及设备是否接在本机');
    else {
      report('检查未完成：' + error.message);
      if (link) await link.close();
      link = null; burner = null; $('connection').textContent = '未连接';
      result('连接失败：' + error.message, true);
    }
  } finally { connecting = false; render(); }
});
$('start').addEventListener('click', async () => {
  const item = chosen();
  if (busy || !item || !prepared || prepared.id !== item.id || !link || link.closed) return;
  busy = true; operation = new AbortController(); stopAudio();
  $('audio-message').textContent = ''; $('storage').textContent = ''; result(''); render();
  try {
    if (prepared.audioOnly) {
      await burner.burnImage(prepared.image, { signal: operation.signal });
      const rescanned = await rereadVoice();
      progress('音频镜像试烧成功', 100);
      result('音频镜像试烧成功。未更新播放表，不代表完整语种切换；可用下方编号队列测试硬件发声。' + rescanned);
      return;
    }
    await burner.burn(prepared.image, prepared.table, item.languageTag, { signal: operation.signal, allowPartial: prepared.partial === true });
    const rescanned = await rereadVoice();
    progress('烧录成功', 100); result('本次已写入：' + item.name + ((prepared.customPrompts?.length || prepared.customAudio?.length) ? '（含自定义提示音）' : '') + '。' + rescanned);
    if (saveHistory(localStorageSafe(), item.id)) showHistory(item);
    else $('storage').textContent = '烧录已成功，但浏览器无法保存记录，无法记住本次结果。';
    if ($('storage').textContent) announce($('storage').textContent);
  } catch (error) {
    progress(error.name === 'AbortError' ? '本次已停止' : '本次未完成', $('progress').value);
    result(error.message + '。', error.name !== 'AbortError');
  } finally { busy = false; operation = null; render(); }
});

async function rereadVoice() {
  progress('重新读取语音', 100);
  try {
    await burner.controlVoice(3);
    return '语音模块已重新上电并读取新的音频。';
  } catch {
    return '语音已写入，但模块没有重新读取。请给充电宝断电再上电，否则会听到上一个语音包的残留。';
  }
}
async function testHardware(action) {
  if (busy || connecting || !link || link.closed) return;
  busy = true; operation = null; stopAudio(); render();
  $('voice-result').textContent = '正在向硬件发送测试命令…';
  announce($('voice-result').textContent);
  try {
    await action();
    $('voice-result').textContent = '设备已接受命令，请观察硬件实际反应；此确认不代表已播放完成。';
    announce($('voice-result').textContent);
  } catch (error) { $('voice-result').textContent = error.message; announce(error.message); }
  finally { busy = false; render(); }
}
$('voice-play').addEventListener('click', () => testHardware(() => {
  const event = Number($('voice-event').value);
  const value = event <= 2 ? Number($('voice-value').value) : -1;
  if (event <= 2 && (!$('voice-value').value.trim() || !Number.isInteger(value) || value < 0 || value > 100)) throw new Error('电量需为 0～100 的整数');
  return burner.playEvent(event, value);
}));
$('voice-queue').addEventListener('click', () => testHardware(() => {
  const parts = $('voice-ids').value.trim().split(/[,，\s]+/);
  if (parts.some(part => !/^\d+$/.test(part))) throw new Error('请填写音频编号，用空格或逗号分隔');
  return burner.queueVoice(parts.map(Number));
}));
for (const [id, action] of [['voice-stop',0],['voice-sleep',1],['voice-wake',2]]) {
  $(id).addEventListener('click', () => testHardware(() => burner.controlVoice(action)));
}

window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});
async function init() {
  render();
  if (!window.isSecureContext) $('support').textContent = '此 HTTP 地址不能使用串口。请打开 HTTPS 网址，或在本机通过 localhost 运行。';
  else if (!('serial' in navigator)) $('support').textContent = '当前浏览器不支持设备连接，请使用 Windows 电脑版 Chrome。';
  else $('support').textContent = '请使用支持数据传输的 USB 线，在弹窗中选择设备。';
  try {
    catalog = await loadCatalog();
    const history = readHistory(localStorageSafe(), catalog);
    if (history.local || history.item) $('resource').textContent = '请重新选择语音包。语言以包内标识为准。';
    if (history.unavailable) { $('storage').textContent = '浏览器记录不可用，烧录仍可正常进行。'; announce($('storage').textContent); }
  } catch (error) {
    $('resource').textContent = '语种清单加载失败：' + error.message;
    $('resource').classList.add('error');
    announce($('resource').textContent);
  }
  render();
  placeInitialFocus();
}
mountMappingEditor({ document, getPrepared: () => prepared, usePackage: (bytes, language) => loadPackageBytes(bytes, 'mapping.zip', language), stopAudio, getBusy: () => busy || connecting });
init();
