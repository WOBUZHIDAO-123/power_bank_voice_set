// Independent microphone diagnostic: never imports package or device-writing code.
export function initRecordingTest({ document, window, navigator, MediaRecorder, URL,
  now = () => Date.now(), setInterval = window.setInterval.bind(window), clearInterval = window.clearInterval.bind(window) }) {
  const el = id => document.getElementById(id);
  const start = el('record-start'), stop = el('record-stop'), player = el('record-player');
  const download = el('record-download'), status = el('record-status'), timer = el('record-time');
  let phase = 'idle', stream = null, recorder = null, interval = null, url = null, generation = 0;
  const supported = window.isSecureContext && navigator.mediaDevices?.getUserMedia && MediaRecorder;
  const message = text => { status.textContent = text; };
  const render = () => { start.disabled = !supported || phase !== 'idle'; stop.disabled = !['requesting', 'recording'].includes(phase); stop.textContent = phase === 'requesting' ? '取消申请' : '停止录音'; };
  const release = () => {
    if (interval !== null) clearInterval(interval);
    interval = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
  };
  const clearResult = () => {
    player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true;
    download.hidden = true; download.removeAttribute('href');
    if (url) URL.revokeObjectURL(url); url = null;
  };
  const errors = {
    NotAllowedError: '麦克风权限被拒绝，请在浏览器网站设置中允许麦克风后重试。',
    NotFoundError: '未找到可用麦克风，请连接麦克风后重试。',
    NotReadableError: '麦克风无法使用，可能被其他程序占用或设备异常。',
    SecurityError: '浏览器禁止此页面使用麦克风，请检查网站权限。'
  };
  start.addEventListener('click', async () => {
    if (!supported || phase !== 'idle') return;
    phase = 'requesting'; const token = ++generation; render();
    message('正在申请麦克风权限，请处理浏览器弹窗。');
    let acquired;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      if (!stream.getAudioTracks().some(track => track.readyState !== 'ended')) throw Object.assign(new Error(), {name:'NotFoundError'});
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const active = recorder, chunks = []; let failed = false, total = 0;
      recorder.ondataavailable = event => {
        if (event.data.size) { chunks.push(event.data); total += event.data.size; }
        if (total > 8 * 1024 * 1024 && active.state === 'recording') { message('达到 8 MiB 上限，正在停止。'); phase = 'stopping'; render(); active.stop(); }
      };
      recorder.onerror = () => {
        if (token !== generation) return;
        failed = true; message('录音发生错误，请重新录制。'); release(); phase = 'idle'; recorder = null; render();
      };
      recorder.onstop = () => {
        if (token !== generation) return;
        release(); recorder = null; phase = 'idle'; render();
        if (failed) return;
        const blob = new Blob(chunks, { type: active.mimeType || chunks[0]?.type || 'audio/webm' });
        if (!blob.size || blob.size > 8 * 1024 * 1024) { message('录音为空或超过 8 MiB，请重新录制。'); return; }
        clearResult(); url = URL.createObjectURL(blob); player.src = url; player.hidden = false;
        download.href = url; download.download = 'microphone-test.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'); download.hidden = false;
        message('录音完成，可以试听或下载。格式：' + blob.type + '，大小：' + (blob.size / 1024).toFixed(1) + ' KiB。');
      };
      recorder.start(250);
      clearResult(); phase = 'recording'; const began = now(); timer.textContent = '0 秒';
      interval = setInterval(() => {
        const seconds = Math.floor((now() - began) / 1000); timer.textContent = seconds + ' 秒';
        if (seconds >= 60 && active.state === 'recording') { phase = 'stopping'; render(); message('已录满 60 秒，正在停止。'); active.stop(); }
      }, 200);
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (token === generation && active.state === 'recording') { phase = 'stopping'; render(); message('麦克风已断开，正在结束录音。'); active.stop(); }
      }));
      message('麦克风已连接，正在录音。最长 60 秒。'); render();
    } catch (error) {
      if (token !== generation) return;
      release(); recorder = null; phase = 'idle'; render(); message(errors[error.name] || '无法开始录音，请检查麦克风和浏览器支持。');
    }
  });
  stop.addEventListener('click', () => {
    if (phase === 'requesting') { generation++; phase = 'idle'; message('已取消此次申请；若浏览器弹窗仍在，请关闭弹窗。'); render(); }
    else if (phase === 'recording') { phase = 'stopping'; render(); message('正在生成录音…'); recorder.stop(); }
  });
  player.addEventListener('error', () => message('浏览器无法试听此录音，请下载检查或重新录制。'));
  window.addEventListener('pagehide', () => { generation++; if (recorder?.state === 'recording') recorder.stop(); release(); clearResult(); phase = 'idle'; render(); });
  window.addEventListener('beforeunload', event => { if (phase !== 'idle') { event.preventDefault(); event.returnValue = ''; } });
  timer.textContent = '0 秒'; render();
  message(supported ? '点击开始录音后申请麦克风权限；无需连接充电宝。' : '录音需要 HTTPS 或 localhost，以及支持麦克风录音的浏览器。');
}
