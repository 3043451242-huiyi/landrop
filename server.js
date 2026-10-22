#!/usr/bin/env node
'use strict';

/**
 * 局域快传 · LanDrop
 * 零依赖的局域网文件传输服务端：
 *  - 提供静态页面（public）
 *  - 4 位识别码会话（1 个房间 = N 台设备，天然支持一传一 / 一传多）
 *  - 文件只在本机与局域网内流动，不经过任何外网服务器
 *  - SSE 推送在线设备、传输进度、下行速度
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const qrcode = require(path.join(PUBLIC_DIR, 'vendor', 'qrcode.js'));

/* ------------------------------------------------------------------ *
 * 启动参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : fallback;
}

const PORT = Number(argValue('--port', process.env.PORT || 5178));
const HOST = '0.0.0.0';
const OPEN_BROWSER = argv.includes('--open');
const KEEP_UPLOADS = argv.includes('--keep') || process.env.KEEP_UPLOADS === '1';

const MAX_FILE_SIZE = 200 * 1024 * 1024 * 1024; // 200 GB 保护上限
const ROOM_IDLE_TTL = 6 * 60 * 60 * 1000; // 房间空闲 6 小时后回收
const ROOM_EMPTY_TTL = 10 * 60 * 1000; // 房间没人 10 分钟后回收
const PEER_OFFLINE_GRACE = 20 * 1000; // SSE 断线宽限期

/* ------------------------------------------------------------------ *
 * 内存状态
 * ------------------------------------------------------------------ */

const rooms = new Map(); // code -> room
const fileIndex = new Map(); // fileId -> { room, file }
const joinFails = new Map(); // ip -> { count, ts }

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const rid = (n = 10) => crypto.randomBytes(n).toString('hex').slice(0, n * 2);

function json(res, status, data) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return req.destroy();
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function clientIp(req) {
  const raw =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '';
  return raw.replace(/^::ffff:/, '');
}

