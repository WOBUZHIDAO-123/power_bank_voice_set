import { CMD, TYPE, validateInfo } from './protocol.js';

export async function checkConnection(burner, { reconnect = false, report = () => {} } = {}) {
  if (reconnect) { await burner.status(); report('状态查询通过'); }
  const info = await burner.call(CMD.INFO, undefined, TYPE.INFO);
  const version = [info.firmware >>> 16, (info.firmware >>> 8) & 255, info.firmware & 255].join('.');
  report('设备信息查询通过，设备版本：' + version);
  if (!reconnect) { await burner.status(); report('状态查询通过'); }
  try { validateInfo(info); }
  catch (error) { throw new Error('查询通信已通过，但尚不支持该设备烧录（设备版本 ' + version + '）：' + error.message); }
  report('烧录兼容性检查通过');
  return info;
}
