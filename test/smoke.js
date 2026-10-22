#!/usr/bin/env node
'use strict';

/**
 * 端到端冒烟测试：不依赖浏览器，直接跑一遍真实接口。
 *   node test/smoke.js
 *
 * 覆盖：新建会话 → 扫码识别码加入 → 一传一 → 一传多 → 下载完整性 → 进度事件
 */

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSSE(chunk) {
  const lines = chunk.split('\n');
  let event = 'message';
  const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

async function openSSE(code, clientId) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?code=${code}&client=${clientId}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = parseSSE(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (ev) events.push(ev);
        }
      }
    } catch {}
  })();

  return {
    events,
    close: () => ctrl.abort(),
    async waitFor(event, predicate = () => true, timeout = 8000) {
      const start = Date.now();
      for (;;) {
        const hit = events.find((e) => e.event === event && predicate(e.data));
        if (hit) return hit.data;
        if (Date.now() - start > timeout) throw new Error(`等待事件超时: ${event}`);
        await sleep(25);
      }
    },
  };
}

async function postJson(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  const server = spawn(process.execPath, ['server-mode/server.js', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  const cleanup = () => {
    try {
      server.kill();
    } catch {}
  };
  process.on('exit', cleanup);

  // 等服务器起来
  for (let i = 0; i < 80; i++) {
    try {
      const info = await fetch(`${BASE}/api/info`).then((r) => r.json());
      if (info.port === PORT) break;
    } catch {}
    await sleep(100);
  }

  console.log('1. 新建会话');
  const host = await postJson('/api/room/create', { name: '发送端 · PC' });
  assert.match(host.code, /^\d{4}$/, '识别码应为 4 位数字');
  const hostSSE = await openSSE(host.code, host.clientId);
  await hostSSE.waitFor('state');
  console.log(`   ✓ 识别码 ${host.code}`);

  console.log('2. 三台设备用识别码加入（一传多）');
  const peers = [];
  for (const name of ['手机 A', '手机 B', '平板 C']) {
    const p = await postJson('/api/room/join', { code: host.code, name });
    p.sse = await openSSE(host.code, p.clientId);
    await p.sse.waitFor('state');
    peers.push(p);
  }
  await hostSSE.waitFor('peers', (p) => p.length === 4);
  console.log(`   ✓ 在线设备 4 台`);

  console.log('3. 一传多上传 6MB 文件');
  const payload = crypto.randomBytes(6 * 1024 * 1024);
  const name = '测试 视频.mp4';
  const query = new URLSearchParams({
    code: host.code,
    client: host.clientId,
    name,
    size: String(payload.length),
    target: 'all',
  });
  const up = await fetch(`${BASE}/api/upload?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: payload,
  }).then((r) => r.json());
  assert.ok(up.ok, '上传应成功');
  assert.strictEqual(up.receivers, 3, '应有 3 个接收方');
  console.log(`   ✓ 上传完成，接收方 ${up.receivers} 台`);

  console.log('4. 三台设备都收到通知并下载，校验完整性');
  for (const p of peers) {
    const added = await p.sse.waitFor('file-added', (f) => f.file.name === name);
    assert.strictEqual(added.file.size, payload.length, '文件大小应一致');

    const dl = await fetch(`${BASE}/api/download/${added.file.id}?client=${p.clientId}`);
    assert.strictEqual(dl.status, 200, '下载应返回 200');
    assert.match(dl.headers.get('content-disposition') || '', /attachment/, '应作为附件下载');
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(buf.length, payload.length, '下载长度应一致');
    assert.ok(buf.equals(payload), '内容应完全一致');

    const prog = await p.sse.waitFor('download-progress', (d) => d.done);
    assert.strictEqual(Math.round(prog.percent), 100, '进度应到 100%');
  }
  console.log('   ✓ 3 台设备下载内容逐字节一致，进度事件正常');

  console.log('5. 定向发送（一传一）');
  const one = peers[0];
  const q2 = new URLSearchParams({
    code: host.code,
    client: host.clientId,
    name: 'one-to-one.txt',
    size: '11',
    target: one.clientId,
  });
  const up2 = await fetch(`${BASE}/api/upload?${q2}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: Buffer.from('hello world'),
  }).then((r) => r.json());
  assert.strictEqual(up2.receivers, 1, '定向发送只应有 1 个接收方');
  await one.sse.waitFor('file-added', (f) => f.file.name === 'one-to-one.txt');

  const other = peers[1];
  const forbidden = await fetch(`${BASE}/api/download/${up2.file.id}?client=${other.clientId}`);
  assert.strictEqual(forbidden.status, 403, '非目标设备不应能下载');
  console.log('   ✓ 定向文件只有目标设备可见（其他设备 403）');

  console.log('6. 识别码错误应被拒绝');
  const bad = await fetch(`${BASE}/api/room/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '0001', name: 'x' }),
  });
  assert.strictEqual(bad.status, 404, '错误识别码应 404');
  console.log('   ✓ 错误识别码返回 404');

  console.log('7. 退出会话');
  await postJson('/api/leave', { code: host.code, client: peers[2].clientId });
  await hostSSE.waitFor('peers', (p) => p.length === 3, 5000);
  console.log('   ✓ 设备离开后在线列表更新');

  hostSSE.close();
  peers.forEach((p) => p.sse.close());
  console.log('\n全部通过 ✅');
  cleanup();
  process.exit(0);
})().catch((err) => {
  console.error('\n测试失败 ❌');
  console.error(err);
  try {
    server.kill();
  } catch {}
  process.exit(1);
});
