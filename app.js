import { SerialLink, Burner } from './protocol.js';
import { loadCatalog, readHistory, saveHistory, fetchBytes } from './resources.js';
import { preparePackage } from './package-client.js';
import { MAX_ZIP_SIZE, checkCancelled } from './zip.js';
import { checkConnection } from './connection-check.js';

const $ = id => document.getElementById(id);
const audio = new Audio();
let catalog = [], link = null, burner = null, prepared = null, previewURL = null;
let busy = false, connecting = false, playing = false, audioToken = 0, operation = null;
let connectedBefore = false, localItem = null;
const chosen = () => localItem ?? catalog.find(item => item.id === $('language').value);

function render() {
  const supported = window.isSecureContext && 'serial' in navigator;
  $('connect').disabled = busy || connecting || !supported;
  $('connect').textContent = connecting ? '正在连接…' : link && !link.closed ? '重新连接' : '连接设备';
  $('local-package').disabled = busy || connecting;
  $('language').disabled = busy || connecting || !catalog.length;
  $('preview').disabled = busy || connecting || !prepared;
  $('preview').textContent = playing ? '停止试听' : '试听';
  $('start').disabled = busy || connecting || !prepared || !link || link.closed;
  for (const id of ['voice-event','voice-value','voice-ids','voice-play','voice-queue','voice-stop','voice-sleep','voice-wake']) {
    $(id).disabled = busy || connecting || !link || link.closed;
  }
  $('cancel').disabled = !busy || !operation || operation.signal.aborted;
}
function stopAudio() {
  audioToken++; audio.pause(); audio.removeAttribute('src'); audio.load();
  playing = false; render();
}
function discardPrepared() {
  stopAudio();
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null; prepared = null;
}
function showHistory(item) {
  $('history').textContent = item ? '本浏览器上次成功写入：' + item.name + '（非设备读取）' : '暂无记录';
}
function progress(stage, value) {
  $('stage').textContent = stage; $('progress').value = value;
  $('progress').setAttribute('aria-label', stage + '阶段进度');
  $('percent').textContent = ['写入语音', '写入播放规则'].includes(stage) ? '本阶段 ' + Math.floor(value) + '%' : '';
}
function result(message, error = false) {
  $('result').textContent = message; $('result').classList.toggle('error', error);
}
function localStorageSafe() { try { return window.localStorage; } catch { return null; } }

async function prepareSelected() {
  if (busy || connecting) return;
  discardPrepared();
  const item = chosen();
  $('audio-message').textContent = ''; $('resource').textContent = ''; result('');
  if (!item) { progress('请选择语种', 0); render(); return; }
  if (!item.package) {
    $('resource').textContent = item.name + '尚未提供在线语音包，请选择对应语种的本地 ZIP。';
    progress('等待选择本地语音包', 0); render(); return;
  }
  busy = true; operation = new AbortController(); render();
  const signal = operation.signal;
  try {
    progress('下载语音包', 0);
    const bytes = await fetchBytes(item.package, { limit: MAX_ZIP_SIZE, label: '语音 ZIP', signal });
    const bundle = await preparePackage(bytes, item.languageTag, { signal, onProgress: progress });
    checkCancelled(signal);
    showPrepared(bundle, item);
  } catch (error) {
    discardPrepared();
    if (signal.aborted || error.name === 'AbortError') {
      progress('准备已取消', 0); result('已取消准备，尚未写入设备。');
    } else {
      progress('语音包准备失败', 0); result(error.message + '。设备未被修改，请重新选择语种重试。', true);
    }
  } finally { busy = false; operation = null; render(); }
}

function showPrepared(bundle, item) {
    previewURL = URL.createObjectURL(new Blob([bundle.preview], { type: bundle.previewType }));
    prepared = { ...bundle, id: item.id };
    $('audio-message').textContent = bundle.preview.length ? '' : '试听暂不可用，不影响烧录。';
    $('resource').textContent = '语音包已检查：' + (bundle.fileCount === null ? '配套镜像，' : bundle.fileCount + ' 个音频，') +
      bundle.entryCount + ' 条播放规则，镜像 ' + (bundle.image.length / 1024).toFixed(1) + ' KiB。';
    progress('语音包已就绪，可以试听或烧录', 0);
}