function describeUA(ua = '') {
  const u = ua.toLowerCase();
  let kind = 'other';
  if (/iphone|ipod/.test(u)) kind = 'ios';
  else if (/ipad/.test(u)) kind = 'ipad';
  else if (/android/.test(u)) kind = 'android';
  else if (/macintosh|mac os x/.test(u)) kind = 'mac';
  else if (/windows/.test(u)) kind = 'windows';
  else if (/linux/.test(u)) kind = 'linux';

  let browser = '浏览器';
  if (/micromessenger/.test(u)) browser = '微信';
  else if (/edg\//.test(u)) browser = 'Edge';
  else if (/firefox/.test(u)) browser = 'Firefox';
  else if (/chrome\//.test(u)) browser = 'Chrome';
  else if (/safari/.test(u)) browser = 'Safari';

  const labels = {
    ios: 'iPhone',
    ipad: 'iPad',
    android: /ipad/.test(u) ? '平板' : '安卓手机',
    mac: 'Mac',
    windows: 'Windows 电脑',
    linux: 'Linux 设备',
    other: '未知设备',
  };
  return { kind, label: labels[kind] + ' · ' + browser };
}

function sanitizeName(name) {
  let n = String(name || '').replace(/[\r\n\t]/g, ' ').split(/[\\/]/).pop().trim();
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '_');
  if (!n) n = '未命名文件';
  if (n.length > 160) {
    const ext = path.extname(n).slice(0, 16);
    n = n.slice(0, 160 - ext.length) + ext;
  }
  return n;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

function send(client, type, data) {
  if (!client || !client.res || client.res.writableEnded) return;
  try {
    client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 连接已断开，忽略 */
  }
}

function broadcast(room, type, data, exceptId) {
  for (const c of room.clients.values()) {
    if (c.id === exceptId) continue;
    send(c, type, data);
  }
}

/* ------------------------------------------------------------------ *
 * 房间
 * ------------------------------------------------------------------ */

function newCode() {
  for (let i = 0; i < 500; i++) {
    const code = String(1000 + crypto.randomInt(9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('房间号分配失败');
}

function createRoom() {
  const room = {
    code: newCode(),
    createdAt: Date.now(),
    lastActive: Date.now(),
    clients: new Map(),
    files: new Map(),
  };
  rooms.set(room.code, room);
  return room;
}

function addClient(room, req, name) {
  const info = describeUA(req.headers['user-agent'] || '');
  const client = {
    id: rid(8),
    name: (name || '').trim().slice(0, 24) || info.label,
    kind: info.kind,
    ip: clientIp(req),
    joinedAt: Date.now(),
    res: null,
    online: true,
    offlineTimer: null,
  };
  room.clients.set(client.id, client);
  room.lastActive = Date.now();
  return client;
}

function peerList(room) {
  return [...room.clients.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      online: !!c.res,
      joinedAt: c.joinedAt,
    }));
}

function fileTargetsClient(file, clientId) {
  if (file.ownerId === clientId) return true;
  if (file.target === 'all') return true;
  return Array.isArray(file.target) && file.target.includes(clientId);
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    ownerId: file.ownerId,
    ownerName: file.ownerName,
    createdAt: file.createdAt,
    complete: file.complete,
    target: file.target === 'all' ? 'all' : file.target.length,
  };
}

function roomState(room, selfId) {
  const self = room.clients.get(selfId);
  return {
    code: room.code,
    createdAt: room.createdAt,
    me: self ? { id: self.id, name: self.name, kind: self.kind } : null,
    peers: peerList(room),
    files: [...room.files.values()]
      .filter((f) => fileTargetsClient(f, selfId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicFile),
  };
}

function removeFile(room, file) {
  room.files.delete(file.id);
  fileIndex.delete(file.fileId || file.id);
  fs.promises.rm(file.path, { force: true }).catch(() => {});
}

function destroyRoom(room, reason) {
  for (const file of room.files.values()) {
    fileIndex.delete(file.id);
    fs.promises.rm(file.path, { force: true }).catch(() => {});
  }
  for (const c of room.clients.values()) {
    if (c.res && !c.res.writableEnded) {
      try {
        c.res.end();
      } catch {}
    }
  }
  rooms.delete(room.code);
  fs.promises.rm(path.join(UPLOAD_DIR, room.code), { recursive: true, force: true }).catch(() => {});
  log(`房间 ${room.code} 已回收（${reason}）`);
}

/* ------------------------------------------------------------------ *
 * 处理：创建 / 加入
 * ------------------------------------------------------------------ */

async function handleCreate(req, res) {
  const body = await readJson(req);
  const room = createRoom();
  const client = addClient(room, req, body.name);
  log(`新建会话 ${room.code} · ${client.name} (${client.ip})`);
  json(res, 200, {
    code: room.code,
    clientId: client.id,
    room: roomState(room, client.id),
  });
}

async function handleJoin(req, res) {
  const body = await readJson(req);
  const code = String(body.code || '').replace(/\D/g, '').slice(0, 4);
  const ip = clientIp(req);

  const fail = joinFails.get(ip);
  if (fail && Date.now() - fail.ts < 60_000 && fail.count >= 15) {
    return json(res, 429, { error: '尝试次数过多，请稍后再试' });
  }

  const room = rooms.get(code);
  if (!room) {
    joinFails.set(ip, {
      count: (fail && Date.now() - fail.ts < 60_000 ? fail.count : 0) + 1,
      ts: Date.now(),
    });
    return json(res, 404, { error: '识别码不存在或会话已过期' });
  }

  const client = addClient(room, req, body.name);
  broadcast(room, 'peers', peerList(room), client.id);
  log(`${client.name} (${client.ip}) 加入会话 ${room.code}`);
  json(res, 200, {
    code: room.code,
    clientId: client.id,
    room: roomState(room, client.id),
  });
}

/* ------------------------------------------------------------------ *
 * 处理：实时事件流
 * ------------------------------------------------------------------ */

function handleEvents(req, res, url) {
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client');
  const room = rooms.get(code);
  if (!room) return json(res, 410, { error: '会话已过期' });
  const client = room.clients.get(clientId);
  if (!client) return json(res, 410, { error: '设备会话已失效' });

  if (client.offlineTimer) {
    clearTimeout(client.offlineTimer);
    client.offlineTimer = null;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const wasOffline = !client.res;
  client.res = res;
  client.online = true;
  room.lastActive = Date.now();

  send(client, 'state', roomState(room, client.id));
  if (wasOffline) broadcast(room, 'peers', peerList(room), client.id);

  req.on('close', () => {
    if (client.res === res) client.res = null;
    client.online = false;
    broadcast(room, 'peers', peerList(room), client.id);
    if (client.offlineTimer) clearTimeout(client.offlineTimer);
    client.offlineTimer = setTimeout(() => {
      client.offlineTimer = null;
      if (client.res) return; // 已重连
      room.clients.delete(client.id);
      broadcast(room, 'peers', peerList(room));
      log(`${client.name} 离开会话 ${room.code}`);
    }, PEER_OFFLINE_GRACE);
  });
}

/* ------------------------------------------------------------------ *
 * 处理：上传（原始字节流，避免 multipart 解析开销）
 * ------------------------------------------------------------------ */

function handleUpload(req, res, url) {
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client');
  const room = rooms.get(code);
  if (!room) return json(res, 410, { error: '会话已过期' });
  const client = room.clients.get(clientId);
  if (!client) return json(res, 410, { error: '设备会话已失效' });

  const name = sanitizeName(url.searchParams.get('name'));
  const declaredSize = Number(url.searchParams.get('size')) || 0;
  if (declaredSize > MAX_FILE_SIZE) return json(res, 413, { error: '文件超过 200GB 上限' });

  const rawTarget = url.searchParams.get('target') || 'all';
  let target = 'all';
  if (rawTarget !== 'all') {
    const ids = rawTarget.split(',').filter((id) => room.clients.has(id));
    if (!ids.length) return json(res, 400, { error: '接收设备不在会话中' });
    target = ids;
  }

  const id = rid(10);
  const dir = path.join(UPLOAD_DIR, code);
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(name).match(/\.[0-9a-zA-Z]{1,10}$/) || [''])[0];
  const filePath = path.join(dir, id + ext);

  const ws = fs.createWriteStream(filePath);
  const file = {
    id,
    name,
    size: declaredSize,
    type: req.headers['content-type'] || 'application/octet-stream',
    ownerId: client.id,
    ownerName: client.name,
    target,
    path: filePath,
    received: 0,
    createdAt: Date.now(),
    complete: false,
  };
  room.files.set(id, file);
  fileIndex.set(id, { room, file });
  room.lastActive = Date.now();

  let received = 0;
  let lastEmit = Date.now();
  let lastBytes = 0;
  let aborted = false;

  const emitProgress = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    const dt = (now - lastEmit) / 1000;
    const speed = dt > 0 ? Math.max(0, (received - lastBytes) / dt) : 0;
    lastEmit = now;
    lastBytes = received;

    const payload = {
      fileId: id,
      name,
      ownerName: client.name,
      received,
      size: declaredSize || received,
      speed,
    };
    // 只通知真正会收到这个文件的设备，避免无关设备看到进度
    for (const c of room.clients.values()) {
      if (c.id === client.id) continue;
      if (fileTargetsClient(file, c.id)) send(c, 'upload-progress', payload);
    }
  };

  const fail = (status, error) => {
    aborted = true;
    ws.destroy();
    room.files.delete(id);
    fileIndex.delete(id);
    fs.promises.rm(filePath, { force: true }).catch(() => {});
    broadcast(room, 'upload-cancelled', { fileId: id, name });
    if (!res.writableEnded) json(res, status, { error });
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_FILE_SIZE) return fail(413, '文件超过 200GB 上限');
    file.received = received;
    emitProgress(false);
  });

  req.on('aborted', () => {
    aborted = true;
    ws.destroy();
    room.files.delete(id);
    fileIndex.delete(id);
    fs.promises.rm(filePath, { force: true }).catch(() => {});
    broadcast(room, 'upload-cancelled', { fileId: id, name });
    log(`上传中断：${name}`);
  });

  ws.on('error', () => fail(500, '写入文件失败'));

  ws.on('finish', () => {
    if (aborted) return;
    file.received = received;
    file.size = declaredSize || received;
    file.complete = true;
    file.createdAt = Date.now();
    room.lastActive = Date.now();

    let receivers = 0;
    for (const c of room.clients.values()) {
      if (c.id === client.id) continue;
      if (fileTargetsClient(file, c.id)) {
        receivers++;
        send(c, 'file-added', { file: publicFile(file) });
      }
    }
    send(client, 'file-uploaded', { file: publicFile(file) });
    log(`收到文件 ${name} (${formatBytes(received)}) → 会话 ${code}，接收方 ${receivers} 台`);
    json(res, 200, { ok: true, file: publicFile(file), receivers });
  });

  req.pipe(ws);
}

