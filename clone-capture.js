// Microphone capture for "用我的声音生成". The blob is handed back only after a finished take.
export function createCloneCapture({
  getUserMedia, MediaRecorder, playChime, playEndChime = null, report, onBlob, onTick = () => {}, onPhase = () => {},
  setInterval, clearInterval, setTimeout, clearTimeout, maxMs = 20000, chimeMs = 3000
}) {
  let phase = 'idle', generation = 0, session = null, clock = null;
  const setPhase = next => { phase = next; onPhase(phase); };
  const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
  const clearClock = () => { if (clock !== null) clearInterval(clock); clock = null; };
  const drop = () => {
    const current = session;
    session = null;
    clearClock();
    current?.stopChime?.();
    stopTracks(current?.stream);
    return current;
  };

  const start = async () => {
    if (phase !== 'idle') return;
    const token = ++generation;
    setPhase('cue');
    let stream;
    try { stream = await getUserMedia(); }
    catch {
      if (token !== generation) return;
      setPhase('idle');
      report('无法使用麦克风。');
      return;
    }
    if (token !== generation) { stopTracks(stream); return; }
    const chime = playChime();
    session = { stream, stopChime: chime.stop, discard: false, failed: false, recorder: null };
    let timer;
    try {
      await Promise.race([
        chime.done,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), chimeMs); })
      ]);
    } catch {
      if (token !== generation) return;
      drop();
      setPhase('idle');
      report('提示音没有正常结束，录音已取消。');
      return;
    } finally { clearTimeout(timer); }
    if (token !== generation) { stopTracks(stream); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    let recorder;
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch {
      drop();
      setPhase('idle');
      report('无法开始录音。');
      return;
    }
    const chunks = [];
    session.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = () => {
      if (session) session.failed = true;
      report('录音失败，请重试。');
      if (recorder.state === 'recording') recorder.stop();
    };
    recorder.onstop = async () => {
      const discarded = token !== generation || session?.discard || session?.failed;
      drop();
      if (discarded) { setPhase('idle'); return; }
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (!blob.size) { setPhase('idle'); report('录音为空，请重试。'); return; }
      if (playEndChime) {
        setPhase('ending');
        const chime = playEndChime();
        session = { stopChime: chime.stop };
        let timer;
        try {
          await Promise.race([
            chime.done,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), chimeMs); })
          ]);
        } catch { /* A missed ending tone still keeps the recording. */ }
        finally { clearTimeout(timer); }
        if (token !== generation) return;
        session = null;
      }
      setPhase('idle');
      onBlob(blob);
    };
    try { recorder.start(250); }
    catch {
      session.discard = true;
      drop();
      setPhase('idle');
      report('无法开始录音。');
      return;
    }
    setPhase('recording');
    const began = Date.now();
    onTick(0);
    clock = setInterval(() => {
      const elapsed = Date.now() - began;
      onTick(Math.floor(elapsed / 1000));
      if (elapsed >= maxMs && recorder.state === 'recording') recorder.stop();
    }, 200);
    report('正在录音，可随时停止。');
  };

  const stop = () => {
    if (phase === 'cue') {
      generation++;
      if (session) session.discard = true;
      drop();
      setPhase('idle');
      report('已取消录音。');
      return;
    }
    if (phase === 'recording' && session?.recorder?.state === 'recording') session.recorder.stop();
  };

  const leave = () => {
    if (phase === 'idle') return;
    generation++;
    if (session) session.discard = true;
    const current = drop();
    if (current?.recorder?.state === 'recording') current.recorder.stop();
    else setPhase('idle');
  };

  return { start, stop, leave, phase: () => phase };
}