$('local-package').addEventListener('change', async () => {
  if (busy || connecting) return;
  const file = $('local-package').files?.[0];
  if (!file) return;
  const selected = catalog.find(item => item.id === $('language').value);
  discardPrepared(); localItem = null;
  $('local-package').value = ''; // Permit choosing the same file again after a failure.
  $('audio-message').textContent = ''; $('resource').textContent = ''; result('');
  busy = true; operation = new AbortController(); render();
  const signal = operation.signal;
  try {
    if (!/\.zip$/i.test(file.name)) throw new Error('请选择 ZIP 格式的语音包');
    if (!file.size || file.size > MAX_ZIP_SIZE) throw new Error('语音 ZIP 必须非空且不超过 16 MiB');
    progress('读取本地语音包', 0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkCancelled(signal);
    if (bytes.length !== file.size) throw new Error('本地文件读取不完整，请重新选择');
    const bundle = await preparePackage(bytes, selected?.languageTag, { signal, onProgress: progress });
    checkCancelled(signal);
    const match = catalog.find(item => item.languageTag === bundle.languageTag);
    localItem = { id: 'local:' + bundle.languageTag, name: match?.name ?? bundle.languageTag, languageTag: bundle.languageTag };
    $('language').value = match?.id ?? '';
    showPrepared(bundle, localItem);
    $('resource').textContent = '本地文件：' + file.name + '；语种：' + bundle.languageTag + '。' + $('resource').textContent;
  } catch (error) {
    discardPrepared(); localItem = null;
    if (signal.aborted || error.name === 'AbortError') {
      progress('准备已取消', 0); result('已取消准备，尚未写入设备。');
    } else {
      progress('语音包准备失败', 0); result(error.message + '。设备未被修改，请重新选择 ZIP。', true);
    }
  } finally { busy = false; operation = null; render(); }
});

audio.addEventListener('ended', () => { playing = false; render(); });
audio.addEventListener('error', () => {
  if (!audio.hasAttribute('src')) return;
  playing = false; $('audio-message').textContent = '试听暂不可用，不影响烧录。'; render();
});
$('language').addEventListener('change', () => { if (busy || connecting) return; localItem = null; return prepareSelected(); });
$('preview').addEventListener('click', async () => {
  if (playing) { stopAudio(); return; }
  if (!prepared || busy) return;
  if (!prepared.preview.length) { $('audio-message').textContent = '试听暂不可用，不影响烧录。'; return; }
  stopAudio(); const token = audioToken;
  audio.src = previewURL; $('audio-message').textContent = ''; playing = true; render();
  try { await audio.play(); }
  catch { if (token === audioToken) { playing = false; $('audio-message').textContent = '试听暂不可用，不影响烧录。'; render(); } }
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
  const report = message => { diagnostics.push(message); $('diagnostic').textContent = diagnostics.join(' → '); };
  report('浏览器允许串口访问，等待选择设备');
  try {
    const port = await navigator.serial.requestPort();
    if (link) { await link.close(); link = null; }
    const candidate = new SerialLink(port); link = candidate;
    candidate.onDisconnect = () => {
      if (link !== candidate) return;
      $('connection').textContent = '未连接';
      if (busy) { operation?.abort(); result('设备连接已断开，请重新连接后完整烧录。', true); }
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
    await burner.burn(prepared.image, prepared.table, item.languageTag, { signal: operation.signal });
    progress('烧录成功', 100); result('本次已写入：' + item.name);
    if (saveHistory(localStorageSafe(), item.id)) showHistory(item);
    else $('storage').textContent = '烧录已成功，但浏览器无法保存记录，无法记住本次结果。';
  } catch (error) {
    progress(error.name === 'AbortError' ? '本次已停止' : '本次未完成', $('progress').value);
    result(error.message + '。', error.name !== 'AbortError');
  } finally { busy = false; operation = null; render(); }
});

async function testHardware(action) {
  if (busy || connecting || !link || link.closed) return;
  busy = true; operation = null; stopAudio(); render();
  $('voice-result').textContent = '正在向硬件发送测试命令…';
  try {
    await action();
    $('voice-result').textContent = '设备已接受命令，请观察硬件实际反应；此确认不代表已播放完成。';
  } catch (error) { $('voice-result').textContent = error.message; }
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
    for (const item of catalog) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name + (item.package === null ? '（选择本地 ZIP）' : '');
      $('language').append(option);
    }
    if (!catalog.length) $('resource').textContent = '暂无在线语音包，可选择电脑上的语音 ZIP。';
    const history = readHistory(localStorageSafe(), catalog);
    if (history.item) { $('language').value = history.item.id; showHistory(history.item); await prepareSelected(); }
    if (history.local) { const match = catalog.find(item => item.languageTag === history.local.languageTag); $('language').value = match?.id ?? ''; showHistory(match ?? history.local); $('resource').textContent += ' 上次写入来自本地 ZIP，请重新选择文件。'; }
    if (history.stale) $('resource').textContent += ' 上次使用的语种已移除，请重新选择。';
    if (history.unavailable) $('storage').textContent = '浏览器记录不可用，烧录仍可正常进行。';
  } catch (error) {
    $('resource').textContent = '语种清单加载失败：' + error.message;
    $('resource').classList.add('error');
  }
  render();
}
init();