/* ------------------------------------------------------------------ *
 * 处理：下载（带 Range 与进度回传）
 * ------------------------------------------------------------------ */

function handleDownload(req, res, url, fileId) {
  const entry = fileIndex.get(fileId);
  if (!entry) return json(res, 404, { error: '文件不存在或已清理' });
  const { room, file } = entry;

  const clientId = url.searchParams.get('client');
  const client = room.clients.get(clientId);
  if (!client) return json(res, 403, { error: '设备会话已失效' });
  if (!fileTargetsClient(file, client.id)) return json(res, 403, { error: '该文件不是发送给你的' });

  let start = 0;
  let end = Math.max(0, file.size - 1);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      if (m[1] === '' && m[2]) {
        start = Math.max(0, file.size - Number(m[2]));
      } else {
        start = Number(m[1] || 0);
        end = m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1;
      }
    }
    if (start >= file.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
      return res.end();
    }
  }

  const total = end - start + 1;
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition':
      `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; ` +
      `filename*=UTF-8''${encodeURIComponent(file.name)}`,
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;

  res.writeHead(range ? 206 : 200, headers);

  const rs = fs.createReadStream(file.path, { start, end });
  const owner = room.clients.get(file.ownerId);

  let sent = 0;
  let lastEmit = Date.now();
  let lastBytes = 0;
  let speed = 0;

  const emit = (done) => {
    const now = Date.now();
    if (!done && now - lastEmit < 250) return;
    const dt = (now - lastEmit) / 1000;
    if (dt > 0) speed = Math.max(0, (sent - lastBytes) / dt);
    lastEmit = now;
    lastBytes = sent;
    const payload = {
      fileId: file.id,
      clientId: client.id,
      clientName: client.name,
      received: sent,
      size: total,
      speed,
      percent: total ? Math.min(100, (sent / total) * 100) : 100,
      done: !!done,
    };
    send(client, 'download-progress', payload);
    if (owner && owner.id !== client.id) send(owner, 'peer-download-progress', payload);
  };

  rs.on('data', (chunk) => {
    sent += chunk.length;
    emit(false);
  });
  rs.on('end', () => emit(true));
  rs.on('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  req.on('close', () => rs.destroy());
  rs.pipe(res);
}

