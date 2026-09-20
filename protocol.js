import { crc32, decodeLanguage } from './binary.js';
import { validateTable, verifyTableInfo } from './voice-table.js';
import { checkCancelled } from './zip.js';
export { crc32 } from './binary.js';
export const MAX_IMAGE_SIZE = 0x800000;
export const TARGET = { NONE: 0, IMAGE: 1, TABLE: 2 };
export const CMD={INFO:1,START:2,STATUS:3,DATA:4,FINISH:5,ABORT:6,TABLE_START:7,TABLE_DATA:8,TABLE_FINISH:9,TABLE_INFO:10,VOICE_PLAY_EVENT:11,VOICE_QUEUE:12,VOICE_CONTROL:13};
export const TYPE={ACK:128,NACK:129,INFO:130,STATUS:131,TABLE_INFO:132};
export const STATE={IDLE:0,ERASING:1,READY:2,WRITING:3,VERIFYING:4,SUCCESS:5,ERROR:6,ABORT:7};
const errors=['无错误','协议版本不匹配','通信长度错误','通信校验失败','设备不支持此命令','设备状态不允许此操作','镜像不符合要求','数据块顺序错误','硬件语音存储未就绪','存储清理失败','存储写入失败','写入内容检查失败','设备接收溢出','播放表格式或内容不合法','硬件播放表存储未就绪','播放表准备或写入失败','播放表检查或提交失败','设备尚无有效播放表','播放表中没有此事件或数值','硬件播放串口发送失败','播放队列或音频编号无效（1～255）'];
export class DeviceError extends Error{constructor(code,expected){super(errors[code]??`设备错误 ${code}`);this.code=code;this.expected=expected;}}
export function frame(type,seq,payload=new Uint8Array()){const b=new Uint8Array(15+payload.length),v=new DataView(b.buffer);b.set([0x55,0xaa,1,type,0]);v.setUint32(5,seq,true);v.setUint16(9,payload.length,true);b.set(payload,11);v.setUint32(11+payload.length,crc32(b.subarray(2,11+payload.length)),true);return b;}
export class Decoder{
 constructor(){this.buffer=new Uint8Array();}
 push(bytes){const merged=new Uint8Array(this.buffer.length+bytes.length);merged.set(this.buffer);merged.set(bytes,this.buffer.length);this.buffer=merged;const out=[];
 while(this.buffer.length>=2){const b=this.buffer;if(b[0]!==85||b[1]!==170){this.buffer=b.slice(1);continue;}if(b.length<11)break;const v=new DataView(b.buffer,b.byteOffset,b.byteLength),len=v.getUint16(9,true);if(b[2]!==1||b[4]!==0||len>1024){this.buffer=b.slice(1);continue;}if(b.length<len+15)break;if(v.getUint32(11+len,true)!==crc32(b.subarray(2,11+len))){this.buffer=b.slice(1);continue;}out.push({type:b[3],seq:v.getUint32(5,true),payload:b.slice(11,11+len)});this.buffer=b.slice(15+len);}
 return out;}
}
export function parseResponse(f){const lengths={[TYPE.ACK]:9,[TYPE.NACK]:5,[TYPE.INFO]:16,[TYPE.STATUS]:16,[TYPE.TABLE_INFO]:36};if(f.payload.length!==lengths[f.type])throw new Error('设备响应长度不符合协议');const v=new DataView(f.payload.buffer,f.payload.byteOffset,f.payload.byteLength);
 if(f.type===TYPE.NACK)throw new DeviceError(v.getUint8(0),v.getUint32(1,true));
 if(f.type===TYPE.ACK){if(v.getUint8(0)>2)throw new Error('设备确认对象无效');return {target:v.getUint8(0),expected:v.getUint32(1,true),completed:v.getUint32(5,true)};}
 if(f.type===TYPE.INFO)return {version:v.getUint8(0),state:v.getUint8(1),chunk:v.getUint16(2,true),capacity:v.getUint32(4,true),addressBytes:v.getUint8(8),capabilities:v.getUint8(9),tableMaxSize:v.getUint16(10,true),firmware:v.getUint32(12,true)};
 if(f.type===TYPE.TABLE_INFO){const length=v.getUint8(2);if(length>16||v.getUint8(0)>1||v.getUint16(18,true)!==0)throw new Error('播放表摘要格式无效');return {valid:v.getUint8(0),format:v.getUint8(1),maxSequenceLength:v.getUint8(3),size:v.getUint32(4,true),crc:v.getUint32(8,true),imageCRC:v.getUint32(12,true),entryCount:v.getUint16(16,true),languageTag:length?decodeLanguage(f.payload.subarray(20,20+length)):''};}
 if(v.getUint8(0)>7||v.getUint8(2)>2||v.getUint8(3)!==0)throw new Error('设备状态响应无效');
 return {state:v.getUint8(0),error:v.getUint8(1),target:v.getUint8(2),expected:v.getUint32(4,true),completed:v.getUint32(8,true),size:v.getUint32(12,true)};
}
export function validateInfo(info){if(info.version!==1||info.chunk!==1024||info.addressBytes!==3||info.capacity!==MAX_IMAGE_SIZE||info.firmware!==0x10300||info.state>7)throw new Error('设备协议或容量不兼容，需要 1.3.0、8 MiB 设备');const names=['音频镜像更新','可变镜像长度','播放表更新','播放表摘要查询'];const missing=names.filter((name,bit)=>!(info.capabilities&(1<<bit)));if(missing.length)throw new Error(`设备缺少必要功能：${missing.join('、')}`);if(!Number.isInteger(info.tableMaxSize)||info.tableMaxSize<48||info.tableMaxSize>4096)throw new Error('设备播放表容量无效');return info;}
export function validateImage(bytes,capacity=MAX_IMAGE_SIZE){const n=bytes.length;if(n<512||n>Math.min(capacity,MAX_IMAGE_SIZE)||n%512)throw new Error('镜像大小必须为 512 字节的整数倍，且不超过 8 MiB 和设备容量');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const sector=v.getUint16(11,true),cluster=v.getUint8(13),reserved=v.getUint16(14,true),fats=v.getUint8(16),roots=v.getUint16(17,true),small=v.getUint16(19,true),large=v.getUint32(32,true),fatSize=v.getUint16(22,true);const total=small||large;
 if(bytes[510]!==85||bytes[511]!==170||![512,1024,2048,4096].includes(sector)||!cluster||(cluster&(cluster-1))||cluster>128||!reserved||!fats||!roots||!fatSize||(small&&large)||total*sector!==n)throw new Error('镜像必须是完整 FAT12/FAT16 卷，卷大小必须与文件一致');const dataSectors=total-reserved-fats*fatSize-Math.ceil(roots*32/sector);const clusters=Math.floor(dataSectors/cluster);if(clusters<1||clusters>=65525||fatSize*sector<Math.ceil((clusters+2)*(clusters<4085?1.5:2)))throw new Error('镜像 FAT 布局无效或不是 FAT12/FAT16');return crc32(bytes);}
