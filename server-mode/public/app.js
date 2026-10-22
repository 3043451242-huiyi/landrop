/* ==========================================================================
 * 局域快传 · LanDrop 前端
 * - 4 位识别码 / 二维码加入会话
 * - 一传一 & 一传多（可选发送目标）
 * - SSE 实时同步设备列表、上传与下载进度、速度
 * ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 基础工具
   * ------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);

  const els = {};
  const IDS = [
    'viewLobby', 'viewRoom', 'netChip', 'netAddr', 'themeBtn',
    'nameCreate', 'createBtn', 'nameJoin', 'codeInput', 'joinBtn',
    'codeDisplay', 'copyCodeBtn', 'qrCard', 'qrBox', 'shareUrl', 'copyLinkBtn', 'qrToggleBtn',
    'peerCount', 'peerList', 'leaveBtn',
    'dropZone', 'pickBtn', 'pickDirBtn', 'fileInput', 'dirInput', 'targetSelect', 'aloneHint',
    'fileCount', 'liveStat', 'autoReceive', 'receiveAllBtn', 'clearBtn',
    'transferList', 'emptyState', 'toasts',
  ];
  IDS.forEach((id) => (els[id] = document.getElementById(id)));

  const state = {
    code: null,
    clientId: null,
    me: null,
    peers: [],
    files: new Map(),
    items: new Map(),
    queue: [],
    uploading: false,
    target: 'all',
    autoReceive: false,
    info: null,
    es: null,
    esErrors: 0,
    seq: 0,
  };

  const fmtBytes = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  };

  const fmtSpeed = (bps) => (bps > 0 ? fmtBytes(bps) + '/s' : '—');

  const fmtEta = (seconds) => {
    if (!isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return Math.ceil(seconds) + ' 秒';
    if (seconds < 3600) return Math.ceil(seconds / 60) + ' 分钟';
    return (seconds / 3600).toFixed(1) + ' 小时';
  };

  const extLabel = (name) => {
    const m = /\.([0-9a-zA-Z]{1,5})$/.exec(name || '');
    return m ? m[1].toUpperCase() : 'FILE';
  };

  const initialOf = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function toast(message, type = '', duration = 2600) {
    const max = window.innerWidth <= 720 ? 2 : 3;
    while (els.toasts.children.length >= max) els.toasts.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<span class="dot"></span><span></span>`;
    el.lastElementChild.textContent = message;
    els.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 240);
    }, duration);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function setBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      if (text) btn.textContent = text;
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  /* ------------------------------------------------------------------ *
   * 1. 主题
   * ------------------------------------------------------------------ */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('landrop-theme', theme);
    const use = $('#themeBtn use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  }

  function initTheme() {
    const saved = localStorage.getItem('landrop-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
    els.themeBtn.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. 服务信息 / 局域网地址
   * ------------------------------------------------------------------ */

  async function loadInfo() {
    try {
      state.info = await fetchJson('/api/info');
      const { primary, port } = state.info;
      els.netAddr.textContent = `局域网 ${primary}:${port}`;
      els.netChip.title = `本机 http://localhost:${port}\n局域网 http://${primary}:${port}\n按 Ctrl+C 可停止服务`;
      renderIpChooser();
    } catch {
      els.netAddr.textContent = '离线';
    }
  }

  function currentShareHost() {
    // 如果用局域网 IP 打开的页面，就沿用当前地址；否则用服务端探测到的局域网 IP
    const h = location.hostname;
    if (h && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') {
      return location.origin;
    }
    if (state.info && state.info.primary) {
      return `http://${state.info.primary}:${state.info.port}`;
    }
    return location.origin;
  }

  function shareUrlFor(code) {
    return `${currentShareHost()}/?code=${code}`;
  }

  function renderIpChooser() {
    if (!state.info) return;
    let box = document.getElementById('ipChooser');
    if (!box) {
      box = document.createElement('label');
      box.id = 'ipChooser';
      box.className = 'ip-row';
      box.innerHTML = '<span>地址</span><select id="ipSelect"></select>';
      els.qrCard.insertBefore(box, els.qrCard.querySelector('.share-link'));
    }
    const sel = $('#ipSelect', box);
    const ips = [...new Set([state.info.primary, ...state.info.ips.map((i) => i.ip)])].filter(Boolean);
    sel.innerHTML = ips
      .map((ip) => {
        const host = location.hostname === ip || (location.hostname === 'localhost' && ip === state.info.primary);
        return `<option value="http://${ip}:${state.info.port}">${ip}${host ? '（当前）' : ''}</option>`;
      })
      .join('');
    const cur = currentShareHost();
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    sel.onchange = () => {
      state.forcedHost = sel.value;
      renderQr();
    };
  }

  /* ------------------------------------------------------------------ *
   * 3. 二维码
   * ------------------------------------------------------------------ */

  function renderQr() {
    if (!state.code) return;
    const url = state.forcedHost ? `${state.forcedHost}/?code=${state.code}` : shareUrlFor(state.code);
    els.shareUrl.value = url;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
        }
      }
      els.qrBox.innerHTML = `<svg viewBox="0 0 ${n} ${n}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#ffffff"/><path d="${d}" fill="#0f172a"/></svg>`;
    } catch (e) {
      els.qrBox.textContent = '二维码生成失败';
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. 视图切换
   * ------------------------------------------------------------------ */

  function showRoom() {
    els.viewLobby.classList.add('hidden');
    els.viewRoom.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  function showLobby() {
    els.viewRoom.classList.add('hidden');
    els.viewLobby.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ *
   * 5. 创建 / 加入 / 退出
   * ------------------------------------------------------------------ */

  async function createRoom() {
    const btn = els.createBtn;
    setBusy(btn, true, '生成中…');
    try {
      const data = await fetchJson('/api/room/create', {
        method: 'POST',
        body: JSON.stringify({ name: els.nameCreate.value.trim() }),
      });
      enterRoom(data);
      toast(`会话已创建，识别码 ${data.code}`, 'ok');
    } catch (e) {
      toast(e.message || '创建失败', 'err');
    } finally {
      setBusy(btn, false);
    }
  }

  async function joinRoom(codeFromUrl) {
    const code = String(codeFromUrl || els.codeInput.value).replace(/\D/g, '');
    if (code.length !== 4) {
      toast('请输入 4 位识别码', 'err');
      els.codeInput.focus();
      return;
    }
    const btn = els.joinBtn;
    setBusy(btn, true, '连接中…');
    try {
      const data = await fetchJson('/api/room/join', {
        method: 'POST',
        body: JSON.stringify({ code, name: els.nameJoin.value.trim() }),
      });
      enterRoom(data);
      toast('已加入会话', 'ok');
    } catch (e) {
      toast(e.message || '加入失败', 'err');
    } finally {
      setBusy(btn, false);
    }
  }

  function enterRoom(data) {
    state.code = data.code;
    state.clientId = data.clientId;
    state.forcedHost = null;
    applyState(data.room);
    showRoom();
    renderCode();
    renderQr();
    connectSSE();
    saveSession();
    history.replaceState(null, '', `?code=${data.code}`);
  }

  function saveSession() {
    try {
      sessionStorage.setItem('landrop-session', JSON.stringify({ code: state.code, clientId: state.clientId }));
    } catch {}
  }

  async function leaveRoom(ask = true) {
    if (ask && !window.confirm('退出后本会话的文件会被清理，确定退出吗？')) return;
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: state.code, client: state.clientId }),
        keepalive: true,
      });
    } catch {}

    try {
      sessionStorage.removeItem('landrop-session');
    } catch {}

    state.code = null;
    state.clientId = null;
    state.me = null;
    state.peers = [];
    state.files.clear();
    state.items.clear();
    state.queue = [];
    state.target = 'all';

    els.transferList.querySelectorAll('.file').forEach((n) => n.remove());
    els.emptyState.classList.remove('hidden');
    els.fileCount.textContent = '0';
    els.liveStat.textContent = '';
    els.peerList.innerHTML = '';
    els.targetSelect.innerHTML = '<option value="all">会话内所有设备</option>';
    els.receiveAllBtn.hidden = true;
    showLobby();
    history.replaceState(null, '', location.pathname);
  }

  /* ------------------------------------------------------------------ *
   * 6. SSE
   * ------------------------------------------------------------------ */

  function connectSSE() {
    if (state.es) state.es.close();
    const es = new EventSource(`/api/events?code=${state.code}&client=${state.clientId}`);
    state.es = es;
    state.esErrors = 0;

    const on = (name, fn) =>
      es.addEventListener(name, (ev) => {
        try {
          fn(JSON.parse(ev.data));
        } catch (e) {
          console.warn('事件解析失败', name, e);
        }
      });

    on('state', (room) => applyState(room));

    on('peers', (peers) => {
      state.peers = peers;
      renderPeers();
      renderTargets();
    });

    on('file-added', ({ file }) => {
      const it = upsertFileItem(file, { status: 'ready', direction: 'in' });
      toast(`${file.ownerName} 发来「${file.name}」`, 'ok', 3200);
      if (state.autoReceive) startDownload(file.id);
      else it && flashItem(it);
    });

    on('upload-progress', (p) => {
      let it = state.items.get('f:' + p.fileId);
      if (!it) {
        it = createItem({
          key: 'f:' + p.fileId,
          fileId: p.fileId,
          name: p.name,
          size: p.size,
          direction: 'in',
          ownerName: p.ownerName,
          status: 'incoming',
        });
        state.items.set(it.key, it);
        renderListMeta();
      }
      if (it.status === 'incoming') {
        it.received = p.received;
        it.size = p.size || it.size;
        it.percent = it.size ? (p.received / it.size) * 100 : 0;
        it.speed = p.speed || 0;
        updateItem(it);
      }
    });

    on('file-uploaded', ({ file }) => {
      if (!state.items.has('f:' + file.id)) {
        upsertFileItem(file, { status: 'done', direction: 'out' });
      }
    });

    on('download-progress', (p) => {
      const it = state.items.get('f:' + p.fileId);
      if (!it) return;
      it.received = p.received;
      it.percent = p.percent;
      it.speed = p.speed;
      it.status = p.done ? 'received' : 'downloading';
      updateItem(it);
      if (p.done) toast(`「${it.name}」接收完成`, 'ok');
    });

    on('peer-download-progress', (p) => {
      const it = state.items.get('f:' + p.fileId);
      if (!it) return;
      it.peerProgress = it.peerProgress || new Map();
      it.peerProgress.set(p.clientId, p.percent);
      if (p.done) {
        it.delivered = it.delivered || new Set();
        it.delivered.add(p.clientId);
        it.peerProgress.delete(p.clientId);
        updateItem(it);
      } else {
        updateItem(it);
      }
    });

    on('file-removed', ({ fileId }) => {
      const it = state.items.get('f:' + fileId);
      if (it) removeItem(it.key);
      state.files.delete(fileId);
    });

    on('upload-cancelled', ({ fileId }) => {
      const it = state.items.get('f:' + fileId);
      if (it && it.status === 'incoming') removeItem(it.key);
    });

    es.onopen = () => {
      state.esErrors = 0;
    };

    es.onerror = async () => {
      if (es.readyState === EventSource.CLOSED) return;
      state.esErrors++;
      if (state.esErrors < 4) return;
      // 多次重连失败 —— 检查会话是否已过期
      try {
        await fetchJson(`/api/room/state?code=${state.code}&client=${state.clientId}`);
        state.esErrors = 0;
      } catch {
        toast('会话已结束', 'err');
        state.es.close();
        state.es = null;
        leaveRoom(false);
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. 状态应用
   * ------------------------------------------------------------------ */

  function applyState(room) {
    state.me = room.me;
    state.peers = room.peers || [];
    state.files = new Map((room.files || []).map((f) => [f.id, f]));

    renderPeers();
    renderTargets();

    for (const f of room.files || []) {
      if (!state.items.has('f:' + f.id)) {
        upsertFileItem(f, { status: f.ownerId === state.clientId ? 'done' : 'ready', direction: f.ownerId === state.clientId ? 'out' : 'in' });
      } else {
        const it = state.items.get('f:' + f.id);
        it.size = f.size;
        it.name = f.name;
        updateItem(it);
      }
    }

    // 清理服务端已不存在的条目
    for (const [key, it] of [...state.items]) {
      if (key.startsWith('f:') && it.fileId && !state.files.has(it.fileId)) removeItem(key);
    }

    if (state.target !== 'all' && !state.peers.some((p) => p.id === state.target)) {
      state.target = 'all';
      els.targetSelect.value = 'all';
    }
    renderListMeta();
  }

  function renderCode() {
    els.codeDisplay.textContent = state.code || '····';
  }

  function renderPeers() {
    const peers = state.peers.length ? state.peers : state.me ? [{ ...state.me, online: true }] : [];
    els.peerCount.textContent = String(peers.filter((p) => p.online).length || peers.length);
    els.peerList.innerHTML = peers
      .map((p) => {
        const self = state.me && p.id === state.me.id;
        return `<li class="peer ${self ? 'self' : ''}">
          <span class="peer-avatar">${initialOf(p.name)}</span>
          <span class="peer-info">
            <span class="peer-name">${escapeHtml(p.name)}</span>
            <span class="peer-meta">${self ? '本机' : p.online ? '在线' : '已离线'}</span>
          </span>
          ${self ? '<span class="peer-tag">本机</span>' : p.online ? '' : '<span class="offline-dot"></span>'}
        </li>`;
      })
      .join('');

    const others = peers.filter((p) => !state.me || p.id !== state.me.id);
    if (others.length === 0) {
      els.aloneHint.innerHTML = `还没有其他设备加入，让对方扫码或输入识别码 <b>${state.code || '----'}</b>`;
      els.aloneHint.hidden = false;
    } else {
      els.aloneHint.hidden = true;
    }
  }

  function renderTargets() {
    const others = state.peers.filter((p) => !state.me || p.id !== state.me.id);
    const current = state.target;
    els.targetSelect.innerHTML =
      '<option value="all">会话内所有设备</option>' +
      others.map((p) => `<option value="${p.id}">仅 ${escapeHtml(p.name)}</option>`).join('');
    els.targetSelect.value = current === 'all' || others.some((p) => p.id === current) ? current : 'all';
    state.target = els.targetSelect.value;
  }

  function targetLabel(target) {
    if (target === 'all') return '所有设备';
    const p = state.peers.find((x) => x.id === target);
    return p ? p.name : '指定设备';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /* ------------------------------------------------------------------ *
   * 8. 列表条目
   * ------------------------------------------------------------------ */

  function createItem(data) {
    const it = {
      key: data.key,
      fileId: data.fileId || null,
      name: data.name || '文件',
      size: data.size || 0,
      direction: data.direction || 'in',
      ownerName: data.ownerName || '',
      target: data.target || 'all',
      status: data.status || 'ready',
      progressText: data.progressText || '',
      received: data.received || 0,
      percent: data.percent || 0,
      speed: 0,
      createdAt: Date.now(),
      delivered: new Set(),
      peerProgress: new Map(),
      sideSig: '',
    };

    const el = document.createElement('div');
    el.className = 'file';
    el.innerHTML = `
      <div class="file-icon"><span>${escapeHtml(extLabel(it.name))}</span></div>
      <div class="file-body">
        <div class="file-top">
          <p class="file-name"></p>
          <span class="file-size">${fmtBytes(it.size)}</span>
        </div>
        <div class="file-meta"><span class="meta-text"></span></div>
        <div class="progress"><div class="progress-bar"></div></div>
      </div>
      <div class="file-side"></div>`;

    it.el = el;
    it.nameEl = $('.file-name', el);
    it.sizeEl = $('.file-size', el);
    it.metaEl = $('.meta-text', el);
    it.barEl = $('.progress-bar', el);
    it.sideEl = $('.file-side', el);
    it.nameEl.textContent = it.name;

    if (it.status === 'ready' || it.status === 'incoming') {
      $('.progress', el).style.display = it.status === 'incoming' ? '' : 'none';
    }

    els.transferList.appendChild(el);
    state.items.set(it.key, it);
    renderListMeta();
    updateItem(it);
    return it;
  }

  function upsertFileItem(file, extra = {}) {
    const key = 'f:' + file.id;
    let it = state.items.get(key);
    if (!it) {
      it = createItem({
        key,
        fileId: file.id,
        name: file.name,
        size: file.size,
        direction: extra.direction || 'in',
        ownerName: file.ownerName,
        status: extra.status || 'ready',
      });
    }
    if (extra.status) it.status = extra.status;
    if (!it.fileId) it.fileId = file.id;
    it.size = file.size || it.size;
    it.ownerName = file.ownerName || it.ownerName;
    if (extra.speed) it.speed = extra.speed;
    if (extra.elapsed) it.elapsed = extra.elapsed;
    updateItem(it);
    return it;
  }

  function flashItem(it) {
    it.el.animate(
      [
        { boxShadow: '0 0 0 0 rgba(79,70,229,0.45)' },
        { boxShadow: '0 0 0 8px rgba(79,70,229,0)' },
      ],
      { duration: 900, easing: 'ease-out' }
    );
  }

  function removeItem(key) {
    const it = state.items.get(key);
    if (!it) return;
    it.el.remove();
    state.items.delete(key);
    renderListMeta();
  }

  function renderListMeta() {
    const count = state.items.size;
    els.fileCount.textContent = String(count);
    els.emptyState.classList.toggle('hidden', count > 0);

    const hasReadyIn = [...state.items.values()].some((it) => it.direction === 'in' && it.status === 'ready');
    els.receiveAllBtn.hidden = !hasReadyIn;
  }

  function metaText(it) {
    const parts = [];
    const role =
      it.direction === 'out'
        ? `发送给 ${targetLabel(it.target)}`
        : it.ownerName
          ? `来自 ${it.ownerName}`
          : '接收文件';
    parts.push(role);

    if (it.status === 'queued') parts.push('排队等待');
    else if (it.status === 'uploading') {
      parts.push(`${Math.round(it.percent)}%`);
      if (it.speed) parts.push(fmtSpeed(it.speed));
      if (it.size && it.speed) parts.push(`剩余 ${fmtEta((it.size - it.received) / it.speed)}`);
    } else if (it.status === 'done') {
      if (it.elapsed) parts.push(`用时 ${it.elapsed.toFixed(1)} 秒`);
      if (it.direction === 'out' && it.delivered && it.delivered.size) parts.push(`已送达 ${it.delivered.size} 台`);
      else parts.push('已发送');
    } else if (it.status === 'incoming') {
      parts.push('正在接收中…');
      if (it.speed) parts.push(fmtSpeed(it.speed));
    } else if (it.status === 'downloading') {
      parts.push(`${Math.round(it.percent)}%`);
      if (it.speed) parts.push(fmtSpeed(it.speed));
      if (it.size && it.speed && it.percent < 100)
        parts.push(`剩余 ${fmtEta((it.size * (1 - it.percent / 100)) / it.speed)}`);
    } else if (it.status === 'received') {
      parts.push('已保存到下载目录');
    } else if (it.status === 'error') {
      parts.push('传输失败，请重试');
    } else if (it.status === 'ready') {
      parts.push('等待接收');
    }

    const peersSending = it.peerProgress && it.peerProgress.size;
    if (peersSending && it.direction === 'out' && it.status !== 'uploading') {
      const max = Math.max(...it.peerProgress.values());
      parts.push(`对方接收 ${Math.round(max)}%`);
    }

    return parts.join(' · ');
  }

  function badgeFor(it) {
    switch (it.status) {
      case 'queued':
        return ['等待中', 'wait'];
      case 'uploading':
        return [`发送 ${Math.round(it.percent)}%`, 'out'];
      case 'done':
        return ['已发送', 'out'];
      case 'incoming':
        return [`接收 ${Math.round(it.percent)}%`, 'in'];
      case 'ready':
        return ['待接收', 'wait'];
      case 'downloading':
        return [`${Math.round(it.percent)}%`, 'in'];
      case 'received':
        return ['已接收', 'in'];
      case 'error':
        return ['失败', 'err'];
      default:
        return ['—', 'wait'];
    }
  }

  function updateItem(it) {
    const [label, cls] = badgeFor(it);
    const showBar = ['uploading', 'downloading', 'incoming', 'done', 'received', 'error'].includes(it.status);
    const bar = $('.progress', it.el);
    bar.style.display = showBar ? '' : 'none';
    it.barEl.style.width = Math.max(0, Math.min(100, it.percent || (it.status === 'done' || it.status === 'received' ? 100 : 0))) + '%';

    it.el.classList.toggle('done', it.status === 'done' || it.status === 'received');
    it.el.classList.toggle('error', it.status === 'error');
    it.metaEl.textContent = metaText(it);
    it.sizeEl.textContent = fmtBytes(it.size);

    // 操作区（按签名变化才重建，避免闪烁）
    const sig = [it.status, Math.round(it.percent), cls, label].join('|');
    if (it.sideSig !== sig) {
      it.sideSig = sig;
      it.sideEl.innerHTML = '';

      const badge = document.createElement('span');
      badge.className = 'badge ' + cls;
      badge.textContent = label;
      it.sideEl.appendChild(badge);

      if (it.direction === 'in' && (it.status === 'ready' || it.status === 'error')) {
        const btn = document.createElement('button');
        btn.className = 'btn sm';
        btn.textContent = '接收';
        btn.onclick = () => startDownload(it.fileId);
        it.sideEl.appendChild(btn);
      }
      if (it.direction === 'in' && it.status === 'received') {
        const btn = document.createElement('button');
        btn.className = 'btn ghost sm';
        btn.textContent = '重新下载';
        btn.onclick = () => startDownload(it.fileId);
        it.sideEl.appendChild(btn);
      }
      if (it.direction === 'out' && it.fileId) {
        const btn = document.createElement('button');
        btn.className = 'btn ghost sm icon-only';
        btn.title = '从会话中删除';
        btn.innerHTML = '<svg width="14" height="14"><use href="#i-trash"/></svg>';
        btn.onclick = () => removeServerFile(it.fileId);
        it.sideEl.appendChild(btn);
      }
    }

    updateLiveStat();
  }

  function updateLiveStat() {
    let uploading = 0;
    let downloading = 0;
    let upSpeed = 0;
    let downSpeed = 0;
    for (const it of state.items.values()) {
      if (it.status === 'uploading') {
        uploading++;
        upSpeed += it.speed || 0;
      } else if (it.status === 'downloading') {
        downloading++;
        downSpeed += it.speed || 0;
      }
    }
    const parts = [];
    if (uploading) parts.push(`↑ ${fmtSpeed(upSpeed)} · ${uploading} 个文件`);
    if (downloading) parts.push(`↓ ${fmtSpeed(downSpeed)} · ${downloading} 个文件`);
    els.liveStat.textContent = parts.join('   ');
  }

  /* ------------------------------------------------------------------ *
   * 9. 上传
   * ------------------------------------------------------------------ */

  function addFiles(fileList) {
    const files = [...fileList].filter((f) => f && f.name);
    if (!files.length) return;
    const target = state.target;
    for (const file of files) {
      const it = createItem({
        key: 'out:' + ++state.seq,
        name: file.name,
        size: file.size,
        direction: 'out',
        target,
        status: 'queued',
      });
      it.file = file;
      state.queue.push(it);
      updateItem(it);
    }
    pump();
  }

  async function pump() {
    if (state.uploading) return;
    state.uploading = true;
    while (state.queue.length) {
      const it = state.queue.shift();
      if (it.status !== 'queued') continue;
      await uploadItem(it);
    }
    state.uploading = false;
  }

  function uploadItem(it) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const query = new URLSearchParams({
        code: state.code,
        client: state.clientId,
        name: it.name,
        size: String(it.size),
        target: it.target,
      });
      xhr.open('POST', '/api/upload?' + query.toString());
      xhr.setRequestHeader('Content-Type', it.file.type || 'application/octet-stream');

      const started = performance.now();
      let lastT = started;
      let lastB = 0;

      xhr.upload.onprogress = (e) => {
        const now = performance.now();
        const dt = (now - lastT) / 1000;
        if (dt >= 0.2) {
          it.speed = Math.max(0, (e.loaded - lastB) / dt);
          lastT = now;
          lastB = e.loaded;
        }
        if (it.status === 'queued') it.status = 'uploading';
        it.status = 'uploading';
        it.received = e.loaded;
        it.percent = it.size ? (e.loaded / it.size) * 100 : 0;
        updateItem(it);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {}
          const elapsed = (performance.now() - started) / 1000;
          it.percent = 100;
          const finishedSpeed = it.speed;
          removeItem(it.key);
          if (data.file) {
            upsertFileItem(data.file, { status: 'done', direction: 'out', speed: finishedSpeed, elapsed });
          }
          const n = data.receivers || 0;
          toast(`「${it.name}」发送完成${n ? `，${n} 台设备可接收` : ''}`, 'ok');
        } else {
          let msg = '发送失败';
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {}
          it.status = 'error';
          updateItem(it);
          toast(`「${it.name}」${msg}`, 'err');
        }
        resolve();
      };

      xhr.onerror = () => {
        it.status = 'error';
        updateItem(it);
        toast(`「${it.name}」网络中断，发送失败`, 'err');
        resolve();
      };

      xhr.onabort = () => {
        it.status = 'error';
        updateItem(it);
        resolve();
      };

      xhr.send(it.file);
    });
  }

  /* ------------------------------------------------------------------ *
   * 10. 下载
   * ------------------------------------------------------------------ */

  const downloadTimers = new Map();

  function startDownload(fileId) {
    const it = state.items.get('f:' + fileId);
    if (!it) return;
    if (it.status === 'downloading') return;

    const a = document.createElement('a');
    a.href = `/api/download/${encodeURIComponent(fileId)}?client=${encodeURIComponent(state.clientId)}`;
    a.download = it.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();

    it.status = 'downloading';
    it.percent = 0;
    it.speed = 0;
    updateItem(it);

    clearTimeout(downloadTimers.get(fileId));
    downloadTimers.set(
      fileId,
      setTimeout(() => {
        if (it.status === 'downloading' && it.percent === 0) {
          it.status = 'ready';
          updateItem(it);
          toast('下载未开始，请允许本站下载文件后重试', 'err', 3600);
        }
      }, 15000)
    );
  }

  async function removeServerFile(fileId) {
    if (!window.confirm('从会话中删除这个文件？接收方将无法再下载。')) return;
    try {
      await fetchJson('/api/file/remove', {
        method: 'POST',
        body: JSON.stringify({ code: state.code, client: state.clientId, fileId }),
      });
      removeItem('f:' + fileId);
    } catch (e) {
      toast(e.message || '删除失败', 'err');
    }
  }

  /* ------------------------------------------------------------------ *
   * 11. 文件夹拖拽
   * ------------------------------------------------------------------ */

  function readEntry(entry, path = '') {
    return new Promise((resolve) => {
      if (!entry) return resolve([]);
      if (entry.isFile) {
        entry.file(
          (file) => {
            if (path) {
              try {
                Object.defineProperty(file, 'name', { value: path + file.name, configurable: true });
              } catch {}
            }
            resolve([file]);
          },
          () => resolve([])
        );
        return;
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const readBatch = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) {
              const nested = await Promise.all(all.map((e) => readEntry(e, path + entry.name + '/')));
              return resolve(nested.flat());
            }
            all.push(...entries);
            readBatch();
          }, () => resolve([]));
        };
        readBatch();
        return;
      }
      resolve([]);
    });
  }

  /* ------------------------------------------------------------------ *
   * 12. 事件绑定
   * ------------------------------------------------------------------ */

  function bind() {
    els.createBtn.addEventListener('click', createRoom);
    els.joinBtn.addEventListener('click', () => joinRoom());
    els.leaveBtn.addEventListener('click', () => leaveRoom(true));

    els.codeInput.addEventListener('input', () => {
      els.codeInput.value = els.codeInput.value.replace(/\D/g, '').slice(0, 4);
      if (els.codeInput.value.length === 4) joinRoom();
    });
    els.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom();
    });
    els.nameJoin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom();
    });

    els.copyCodeBtn.addEventListener('click', async () => {
      const ok = await copyText(state.code || '');
      toast(ok ? '识别码已复制' : '复制失败，请手动输入', ok ? 'ok' : 'err');
    });
    els.copyLinkBtn.addEventListener('click', async () => {
      const ok = await copyText(els.shareUrl.value);
      toast(ok ? '链接已复制' : '复制失败', ok ? 'ok' : 'err');
    });

    els.qrToggleBtn.addEventListener('click', () => {
      const on = els.qrCard.classList.toggle('show');
      els.qrToggleBtn.classList.toggle('active', on);
      if (on) els.qrCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    els.pickBtn.addEventListener('click', () => els.fileInput.click());
    els.pickDirBtn.addEventListener('click', () => els.dirInput.click());
    els.fileInput.addEventListener('change', () => {
      addFiles(els.fileInput.files);
      els.fileInput.value = '';
    });
    els.dirInput.addEventListener('change', () => {
      addFiles(els.dirInput.files);
      els.dirInput.value = '';
    });

    els.targetSelect.addEventListener('change', () => {
      state.target = els.targetSelect.value;
    });

    els.autoReceive.addEventListener('change', () => {
      state.autoReceive = els.autoReceive.checked;
      localStorage.setItem('landrop-auto', state.autoReceive ? '1' : '0');
      if (state.autoReceive) {
        for (const it of state.items.values()) {
          if (it.direction === 'in' && it.status === 'ready') startDownload(it.fileId);
        }
      }
    });

    els.receiveAllBtn.addEventListener('click', () => {
      const ready = [...state.items.values()].filter((it) => it.direction === 'in' && it.status === 'ready');
      if (!ready.length) return;
      toast(`开始接收 ${ready.length} 个文件`, 'ok');
      ready.forEach((it, i) => setTimeout(() => startDownload(it.fileId), i * 400));
    });

    els.clearBtn.addEventListener('click', () => {
      for (const [key, it] of [...state.items]) {
        if (['done', 'received', 'error'].includes(it.status) && it.direction !== 'in') removeItem(key);
      }
      for (const [key, it] of [...state.items]) {
        if (it.direction === 'in' && it.status === 'received') removeItem(key);
      }
      renderListMeta();
      toast('已清空完成记录');
    });

    // 拖拽
    let dragDepth = 0;
    const dz = els.dropZone;
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    dz.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      dz.classList.add('dragging');
    });
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    dz.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragDepth <= 0) {
        dragDepth = 0;
        dz.classList.remove('dragging');
      }
    });
    dz.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      dz.classList.remove('dragging');
      if (!state.code) return;

      const items = [...(e.dataTransfer.items || [])];
      const entries = items
        .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
        .filter(Boolean);

      if (entries.some((en) => en.isDirectory)) {
        toast('正在读取文件夹…');
        const nested = await Promise.all(entries.map((en) => readEntry(en)));
        addFiles(nested.flat());
      } else {
        addFiles(e.dataTransfer.files);
      }
    });

    // 防止误关页面丢会话
    window.addEventListener('beforeunload', (e) => {
      if (state.items.size && [...state.items.values()].some((it) => ['uploading', 'downloading', 'queued'].includes(it.status))) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 13. 启动
   * ------------------------------------------------------------------ */

  async function boot() {
    initTheme();
    bind();

    const auto = localStorage.getItem('landrop-auto');
    if (auto === '1') {
      els.autoReceive.checked = true;
      state.autoReceive = true;
    }

    await loadInfo();

    const codeParam = new URLSearchParams(location.search).get('code');

    // 1) 先尝试恢复本标签页的会话（刷新页面不丢设备身份）
    let restored = false;
    try {
      const raw = sessionStorage.getItem('landrop-session');
      if (raw) {
        const s = JSON.parse(raw);
        // 若链接里带了另一个识别码，说明是要加入新会话，放弃恢复
        if (!codeParam || codeParam === s.code) {
          const room = await fetchJson(`/api/room/state?code=${s.code}&client=${s.clientId}`);
          state.code = s.code;
          state.clientId = s.clientId;
          applyState(room);
          showRoom();
          renderCode();
          renderQr();
          connectSSE();
          restored = true;
        }
      }
    } catch {
      try {
        sessionStorage.removeItem('landrop-session');
      } catch {}
    }
    if (restored) return;

    // 2) 扫码带参直接加入
    if (/^\d{4}$/.test(codeParam || '')) {
      els.codeInput.value = codeParam;
      await joinRoom(codeParam);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