/* ------------------------------------------------------------------ *
 * 静态资源
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // 未知路径回落到单页
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e, buf) => {
        if (e) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/api/info') {
      return json(res, 200, {
        port: PORT,
        hostname: os.hostname(),
        ips: lanIps(),
        primary: primaryIp(),
        version: 1,
      });
    }
    if (pathname === '/api/room/create' && req.method === 'POST') return handleCreate(req, res);
    if (pathname === '/api/room/join' && req.method === 'POST') return handleJoin(req, res);
    if (pathname === '/api/room/state') {
      const room = rooms.get(url.searchParams.get('code'));
      const clientId = url.searchParams.get('client');
      if (!room || !room.clients.has(clientId)) return json(res, 410, { error: '会话已过期' });
      return json(res, 200, roomState(room, clientId));
    }
    if (pathname === '/api/events') return handleEvents(req, res, url);
    if (pathname === '/api/upload' && req.method === 'POST') return handleUpload(req, res, url);
    if (pathname.startsWith('/api/download/') && req.method === 'GET') {
      return handleDownload(req, res, url, pathname.slice('/api/download/'.length));
    }
    if (pathname === '/api/file/remove' && req.method === 'POST') {
      const body = await readJson(req);
      const room = rooms.get(body.code);
      const client = room && room.clients.get(body.client);
      const file = room && room.files.get(body.fileId);
      if (!room || !client || !file) return json(res, 404, { error: '文件不存在' });
      if (file.ownerId !== client.id) return json(res, 403, { error: '只有发送方可以删除' });
      removeFile(room, file);
      broadcast(room, 'file-removed', { fileId: file.id });
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/leave' && req.method === 'POST') {
      const body = await readJson(req);
      const room = rooms.get(body.code);
      if (room && body.client) {
        const client = room.clients.get(body.client);
        if (client) {
          room.clients.delete(client.id);
          broadcast(room, 'peers', peerList(room));
        }
        room.lastActive = Date.now();
      }
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/rename' && req.method === 'POST') {
      const body = await readJson(req);
      const room = rooms.get(body.code);
      const client = room && room.clients.get(body.client);
      if (!client) return json(res, 404, { error: '会话已过期' });
      client.name = String(body.name || '').trim().slice(0, 24) || client.name;
      broadcast(room, 'peers', peerList(room));
      return json(res, 200, { ok: true, name: client.name });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[error]', err);
    if (!res.writableEnded) json(res, 500, { error: 'server error' });
  }
});

/* ------------------------------------------------------------------ *
 * 定期维护
 * ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const online = [...room.clients.values()].some((c) => c.res);
    if (online) room.lastActive = now;
    const idle = now - room.lastActive;
    if (!online && idle > ROOM_EMPTY_TTL) destroyRoom(room, '无人使用');
    else if (idle > ROOM_IDLE_TTL) destroyRoom(room, '长时间空闲');
  }
}, 60 * 1000).unref();

setInterval(() => {
  for (const c of rooms.values()) {
    for (const client of c.clients.values()) {
      if (client.res && !client.res.writableEnded) {
        try {
          client.res.write(': ping\n\n');
        } catch {}
      }
    }
  }
}, 15 * 1000).unref();

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, ip: a.address });
    }
  }
  return out;
}

function primaryIp() {
  const ips = lanIps();
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return (ips.sort((a, b) => rank(a.ip) - rank(b.ip))[0] || { ip: '127.0.0.1' }).ip;
}

function printTerminalQr(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const pad = 2;
    const lines = [];
    for (let r = -pad; r < count + pad; r++) {
      let line = '';
      for (let c = -pad; c < count + pad; c++) {
        const dark = r >= 0 && c >= 0 && r < count && c < count && qr.isDark(r, c);
        line += dark ? '\u2588\u2588' : '  ';
      }
      lines.push(line);
    }
    console.log(lines.join('\n'));
  } catch (e) {
    /* 终端不支持时忽略 */
  }
}

