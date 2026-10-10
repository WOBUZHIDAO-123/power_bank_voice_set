// Row recordings are local previews; no package bytes or device commands are modified.
export function createRowRecording({ document, window, navigator, URL, report, onBusy = () => {} }) {
  const clips = new Map(), views = new Map();
  const player = document.createElement('audio');
  let active = null, generation = 0, current = null, interval = null;
  const update = id => {
    const view = views.get(id); if (!view) return;
    const clip = clips.get(id), capturing = active?.id === id;
    view.record.textContent = capturing ? active.phase === 'requesting' ? '取消申请' : active.phase === 'stopping' ? '结束中…' : '■ 正在录音' : '● 录音';
    view.record.classList.toggle('recording', capturing);
    view.progress.hidden = !capturing && !clip;
    view.progress.disabled = capturing;
    const seconds = capturing ? Math.floor((Date.now() - active.began) / 1000) : clip?.duration ?? 0;
    const elapsed = !capturing && current === id ? player.currentTime || 0 : 0;
    view.caption.textContent = capturing ? active.phase === 'requesting' ? '等待授权' : seconds + ' 秒 / 60 秒' : (current === id && !player.paused ? '暂停 ' : '▶ ') + Math.floor(elapsed) + ' / ' + Math.floor(seconds) + ' 秒';
    view.bar.value = capturing ? seconds / 60 * 100 : seconds ? elapsed / seconds * 100 : 0;
  };
  const release = session => {
    if (interval !== null) window.clearInterval(interval); interval = null;
    session?.stream?.getTracks().forEach(track => track.stop());
  };
  const pause = () => { player.pause(); if (current !== null) update(current); };
  const reset = () => {
    generation++; const session = active; active = null;
    if (session?.recorder?.state === 'recording') session.recorder.stop();
    release(session); pause(); player.removeAttribute('src'); player.load();
    for (const clip of clips.values()) URL.revokeObjectURL(clip.url);
    clips.clear(); current = null; onBusy(false);
  };
  const record = async id => {
    if (active) {
      if (active.id !== id) { report('请先结束当前录音。'); return; }
      if (active.phase === 'requesting') { const session = active; generation++; active = null; release(session); onBusy(false); update(id); report('已取消申请。'); }
      else if (active.phase === 'recording') { active.phase = 'stopping'; update(id); active.recorder.stop(); }
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { report('此浏览器不支持麦克风录音，请使用 HTTPS 或 localhost。'); return; }
    pause(); const token = ++generation;
    const session = {id, phase:'requesting', began:Date.now(), stream:null, recorder:null}; active = session; onBusy(true); update(id);
    report('请允许麦克风访问。');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      if (token !== generation) {stream.getTracks().forEach(track => track.stop()); return;}
      session.stream = stream;
      const MR = window.MediaRecorder;
      const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(type => MR.isTypeSupported(type));
      const recorder = new MR(stream, mime ? {mimeType:mime} : undefined); session.recorder = recorder;
      let failed = false, size = 0; const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) {chunks.push(event.data); size += event.data.size;} if (size > 8*1024*1024 && recorder.state === 'recording') recorder.stop(); };
      recorder.onerror = () => {failed = true; report('录音失败，请重试。'); if (recorder.state === 'recording') recorder.stop(); else { release(session); active = null; onBusy(false); update(id); }};
      recorder.onstop = () => {
        if (token !== generation) return;
        const duration = (Date.now()-session.began)/1000;
        release(session); active = null; onBusy(false);
        const blob = new Blob(chunks,{type:recorder.mimeType || chunks[0]?.type || 'audio/webm'});
        if (!failed && blob.size && blob.size <= 8*1024*1024) {
          if (clips.has(id)) URL.revokeObjectURL(clips.get(id).url);
          clips.set(id,{url:URL.createObjectURL(blob),duration});
          report('录音完成，点击进度条试听。当前录音仅供试听，未替换烧录资源。');
        } else if (!failed) report('录音为空或超过 8 MiB，请重试。');
        update(id);
      };
      recorder.start(250); session.phase = 'recording'; session.began = Date.now(); update(id);
      interval = window.setInterval(() => { update(id); if (Date.now()-session.began >= 60000 && recorder.state === 'recording') {session.phase='stopping'; recorder.stop();} },200);
      stream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>{if(token===generation && recorder.state==='recording')recorder.stop();}));
      report('正在录音，再次点击录音按钮结束。');
    } catch (error) {
      if (token !== generation) return;
      release(session); active = null; onBusy(false); update(id);
      report(({NotAllowedError:'麦克风权限被拒绝，请在网站设置中允许。',NotFoundError:'没有可用麦克风。',NotReadableError:'麦克风被占用或无法使用。'})[error.name] || '无法开始录音。');
    }
  };
  const play = async id => {
    if (active || !clips.has(id)) return;
    if (current === id && !player.paused) {pause(); return;}
    pause(); if (current !== id) {player.src = clips.get(id).url; current = id;}
    try {await player.play(); update(id);} catch {report('录音暂时无法试听。');}
  };
  player.addEventListener('timeupdate',()=>{if(current!==null)update(current);});
  player.addEventListener('ended',()=>{if(current!==null)update(current);});
  player.addEventListener('error',()=>report('录音暂时无法试听。'));
  window.addEventListener('pagehide',reset);
  window.addEventListener('beforeunload',event=>{if(active){event.preventDefault();event.returnValue='';}});
  return { reset, pause, isBusy:()=>Boolean(active), mount(id, view){views.set(id,view); view.record.addEventListener('click',()=>record(id)); view.progress.addEventListener('click',()=>play(id)); update(id);}, clearViews(){views.clear();} };
}