export class SerialLink {
  constructor(port, { timeout = 2000 } = {}) {
    this.port = port;
    this.timeout = timeout;
    this.decoder = new Decoder();
    this.pending = null;
    this.closed = false;
  }

  async open() {
    await this.port.open({ baudRate: 115200 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const response of this.decoder.push(value)) {
          const pending = this.pending;
          if (pending && response.seq === pending.seq &&
              (response.type === pending.response || response.type === TYPE.NACK)) {
            pending.resolve(response);
          }
        }
      }
    } catch (error) {
      this.readError = error;
    } finally {
      this.closed = true;
      this.pending?.reject(new Error('设备连接已断开，请重新连接后完整烧录'));
      this.onDisconnect?.();
    }
  }

  async request(type, payload = new Uint8Array(), seq = 0, response = TYPE.ACK, { signal } = {}) {
    checkCancelled(signal);
    if (this.closed) throw new Error('设备已断开，请重新连接');
    if (this.pending) throw new Error('通信请求尚未结束');
    const bytes = frame(type, seq, payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancelled(signal);
      let timer;
      try {
        const reply = await new Promise((resolve, reject) => {
          this.pending = { seq, response, resolve, reject };
          timer = setTimeout(() => {
            const error = new Error('设备响应超时');
            error.timeout = true;
            reject(error);
          }, this.timeout);
          this.writer.write(bytes).catch(reject);
        });
        return parseResponse(reply);
      } catch (error) {
        // 1.3.0 only guarantees DATA replay. Observe state instead of restarting a task.
        if (error.timeout && [CMD.VOICE_PLAY_EVENT, CMD.VOICE_QUEUE, CMD.VOICE_CONTROL].includes(type)) {
          error.message = '播放命令响应超时，设备可能已接收；未自动重发，请确认设备状态';
          throw error;
        }
        if (error.timeout && [CMD.START, CMD.TABLE_START, CMD.FINISH, CMD.TABLE_FINISH].includes(type)) throw error;
        const retryCRC = error instanceof DeviceError && error.code === 3 &&
          ![CMD.DATA, CMD.TABLE_DATA].includes(type);
        if ((!error.timeout && !retryCRC) || attempt === 1) throw error;
      } finally {
        clearTimeout(timer);
        this.pending = null;
      }
    }
  }

  async close() {
    this.closed = true;
    this.pending?.reject(new Error('设备连接已关闭'));
    try {
      await this.reader?.cancel();
      await this.readTask;
    } catch { /* A disconnected stream may already be errored. */ }
    this.reader?.releaseLock();
    try { await this.writer?.abort(); } catch { /* Release even after unplug. */ }
    this.writer?.releaseLock();
    try { await this.port.close(); } catch { /* The OS may have removed the port. */ }
  }
}