function log(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`\x1b[90m[${t}]\x1b[0m ${msg}`);
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function start() {
  if (!KEEP_UPLOADS) {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  server.listen(PORT, HOST, () => {
    const ip = primaryIp();
    const url = `http://${ip}:${PORT}`;
    console.log('');
    console.log('  \x1b[1m\x1b[36m局域快传 · LanDrop\x1b[0m  \x1b[90m局域网文件互传（一传一 / 一传多）\x1b[0m');
    console.log('');
    console.log(`  本机访问   \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`  手机访问   \x1b[1m\x1b[32m${url}\x1b[0m   \x1b[90m(需在同一个 WiFi)\x1b[0m`);
    const others = lanIps().filter((x) => x.ip !== ip);
    for (const o of others) {
      console.log(`  其他网卡   http://${o.ip}:${PORT}  \x1b[90m(${o.iface})\x1b[0m`);
    }
    console.log(`  存储目录   ${UPLOAD_DIR}`);
    console.log('');
    console.log('  \x1b[90m手机扫码直接打开（同一 WiFi）：\x1b[0m');
    printTerminalQr(url);
    console.log('  \x1b[90m按 Ctrl+C 停止服务\x1b[0m');
    console.log('');

    if (OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用，换一个端口启动：node server.js --port 5179\n`);
    process.exit(1);
  }
  throw err;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在停止服务…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}

start();

module.exports = { server };
