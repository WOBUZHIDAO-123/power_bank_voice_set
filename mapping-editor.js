import { allEventKeys, createVoiceMapping } from './voice-mapping.js';
import { compilePackage } from './voice-package.js';

const download = (filename, bytes, type) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

export function mountMappingEditor({ document, getPrepared, usePackage, stopAudio, getBusy }) {
  const $ = id => document.getElementById(id);
  const mapping = createVoiceMapping();
  const player = document.createElement('audio');
  let filter = '全部';
  const status = message => { $('mapping-status').textContent = message; };
  const guard = () => {
    if (getBusy()) { status('请等待当前操作结束。'); return true; }
    return false;
  };

  const render = () => {
    const clipList = $('mapping-clips');
    clipList.replaceChildren();
    for (const clip of mapping.clips) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mapping-clip';
      row.textContent = String(clip.fileId).padStart(3, '0') + '  ' + clip.text;
      row.addEventListener('click', () => playIds([clip.fileId]));
      clipList.append(row);
    }
    const events = $('mapping-events');
    events.replaceChildren();
    for (const [eventId, value] of allEventKeys()) {
      const event = mapping.events.get(eventId + ':' + value);
      if (!event) continue;
      if (filter === '缺失' && event.status !== 'missing') continue;
      if (filter === '自动' && event.status !== 'auto') continue;
      if (filter === '手动' && event.status !== 'manual') continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mapping-event ' + event.status;
      const id = document.createElement('span'); id.textContent = '0x' + eventId.toString(16).padStart(4, '0');
      const number = document.createElement('span'); number.textContent = String(value);
      const name = document.createElement('span'); name.textContent = mapping.eventName(eventId);
      const state = document.createElement('span'); state.textContent = mapping.statusLabel(event.status);
      const sequence = document.createElement('span'); sequence.textContent = mapping.sequenceText(event);
      row.append(id, number, name, state, sequence);
      row.addEventListener('click', () => openEditor(event));
      events.append(row);
    }
    const counts = mapping.counts();
    $('mapping-summary').textContent = mapping.events.size ? '总计 ' + counts.total + '，自动 ' + counts.auto + '，手动 ' + counts.manual + '，缺失 ' + counts.missing : '';
  };

  const playIds = async ids => {
    stopAudio();
    for (const fileId of ids) {
      const clip = mapping.clip(fileId);
      if (!clip) return;
      const url = URL.createObjectURL(new Blob([clip.bytes], { type: 'audio/mpeg' }));
      player.src = url;
      try {
        await player.play();
        await new Promise((resolve, reject) => {
          player.addEventListener('ended', resolve, { once: true });
          player.addEventListener('error', () => reject(new Error('试听失败')), { once: true });
        });
      } catch { URL.revokeObjectURL(url); status('这组音频暂时无法试听。'); return; }
      URL.revokeObjectURL(url);
    }
  };

  const dialog = $('mapping-dialog');
  const openEditor = event => {
    if (guard()) return;
    const sequence = [...event.sequence];
    $('mapping-dialog-title').textContent = '0x' + event.eventId.toString(16).padStart(4, '0') + '  ' + mapping.eventName(event.eventId) + '  value=' + event.value;
    const available = $('mapping-available'), chosen = $('mapping-sequence');
    const renderSequence = () => {
      chosen.replaceChildren();
      sequence.forEach((fileId, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        const clip = mapping.clip(fileId);
        option.textContent = String(fileId).padStart(3, '0') + ' | ' + (clip?.text || '缺失');
        chosen.append(option);
      });
    };
    available.replaceChildren();
    mapping.clips.forEach((clip, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = String(clip.fileId).padStart(3, '0') + ' | ' + clip.text;
      available.append(option);
    });
    renderSequence();
    $('mapping-add').onclick = () => {
      const index = available.selectedIndex;
      if (index < 0 || sequence.length >= 8) return;
      sequence.push(mapping.clips[index].fileId);
      renderSequence();
    };
    $('mapping-remove').onclick = () => {
      const index = chosen.selectedIndex;
      if (index >= 0) { sequence.splice(index, 1); renderSequence(); }
    };
    const move = delta => {
      const index = chosen.selectedIndex;
      const next = index + delta;
      if (index < 0 || next < 0 || next >= sequence.length) return;
      [sequence[index], sequence[next]] = [sequence[next], sequence[index]];
      renderSequence();
      chosen.selectedIndex = next;
    };
    $('mapping-up').onclick = () => move(-1);
    $('mapping-down').onclick = () => move(1);
    $('mapping-preview').onclick = () => playIds(sequence);
    $('mapping-save-sequence').onclick = () => {
      try { mapping.setManual(event.eventId, event.value, sequence); dialog.close(); render(); status('已保存手动组合。'); }
      catch (error) { status(error.message); }
    };
    $('mapping-reset-sequence').onclick = () => {
      try { mapping.clearManual(event.eventId, event.value); dialog.close(); render(); status('已恢复自动组合。'); }
      catch (error) { status(error.message); }
    };
    dialog.showModal();
  };

  const readAudio = async fileList => {
    const files = [];
    for (const file of fileList) {
      if (!/\.mp3$/i.test(file.name)) continue;
      files.push({ name: file.webkitRelativePath || file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    mapping.language = $('mapping-language').value.trim() || 'zh-CN';
    mapping.loadFiles(files);
    mapping.autoGenerate();
    render();
    status('已加载 ' + mapping.clips.length + ' 个音频');
  };

  $('mapping-audio').addEventListener('change', async () => {
    if (guard()) return;
    const files = [...$('mapping-audio').files];
    $('mapping-audio').value = '';
    if (!files.length) return;
    try { await readAudio(files); }
    catch (error) { status(error.message); }
  });
  $('mapping-from-package').addEventListener('click', () => {
    if (guard()) return;
    const prepared = getPrepared();
    const source = prepared?.editable;
    if (!source?.files?.length) { status('请先加载带 voice.json 的完整语音包。'); return; }
    try {
      mapping.language = prepared.languageTag || $('mapping-language').value.trim() || 'zh-CN';
      $('mapping-language').value = mapping.language;
      mapping.loadAssigned(source.files.map(file => ({ fileId: file.id, text: file.text, bytes: file.bytes, name: file.path?.split('/').at(-1) })));
      mapping.adoptEntries(source.entries);
      render();
      status('已从当前语音包载入 ' + mapping.clips.length + ' 个音频');
    } catch (error) { status(error.message); }
  });
  $('mapping-regenerate').addEventListener('click', () => {
    if (guard()) return;
    try { mapping.language = $('mapping-language').value.trim() || 'zh-CN'; mapping.autoGenerate(); render(); status('已重新自动组合。手动组合仍保留。'); }
    catch (error) { status(error.message); }
  });
  $('mapping-filter').addEventListener('change', () => { filter = $('mapping-filter').value; render(); });
  $('mapping-save').addEventListener('click', () => {
    if (!mapping.clips.length) { status('请先加载音频。'); return; }
    mapping.language = $('mapping-language').value.trim() || 'zh-CN';
    download('voice-mapping.json', new TextEncoder().encode(JSON.stringify(mapping.mappingDocument(), null, 2)), 'application/json');
    status('映射文件已下载。');
  });
  $('mapping-load').addEventListener('change', async () => {
    const file = $('mapping-load').files?.[0];
    $('mapping-load').value = '';
    if (!file || guard()) return;
    try {
      mapping.applyMapping(JSON.parse(await file.text()));
      $('mapping-language').value = mapping.language;
      render();
      status('映射已加载。');
    } catch (error) { status(error.message); }
  });
  const buildZip = () => {
    mapping.language = $('mapping-language').value.trim() || 'zh-CN';
    return mapping.exportZip($('mapping-incomplete').checked);
  };
  $('mapping-export').addEventListener('click', async () => {
    if (guard()) return;
    try {
      const bytes = buildZip();
      await compilePackage(bytes, mapping.language);
      download('voice-package.zip', bytes, 'application/zip');
      status('ZIP 已下载，并通过语音包检查。');
    } catch (error) { status(error.message); }
  });
  $('mapping-burn').addEventListener('click', async () => {
    if (guard()) return;
    try { await usePackage(buildZip(), mapping.language); }
    catch (error) { status(error.message); }
  });
  $('mapping-cancel').addEventListener('click', () => dialog.close());
}