export class Burner {
  constructor(link, { pollMs = 300, phaseTimeout = 90000, onProgress = () => {} } = {}) {
    this.link = link;
    this.pollMs = pollMs;
    this.phaseTimeout = phaseTimeout;
    this.onProgress = onProgress;
    // Control requests cannot collide with DATA block numbers (0..8191).
    this.seq = 0x80000000;
  }

  call(type, payload, response = TYPE.ACK) {
    return this.request(type, payload, this.seq++ >>> 0, response);
  }

  async request(type, payload, seq, response = TYPE.ACK) {
    checkCancelled(this.signal);
    const reply = await this.link.request(type, payload, seq, response, { signal: this.signal });
    checkCancelled(this.signal);
    return reply;
  }

  async info() {
    return validateInfo(await this.call(CMD.INFO, undefined, TYPE.INFO));
  }

  async status() {
    return this.call(CMD.STATUS, undefined, TYPE.STATUS);
  }


  async voiceCommand(type, payload) {
    if (this.running) throw new Error('设备操作进行中，请等待结束');
    this.running = true;
    try {
      await this.info();
      const status = await this.status();
      if ([STATE.ERASING, STATE.READY, STATE.WRITING, STATE.VERIFYING].includes(status.state)) {
        throw new Error('设备正在更新语音，暂不能发送播放命令');
      }
      return await this.call(type, payload);
    } finally { this.running = false; }
  }

  playEvent(event, value) {
    if (!Number.isInteger(event) || event < 0 || event > 65535 ||
        !Number.isInteger(value) || value < -32768 || value > 32767) throw new Error('事件或数值超出范围');
    const payload = new Uint8Array(4), view = new DataView(payload.buffer);
    view.setUint16(0, event, true); view.setInt16(2, value, true);
    return this.voiceCommand(CMD.VOICE_PLAY_EVENT, payload);
  }

  queueVoice(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 ||
        ids.some(id => !Number.isInteger(id) || id < 1 || id > 255)) throw new Error('队列需要 1～8 个音频编号，每个编号为 1～255');
    const payload = new Uint8Array(1 + ids.length * 2), view = new DataView(payload.buffer);
    payload[0] = ids.length;
    ids.forEach((id, i) => view.setUint16(1 + i * 2, id, true));
    return this.voiceCommand(CMD.VOICE_QUEUE, payload);
  }

  controlVoice(action) {
    if (![0, 1, 2].includes(action)) throw new Error('播放控制动作无效');
    return this.voiceCommand(CMD.VOICE_CONTROL, new Uint8Array([action]));
  }

  checkTarget(reply, target) {
    if (reply.target !== target) throw new Error('设备响应对象不匹配，请重新完整烧录');
    return reply;
  }

  async startBackground(type, payload, target) {
    try { this.checkTarget(await this.call(type, payload), target); }
    catch (error) {
      checkCancelled(this.signal);
      if (!error.timeout) throw error;
      // The ACK may be lost: the following status poll proves whether the task started.
    }
  }

  async wait(state, allowed, target) {
    const end = Date.now() + this.phaseTimeout;
    while (Date.now() < end) {
      checkCancelled(this.signal);
      const status = this.checkTarget(await this.status(), target);
      if (status.error || status.state === STATE.ERROR) throw new DeviceError(status.error || 11);
      if (status.state === state) return status;
      if (!allowed.includes(status.state)) throw new Error('设备状态异常，请重新完整烧录');
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
    throw new Error('设备处理超时，请重新连接后完整烧录');
  }

  async burnImage(bytes, options = {}) {
    return this.burn(bytes, null, null, { ...options, imageOnly: true });
  }

  async burn(bytes, tableBytes, selectedLanguage, { signal, imageOnly = false } = {}) {
    if (this.running) throw new Error('正在烧录，请等待当前操作结束');
    this.running = true;
    this.signal = signal;
    this.touched = false;
    try {
      return await this.burnResources(bytes, tableBytes, selectedLanguage, imageOnly);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') {
        let message = this.touched ? '已取消，原语音可能已被覆盖，需要重新完整烧录' : '已取消，尚未开始写入设备';
        if (this.touched) {
          if (this.link.closed) message = '已停止发送，设备已断开，无法确认中止；请重连后完整烧录';
          else {
            try {
              // Current command has settled; do not send ABORT concurrently with it.
              await this.link.request(CMD.ABORT, undefined, this.seq++ >>> 0);
              const status = await this.link.request(CMD.STATUS, undefined, this.seq++ >>> 0, TYPE.STATUS);
              if (status.state !== STATE.ABORT) throw new Error('设备未确认中止');
            } catch { message = '已停止发送，但设备未确认中止；请重新连接后完整烧录'; }
          }
        }
        const cancelled = new Error(message); cancelled.name = 'AbortError'; throw cancelled;
      }
      throw error;
    } finally { this.running = false; this.signal = undefined; }
  }

  async burnResources(bytes, tableBytes, selectedLanguage, imageOnly = false) {
    this.onProgress('准备文件', 0);
    const info = await this.info();
    const crc = validateImage(bytes, info.capacity);
    const table = imageOnly ? null : validateTable(tableBytes, crc, selectedLanguage, info.tableMaxSize);
    // Both resources are checked before any destructive command.
    const previous = await this.status();
    if (![STATE.IDLE, STATE.ABORT].includes(previous.state)) {
      await this.call(CMD.ABORT);
      if ((await this.status()).state !== STATE.ABORT) throw new Error('设备旧会话未清理完成');
    }
    await this.transfer(bytes, crc, TARGET.IMAGE);
    if (imageOnly) return true;
    try {
      // TABLE_START follows image SUCCESS directly, as specified by 1.3.0.
      await this.transfer(tableBytes, table.crc, TARGET.TABLE, crc);
    } catch (error) {
      if (error.name === 'AbortError' || this.signal?.aborted) throw error;
      throw new Error(`语音已写入，但播放规则未完成：${error.message}。请重新完整烧录`, { cause: error });
    }
    this.onProgress('最终核对', 0);
    const summary = await this.call(CMD.TABLE_INFO, undefined, TYPE.TABLE_INFO);
    verifyTableInfo(summary, table);
    return true;
  }

  async transfer(bytes, crc, target, imageCRC) {
    const isTable = target === TARGET.TABLE;
    const start = isTable ? CMD.TABLE_START : CMD.START;
    const data = isTable ? CMD.TABLE_DATA : CMD.DATA;
    const finishCommand = isTable ? CMD.TABLE_FINISH : CMD.FINISH;
    const payload = new Uint8Array(isTable ? 16 : 12);
    const view = new DataView(payload.buffer);
    view.setUint32(0, bytes.length, true);
    view.setUint32(4, crc, true);
    if (isTable) {
      view.setUint32(8, imageCRC, true);
      view.setUint16(12, 1, true);
      view.setUint16(14, 1024, true);
    } else {
      view.setUint16(8, 1024, true);
    }
    this.onProgress(isTable ? '准备播放规则' : '清理语音存储', 0);
    checkCancelled(this.signal);
    this.touched = true;
    await this.startBackground(start, payload, target);
    const ready = await this.wait(STATE.READY, [STATE.ERASING], target);
    if (ready.expected !== 0 || ready.completed !== 0 || ready.size !== bytes.length) {
      throw new Error('设备准备状态与本次资源不一致');
    }

    const blocks = Math.ceil(bytes.length / 1024);
    const retries = new Map();
    let index = 0;
    while (index < blocks) {
      try {
        const end = Math.min(bytes.length, (index + 1) * 1024);
        const ack = this.checkTarget(await this.request(data, bytes.subarray(index * 1024, end), index), target);
        if (ack.expected !== index + 1 || ack.completed !== end) {
          throw new Error('设备写入进度不符合预期');
        }
        index++;
        this.onProgress(isTable ? '写入播放规则' : '写入语音', ack.completed / bytes.length * 100);
      } catch (error) {
        if (!(error instanceof DeviceError) || ![3, 7].includes(error.code)) throw error;
        const count = (retries.get(index) || 0) + 1;
        retries.set(index, count);
        if (count >= 2 || !Number.isInteger(error.expected) || error.expected > index || error.expected < 0 || error.expected >= blocks) {
          throw error;
        }
        index = error.expected;
      }
    }

    const finish = new Uint8Array(4);
    new DataView(finish.buffer).setUint32(0, crc, true);
    this.onProgress(isTable ? '检查播放规则' : '检查语音', 0);
    await this.startBackground(finishCommand, finish, target);
    const status = await this.wait(STATE.SUCCESS, [STATE.VERIFYING], target);
    if (status.completed !== bytes.length || status.size !== bytes.length || status.expected !== blocks) {
      throw new Error('设备最终写入进度不完整');
    }
    return true;
  }
}
