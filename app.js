/* ==========================================================================
 * 局域快传 · LanDrop — 静态 P2P 版
 * --------------------------------------------------------------------------
 * 配对：MQTT-over-WebSocket 公共信令（只传 SDP/ICE，几百字节），失败可转手动配对
 * 传输：WebRTC DataChannel 点对点直连，文件不经过任何服务器
 * 速率：起步 16KB 小包 + 256KB 缓冲试连，确认通了自动升到 128KB 包 + 16MB 缓冲
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  const els = {};
  [
    'viewLobby', 'viewRoom', 'sigChip', 'sigText', 'themeBtn',
    'nameCreate', 'createBtn', 'nameJoin', 'codeInput', 'joinBtn',
    'codeDisplay', 'copyCodeBtn', 'qrCard', 'qrBox', 'shareUrl', 'copyLinkBtn', 'qrToggleBtn',
    'roleHint', 'roleText', 'peerCount', 'peerList', 'leaveBtn',
    'dropZone', 'pickBtn', 'pickDirBtn', 'fileInput', 'dirInput', 'targetSelect', 'aloneHint',
    'fileCount', 'liveStat', 'autoReceive', 'saveAllBtn', 'clearBtn',
    'transferList', 'emptyState', 'toasts',
    'manualPanel', 'manualOfferBtn', 'manualOffer', 'copyOfferBtn',
    'manualAnswerIn', 'manualAnswerBtn', 'manualAnswerOut', 'manualFinalIn', 'manualFinalBtn',
  ].forEach((id) => (els[id] = document.getElementById(id)));

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
    ],
    bundlePolicy: 'max-bundle',
  };

  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const topicFor = (code) => `landrop/v2/${code}`;

  const state = {
    role: null, // host | guest
    code: null,
    myId: (() => {
      try {
        return sessionStorage.getItem('ld-id') || rid(6);
      } catch {
        return rid(6);
      }
    })(),
    myName: '',
    peers: new Map(),
    items: new Map(),
    signal: null,
    signalState: 'off',
    target: 'all',
    autoReceive: false,
    manual: null,
    seq: 0,
  };
  try {
    sessionStorage.setItem('ld-id', state.myId);
  } catch {}

  if (!window.RTCPeerConnection) {
    document.body.innerHTML =
      '<div class="unsupported"><strong>当前浏览器不支持 WebRTC</strong>请使用 Chrome / Edge / Safari 新版本打开本页面。</div>';
    return;
  }

  /* ------------------------------------------------------------------ *
   * 0. 工具
   * ------------------------------------------------------------------ */

  function rid(n = 8) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  const fmtBytes = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  };
  const fmtSpeed = (bps) => (bps > 0 ? fmtBytes(bps) + '/s' : '—');
  const fmtEta = (s) => {
    if (!isFinite(s) || s <= 0) return '—';
    if (s < 60) return Math.ceil(s) + ' 秒';
    if (s < 3600) return Math.ceil(s / 60) + ' 分钟';
    return (s / 3600).toFixed(1) + ' 小时';
  };
  const extLabel = (name) => {
    const m = /\.([0-9a-zA-Z]{1,5})$/.exec(name || '');
    return m ? m[1].toUpperCase() : 'FILE';
  };
  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initialOf = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

  function deviceKind() {
    const ua = navigator.userAgent;
    if (/iPhone|iPod/.test(ua)) return 'ios';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
    if (/Android/.test(ua)) return 'android';
    if (/Macintosh/.test(ua)) return 'mac';
    if (/Windows/.test(ua)) return 'windows';
    return 'other';
  }

  function toast(message, type = '', duration = 2600) {
    const max = window.innerWidth <= 720 ? 2 : 3;
    while (els.toasts.children.length >= max) els.toasts.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span class="dot"></span><span></span>';
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

  /* ------------------------------------------------------------------ *
   * 1. 主题
   * ------------------------------------------------------------------ */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('ld-theme', theme);
    } catch {}
    const use = $('#themeBtn use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem('ld-theme');
    } catch {}
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
    els.themeBtn.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. 信令
   * ------------------------------------------------------------------ */

  function setSignal(kind, text) {
    state.signalState = kind;
    els.sigChip.className = 'sig-chip ' + kind;
    els.sigText.textContent = text;
  }

  function sendSignal(msg) {
    if (!state.signal || !state.code) return false;
    msg.from = state.myId;
    return state.signal.publish(topicFor(state.code), JSON.stringify(msg));
  }

  async function connectSignaling() {
    setSignal('warn', '连接信令…');
    for (const url of BROKERS) {
      try {
        const c = new MqttLite({ url, clientId: 'ld_' + state.myId + '_' + Date.now().toString(36) });
        await c.connect();
        c.subscribe(topicFor(state.code), (payload) => {
          let m;
          try {
            m = JSON.parse(payload);
          } catch {
            return;
          }
          if (!m || m.from === state.myId) return;
          if (m.to && m.to !== state.myId) return;
          onSignal(m).catch((e) => console.warn('[signaling]', e));
        });
        c.onclose = () => {
          state.signal = null;
          setSignal('err', '信令已断开');
        };
        state.signal = c;
        setSignal('online', '信令已连接');
        return true;
      } catch (e) {
        console.warn('[mqtt]', url, e.message);
      }
    }
    setSignal('err', '信令不可用');
    return false;
  }

  async function onSignal(m) {
    switch (m.t) {
      case 'hello':
        if (state.role === 'host' && !state.peers.has(m.from)) await hostAccept(m);
        break;
      case 'offer': {
        if (state.role !== 'guest') break;
        const existing = state.peers.get(m.from);
        if (existing && existing.pc && existing.pc.currentLocalDescription) {
          // 房主重发 offer：直接补发一次 answer
          sendSignal({ t: 'answer', to: m.from, sdp: existing.pc.localDescription });
          break;
        }
        await guestAccept(m);
        break;
      }
      case 'answer': {
        const p = state.peers.get(m.from);
        if (p && p.pc && !p.pc.currentRemoteDescription) {
          await p.pc.setRemoteDescription(m.sdp);
          flushIce(p);
        }
        break;
      }
      case 'ice': {
        const p = state.peers.get(m.from);
        if (!p || !p.pc) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.candidate).catch(() => {});
        else p.pendingIce.push(m.candidate);
        break;
      }
      case 'hi': {
        const p = state.peers.get(m.from);
        if (p) {
          p.name = m.name || p.name;
          p.kind = m.kind || p.kind;
          renderPeers();
        }
        break;
      }
      case 'bye': {
        const p = state.peers.get(m.from);
        if (p) closePeer(p, '对方已离开');
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 3. 房间
   * ------------------------------------------------------------------ */

  function pickCode() {
    return String(1000 + Math.floor(Math.random() * 9000));
  }

  function deviceName(input) {
    const typed = (input && input.value.trim()) || '';
    if (typed) return typed.slice(0, 18);
    const map = { ios: 'iPhone', ipad: 'iPad', android: '安卓手机', windows: 'Windows 电脑', mac: 'Mac', other: '浏览器' };
    return map[deviceKind()] || '浏览器';
  }

  async function createRoom() {
    state.role = 'host';
    state.myName = deviceName(els.nameCreate);
    state.code = pickCode();
    els.createBtn.disabled = true;
    const ok = await connectSignaling();
    els.createBtn.disabled = false;
    enterRoom();
    if (!ok) {
      toast('信令服务器不可用，可用下方「手动配对」连接', 'err', 5000);
      els.manualPanel.open = true;
    }
  }

  async function joinRoom(codeFromUrl) {
    const code = String(codeFromUrl || els.codeInput.value).replace(/\D/g, '');
    if (code.length !== 4) {
      toast('请输入 4 位识别码', 'err');
      els.codeInput.focus();
      return;
    }
    state.role = 'guest';
    state.myName = deviceName(els.nameJoin);
    state.code = code;
    els.joinBtn.disabled = true;
    const ok = await connectSignaling();
    els.joinBtn.disabled = false;
    enterRoom();
    if (!ok) {
      toast('信令服务器不可用，可用下方「手动配对」连接', 'err', 5000);
      els.manualPanel.open = true;
      return;
    }
    const hello = () => sendSignal({ t: 'hello', name: state.myName, kind: deviceKind() });
    hello();
    setTimeout(hello, 700);
    setTimeout(hello, 1600);
  }

  function enterRoom() {
    els.viewLobby.classList.add('hidden');
    els.viewRoom.classList.remove('hidden');
    els.codeDisplay.textContent = state.code;
    els.roleText.textContent =
      state.role === 'host'
        ? '你是房主：其他设备连上后，你可以一次发给全部设备。'
        : '你是加入方：文件直接发给房主，也可以收到房主发来的文件。';
    renderQr();
    renderPeers();
    renderTargets();
    history.replaceState(null, '', `?code=${state.code}`);
  }

  function renderQr() {
    const url = `${location.origin}${location.pathname}?code=${state.code}`;
    els.shareUrl.value = url;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      }
      els.qrBox.innerHTML = `<svg viewBox="0 0 ${n} ${n}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#ffffff"/><path d="${d}" fill="#0f172a"/></svg>`;
    } catch {
      els.qrBox.textContent = '二维码生成失败';
    }
  }

  function leaveRoom() {
    for (const p of state.peers.values()) {
      try {
        sendSignal({ t: 'bye', to: p.id });
        p.dc && p.dc.close();
        p.pc && p.pc.close();
      } catch {}
    }
    state.peers.clear();
    if (state.signal) {
      state.signal.close();
      state.signal = null;
    }
    if (state.manual) {
      try {
        state.manual.pc.close();
      } catch {}
      state.manual = null;
    }
    state.items.clear();
    state.code = null;
    state.role = null;
    els.transferList.querySelectorAll('.file').forEach((n) => n.remove());
    els.emptyState.classList.remove('hidden');
    els.fileCount.textContent = '0';
    els.liveStat.textContent = '';
    els.peerList.innerHTML = '';
    els.codeDisplay.textContent = '····';
    els.aloneHint.hidden = true;
    els.saveAllBtn.hidden = true;
    setSignal('off', '未连接');
    els.viewRoom.classList.add('hidden');
    els.viewLobby.classList.remove('hidden');
    history.replaceState(null, '', location.pathname);
  }

  /* ------------------------------------------------------------------ *
   * 4. WebRTC 连接
   * ------------------------------------------------------------------ */

  function createPeer(info) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = {
      id: info.id,
      name: info.name || '对方设备',
      kind: info.kind || 'other',
      pc,
      dc: null,
      status: 'connecting',
      quality: '',
      pendingIce: [],
      queue: [],
      sending: false,
      currentRec: null,
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      if (state.manual && state.manual.peer === peer) return; // 手动模式不带外发候选，靠完整 SDP
      sendSignal({ t: 'ice', to: peer.id, candidate: c });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (peer.status !== 'connected') inspectConnection(peer);
      } else if (pc.connectionState === 'failed') {
        peer.status = 'failed';
        renderPeers();
        toast(`${peer.name} 连接失败`, 'err');
      } else if (pc.connectionState === 'disconnected') {
        peer.status = 'offline';
        renderPeers();
      }
    };

    state.peers.set(peer.id, peer);
    return peer;
  }

  async function hostAccept(info) {
    const peer = createPeer({ id: info.from, name: info.name, kind: info.kind });
    const dc = peer.pc.createDataChannel('file', { ordered: true });
    bindChannel(peer, dc);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    sendSignal({ t: 'offer', to: peer.id, sdp: peer.pc.localDescription, name: state.myName, kind: deviceKind() });
    sendSignal({ t: 'hi', to: peer.id, name: state.myName, kind: deviceKind() });
    renderPeers();
    renderTargets();
  }

  async function guestAccept(m) {
    const peer = createPeer({ id: m.from, name: m.name, kind: m.kind });
    peer.pc.ondatachannel = (e) => bindChannel(peer, e.channel);
    await peer.pc.setRemoteDescription(m.sdp);
    flushIce(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    sendSignal({ t: 'answer', to: m.from, sdp: peer.pc.localDescription });
    renderPeers();
    renderTargets();
  }

  function flushIce(peer) {
    const list = peer.pendingIce.splice(0);
    for (const c of list) peer.pc.addIceCandidate(c).catch(() => {});
  }

  function bindChannel(peer, dc) {
    peer.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      peer.status = 'connected';
      renderPeers();
      renderTargets();
      inspectConnection(peer);
      pumpPeer(peer);
      toast(`${peer.name} 已连上`, 'ok');
    };
    dc.onclose = () => {
      peer.status = 'closed';
      renderPeers();
      renderTargets();
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        onChannelControl(peer, m);
      } else {
        onChannelChunk(peer, e.data);
      }
    };
  }

  async function inspectConnection(peer) {
    try {
      const stats = await peer.pc.getStats();
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair) {
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
        });
      }
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const types = [local && local.candidateType, remote && remote.candidateType].filter(Boolean);
      if (types.includes('relay')) peer.quality = '中继';
      else if (types.length && types.every((t) => t === 'host')) peer.quality = '局域网直连';
      else peer.quality = 'P2P 直连';
      renderPeers();
    } catch {}
  }

  function closePeer(peer, reason) {
    try {
      peer.dc && peer.dc.close();
      peer.pc && peer.pc.close();
    } catch {}
    state.peers.delete(peer.id);
    renderPeers();
    renderTargets();
    if (reason) toast(reason, 'err');
  }

  /* ------------------------------------------------------------------ *
   * 5. 发送
   * ------------------------------------------------------------------ */

  const CHUNK_START = 16 * 1024;
  const CHUNK_MID = 64 * 1024;
  const CHUNK_FAST = 128 * 1024;
  const BUF_START = 256 * 1024;
  const BUF_MID = 1024 * 1024;
  const BUF_FAST = 16 * 1024 * 1024;

  function drain(dc, threshold) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        dc.removeEventListener('bufferedamountlow', finish);
        resolve();
      };
      try {
        dc.bufferedAmountLowThreshold = Math.max(64 * 1024, Math.floor(threshold / 4));
        dc.addEventListener('bufferedamountlow', finish);
      } catch {}
      const poll = () => {
        if (done) return;
        if (dc.readyState !== 'open' || dc.bufferedAmount <= threshold / 4) finish();
        else setTimeout(poll, 10);
      };
      setTimeout(poll, 10);
    });
  }

  function enqueueFiles(files) {
    const list = [...files].filter((f) => f && f.name);
    if (!list.length) return;

    const connected = [...state.peers.values()].filter((p) => p.status === 'connected' && p.dc && p.dc.readyState === 'open');
    if (!connected.length) {
      toast(state.peers.size ? '通道还在建立中，请稍候' : '还没有设备连上', 'err');
      return;
    }
    const targets = state.target === 'all' ? connected : connected.filter((p) => p.id === state.target);
    if (!targets.length) {
      toast('目标设备未连接', 'err');
      return;
    }

    for (const file of list) {
      const it = createOutItem(file, targets);
      for (const peer of targets) {
        it.perPeer.set(peer.id, { sent: 0, acked: 0, phase: 'slow', speed: 0 });
        peer.queue.push({ id: it.id, file, it, peer });
      }
      updateItem(it);
      targets.forEach(pumpPeer);
    }
  }

  async function pumpPeer(peer) {
    if (peer.sending) return;
    peer.sending = true;
    try {
      while (peer.queue.length) {
        const job = peer.queue.shift();
        await sendJob(job);
      }
    } catch (e) {
      console.warn('[send]', e);
    } finally {
      peer.sending = false;
    }
  }

  async function sendJob(job) {
    const { peer, file, it } = job;
    const dc = peer.dc;
    const pp = it.perPeer.get(peer.id);
    if (!dc || dc.readyState !== 'open') {
      markError(it, '连接已断开');
      return;
    }

    it.status = 'uploading';
    updateItem(it);
    try {
      dc.send(JSON.stringify({ t: 'file', id: it.id, name: file.name, size: file.size, mime: file.type || '' }));
    } catch (e) {
      markError(it, '无法发送文件信息');
      return;
    }

    let offset = 0;
    let chunk = CHUNK_START;
    let hwm = BUF_START;
    let winStart = performance.now();
    let winBytes = 0;
    const t0 = winStart;

    while (offset < file.size) {
      if (dc.readyState !== 'open') {
        markError(it, '连接中断');
        return;
      }
      if (dc.bufferedAmount > hwm) {
        await drain(dc, hwm);
        continue;
      }
      const end = Math.min(offset + chunk, file.size);
      let buf;
      try {
        buf = await file.slice(offset, end).arrayBuffer();
      } catch {
        markError(it, '读取文件失败');
        return;
      }
      try {
        dc.send(buf);
      } catch {
        await drain(dc, 0);
        continue;
      }
      offset = end;
      pp.sent = offset;
      winBytes += buf.byteLength;

      const now = performance.now();
      if (now - winStart > 250) {
        pp.speed = (winBytes * 1000) / (now - winStart);
        winStart = now;
        winBytes = 0;
        updateOutProgress(it);
      }

      // 慢启动：先小包确认通道，通了再逐级提速
      if (offset > 256 * 1024) {
        chunk = CHUNK_MID;
        hwm = BUF_MID;
      }
      if (offset > 1024 * 1024) {
        chunk = CHUNK_FAST;
        hwm = BUF_FAST;
        pp.phase = 'fast';
      }
    }

    try {
      dc.send(JSON.stringify({ t: 'end', id: it.id }));
    } catch {}

    pp.sent = file.size;
    pp.phase = 'fast';
    pp.done = true;

    const allDone = [...it.perPeer.values()].every((x) => x.done);
    if (allDone) {
      it.status = 'done';
      it.percent = 100;
      it.speed = file.size / Math.max(0.2, (performance.now() - t0) / 1000);
      updateItem(it);
      toast(`「${it.name}」已发送给 ${it.perPeer.size} 台设备`, 'ok');
    } else {
      updateOutProgress(it);
    }
  }

  /* ------------------------------------------------------------------ *
   * 6. 接收
   * ------------------------------------------------------------------ */

  function onChannelControl(peer, m) {
    switch (m.t) {
      case 'file': {
        const it = createInItem(m, peer);
        peer.currentRec = {
          id: m.id,
          name: m.name,
          size: m.size,
          mime: m.mime,
          peerId: peer.id,
          chunks: [],
          received: 0,
          lastTick: performance.now(),
          lastBytes: 0,
          it,
        };
        break;
      }
      case 'end': {
        const rec = peer.currentRec;
        if (!rec || rec.id !== m.id) return;
        finishIncoming(peer, rec);
        peer.currentRec = null;
        break;
      }
      case 'ack': {
        const it = state.items.get('o:' + m.id);
        if (it && it.perPeer.has(peer.id)) {
          it.perPeer.get(peer.id).acked = m.bytes;
          updateItem(it);
        }
        break;
      }
      case 'done': {
        const it = state.items.get('o:' + m.id);
        if (it) {
          it.delivered = it.delivered || new Set();
          it.delivered.add(peer.id);
          updateItem(it);
        }
        break;
      }
      case 'cancel': {
        const it = state.items.get('i:' + peer.id + '|' + m.id);
        if (it) markError(it, '对方取消发送');
        break;
      }
    }
  }

  function onChannelChunk(peer, buffer) {
    const rec = peer.currentRec;
    if (!rec) return;
    rec.chunks.push(buffer);
    rec.received += buffer.byteLength;

    const now = performance.now();
    if (now - rec.lastTick > 200) {
      rec.speed = ((rec.received - rec.lastBytes) * 1000) / (now - rec.lastTick);
      rec.lastTick = now;
      rec.lastBytes = rec.received;
      const it = rec.it;
      it.percent = rec.size ? (rec.received / rec.size) * 100 : 0;
      it.speed = rec.speed;
      it.received = rec.received;
      updateItem(it);
      try {
        peer.dc.send(JSON.stringify({ t: 'ack', id: rec.id, bytes: rec.received }));
      } catch {}
    }
  }

  function finishIncoming(peer, rec) {
    const it = rec.it;
    if (rec.received !== rec.size) {
      markError(it, `数据不完整（${fmtBytes(rec.received)}/${fmtBytes(rec.size)}）`);
      return;
    }
    const blob = new Blob(rec.chunks, { type: rec.mime || 'application/octet-stream' });
    it.blobUrl = URL.createObjectURL(blob);
    it.percent = 100;
    it.speed = 0;
    it.status = 'received';
    updateItem(it);
    try {
      peer.dc.send(JSON.stringify({ t: 'done', id: rec.id }));
    } catch {}
    toast(`「${it.name}」接收完成`, 'ok');
    if (state.autoReceive) saveItem(it);
  }

  function saveItem(it) {
    if (!it.blobUrl) {
      toast('文件还没接收完成', 'err');
      return;
    }
    const a = document.createElement('a');
    a.href = it.blobUrl;
    a.download = it.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    it.saved = true;
    updateItem(it);
  }

  /* ------------------------------------------------------------------ *
   * 7. 列表渲染
   * ------------------------------------------------------------------ */

  function createOutItem(file, targets) {
    const id = rid(6);
    const it = {
      key: 'o:' + id,
      id,
      name: file.name,
      size: file.size,
      direction: 'out',
      status: 'queued',
      percent: 0,
      speed: 0,
      target: state.target,
      peerIds: targets.map((p) => p.id),
      perPeer: new Map(),
      createdAt: Date.now(),
    };
    mountItem(it);
    return it;
  }

  function createInItem(m, peer) {
    const it = {
      key: 'i:' + peer.id + '|' + m.id,
      id: m.id,
      name: m.name || '文件',
      size: m.size || 0,
      direction: 'in',
      status: 'receiving',
      percent: 0,
      speed: 0,
      ownerName: peer.name,
      createdAt: Date.now(),
      received: 0,
    };
    mountItem(it);
    return it;
  }

  function mountItem(it) {
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
    it.sideSig = '';

    els.transferList.appendChild(el);
    state.items.set(it.key, it);
    renderListMeta();
    updateItem(it);
  }

  function removeItem(it) {
    if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
    it.el.remove();
    state.items.delete(it.key);
    renderListMeta();
  }

  function renderListMeta() {
    const count = state.items.size;
    els.fileCount.textContent = String(count);
    els.emptyState.classList.toggle('hidden', count > 0);
    const hasIn = [...state.items.values()].some((it) => it.direction === 'in' && it.status === 'received' && !it.saved);
    els.saveAllBtn.hidden = !hasIn;
  }

  function markError(it, msg) {
    it.status = 'error';
    it.error = msg;
    updateItem(it);
    toast(`「${it.name}」${msg}`, 'err', 3400);
  }

  function updateOutProgress(it) {
    let sumPct = 0;
    let sumSpeed = 0;
    let n = 0;
    for (const pp of it.perPeer.values()) {
      sumPct += it.size ? (pp.sent / it.size) * 100 : 0;
      sumSpeed += pp.speed || 0;
      n++;
    }
    it.percent = n ? sumPct / n : 0;
    it.speed = sumSpeed;
    updateItem(it);
  }

  function metaText(it) {
    const parts = [];
    if (it.direction === 'out') {
      const names = it.peerIds
        .map((id) => (state.peers.get(id) || {}).name)
        .filter(Boolean);
      parts.push(it.target === 'all' ? `发送给 ${names.length || 1} 台设备` : `发送给 ${names[0] || '对方'}`);
    } else {
      parts.push(`来自 ${it.ownerName || '对方'}`);
    }

    if (it.status === 'queued') parts.push('排队等待');
    else if (it.status === 'uploading') {
      const phase = [...it.perPeer.values()].some((p) => p.phase === 'fast') ? '极速' : '试连';
      parts.push(phase);
      parts.push(`${Math.round(it.percent)}%`);
      if (it.speed) parts.push(fmtSpeed(it.speed));
      if (it.size && it.speed) parts.push(`剩余 ${fmtEta((it.size * (1 - it.percent / 100)) / it.speed)}`);
    } else if (it.status === 'done') {
      if (it.delivered) parts.push(`已送达 ${it.delivered.size}/${it.peerIds.length}`);
      else parts.push('已发送');
      if (it.speed) parts.push(`均速 ${fmtSpeed(it.speed)}`);
    } else if (it.status === 'receiving') {
      parts.push('接收中');
      if (it.speed) parts.push(fmtSpeed(it.speed));
      if (it.size && it.speed && it.percent < 100) parts.push(`剩余 ${fmtEta((it.size * (1 - it.percent / 100)) / it.speed)}`);
    } else if (it.status === 'received') {
      parts.push(it.saved ? '已保存到下载目录' : '接收完成，点右侧保存');
    } else if (it.status === 'error') {
      parts.push(it.error || '传输失败');
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
      case 'receiving':
        return [`接收 ${Math.round(it.percent)}%`, 'in'];
      case 'received':
        return [it.saved ? '已保存' : '已接收', 'in'];
      case 'error':
        return ['失败', 'err'];
      default:
        return ['—', 'wait'];
    }
  }

  function updateItem(it) {
    const [label, cls] = badgeFor(it);
    const active = it.status === 'uploading' || it.status === 'receiving';
    const showBar = active || it.status === 'done' || it.status === 'received' || it.status === 'error';
    $('.progress', it.el).style.display = showBar ? '' : 'none';
    it.barEl.style.width =
      Math.max(0, Math.min(100, active ? it.percent : it.status === 'error' ? it.percent : 100)) + '%';

    it.el.classList.toggle('done', it.status === 'done' || it.status === 'received');
    it.el.classList.toggle('error', it.status === 'error');
    it.metaEl.textContent = metaText(it);
    it.sizeEl.textContent = fmtBytes(it.size);

    const sig = [it.status, Math.round(it.percent), label, it.saved ? 'saved' : ''].join('|');
    if (it.sideSig !== sig) {
      it.sideSig = sig;
      it.sideEl.innerHTML = '';
      const badge = document.createElement('span');
      badge.className = 'badge ' + cls;
      badge.textContent = label;
      it.sideEl.appendChild(badge);

      if (it.direction === 'in' && it.status === 'received' && !it.saved) {
        const btn = document.createElement('button');
        btn.className = 'btn sm';
        btn.textContent = '保存';
        btn.onclick = () => saveItem(it);
        it.sideEl.appendChild(btn);
      }
      if (it.direction === 'in' && it.status === 'received' && it.saved) {
        const btn = document.createElement('button');
        btn.className = 'btn ghost sm';
        btn.textContent = '再次保存';
        btn.onclick = () => saveItem(it);
        it.sideEl.appendChild(btn);
      }
      if (it.status === 'error') {
        const btn = document.createElement('button');
        btn.className = 'btn ghost sm';
        btn.textContent = '移除';
        btn.onclick = () => removeItem(it);
        it.sideEl.appendChild(btn);
      }
    }

    updateLiveStat();
  }

  function updateLiveStat() {
    let up = 0, down = 0, upN = 0, downN = 0;
    for (const it of state.items.values()) {
      if (it.status === 'uploading') {
        up += it.speed || 0;
        upN++;
      } else if (it.status === 'receiving') {
        down += it.speed || 0;
        downN++;
      }
    }
    const parts = [];
    if (upN) parts.push(`↑ ${fmtSpeed(up)} · ${upN} 个`);
    if (downN) parts.push(`↓ ${fmtSpeed(down)} · ${downN} 个`);
    els.liveStat.textContent = parts.join('   ');
  }

  /* ------------------------------------------------------------------ *
   * 8. 设备列表
   * ------------------------------------------------------------------ */

  function renderPeers() {
    const peers = [...state.peers.values()];
    const online = peers.filter((p) => p.status === 'connected').length;
    els.peerCount.textContent = String(online + 1);

    const items = [
      `<li class="peer self">
        <span class="peer-avatar">${initialOf(state.myName)}</span>
        <span class="peer-info">
          <span class="peer-name">${escapeHtml(state.myName)}</span>
          <span class="peer-meta">本机${state.role === 'host' ? ' · 房主' : ''}</span>
        </span>
        <span class="peer-tag">本机</span>
      </li>`,
      ...peers.map((p) => {
        const cls = p.status === 'connected' ? 'on' : p.status === 'connecting' ? 'connecting' : 'err';
        const text =
          p.status === 'connected'
            ? p.quality || '已连接'
            : p.status === 'connecting'
              ? '连接中…'
              : p.status === 'offline'
                ? '已断开'
                : '连接失败';
        return `<li class="peer">
          <span class="peer-avatar">${initialOf(p.name)}</span>
          <span class="peer-info">
            <span class="peer-name">${escapeHtml(p.name)}</span>
            <span class="peer-meta">${p.status === 'connected' ? '点对点直连' : '等待握手'}</span>
          </span>
          <span class="peer-state ${cls}">${text}</span>
        </li>`;
      }),
    ];
    els.peerList.innerHTML = items.join('');

    if (!peers.length) {
      els.aloneHint.innerHTML = `还没有其他设备加入，让对方扫码或输入识别码 <b>${state.code || '----'}</b>`;
      els.aloneHint.hidden = false;
    } else if (online === 0) {
      els.aloneHint.textContent = '正在建立点对点通道，几秒后即可发送…';
      els.aloneHint.hidden = false;
    } else {
      els.aloneHint.hidden = true;
    }
  }

  function renderTargets() {
    const connected = [...state.peers.values()].filter((p) => p.status === 'connected');
    if (state.target !== 'all' && !connected.some((p) => p.id === state.target)) state.target = 'all';
    const allLabel = state.role === 'guest' ? '房主' : '会话内所有设备';
    els.targetSelect.innerHTML =
      `<option value="all">${allLabel}</option>` +
      (state.role === 'host' ? connected.map((p) => `<option value="${p.id}">仅 ${escapeHtml(p.name)}</option>`).join('') : '');
    els.targetSelect.value = state.target;
  }

  /* ------------------------------------------------------------------ *
   * 9. 手动配对（信令不可用时兜底）
   * ------------------------------------------------------------------ */

  function pack(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function unpack(str) {
    const bin = atob(String(str).replace(/\s+/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function waitIce(pc, ms = 2500) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() {
        if (pc.iceGatheringState === 'complete') done();
      }
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function manualPeer(pc) {
    const peer = {
      id: 'manual',
      name: '手动配对设备',
      kind: 'other',
      pc,
      dc: null,
      status: 'connecting',
      quality: '',
      pendingIce: [],
      queue: [],
      sending: false,
      currentRec: null,
      manual: true,
    };
    pc.ondatachannel = (e) => bindChannel(peer, e.channel);
    if (!state.peers.has('manual')) state.peers.set('manual', peer);
    return peer;
  }

  async function makeOffer() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = manualPeer(pc);
    peer.dc = pc.createDataChannel('file', { ordered: true });
    bindChannel(peer, peer.dc);
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc);
    const text = pack({ v: 1, kind: 'offer', name: state.myName, sdp: pc.localDescription });
    els.manualOffer.value = text;
    await copyText(text);
    toast('邀请码已生成并复制，发给对方即可', 'ok', 3600);
    renderPeers();
  }

  async function makeAnswer() {
    const text = els.manualAnswerIn.value.trim();
    if (!text) return toast('先粘贴对方的邀请码', 'err');
    let data;
    try {
      data = unpack(text);
    } catch {
      return toast('邀请码格式不正确', 'err');
    }
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = manualPeer(pc);
    if (data.name) peer.name = data.name;
    await pc.setRemoteDescription(data.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc);
    const out = pack({ v: 1, kind: 'answer', name: state.myName, sdp: pc.localDescription });
    els.manualAnswerOut.value = out;
    await copyText(out);
    toast('应答码已生成并复制，回传给发起方', 'ok', 3600);
    renderPeers();
  }

  async function finishManual() {
    const text = els.manualFinalIn.value.trim();
    if (!text) return toast('先粘贴对方回传的应答码', 'err');
    let data;
    try {
      data = unpack(text);
    } catch {
      return toast('应答码格式不正确', 'err');
    }
    const peer = state.peers.get('manual');
    if (!peer) return toast('请先在第 ① 步生成邀请码', 'err');
    await peer.pc.setRemoteDescription(data.sdp);
    toast('正在建立连接…', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * 10. 事件绑定
   * ------------------------------------------------------------------ */

  function bind() {
    els.createBtn.addEventListener('click', createRoom);
    els.joinBtn.addEventListener('click', () => joinRoom());
    els.leaveBtn.addEventListener('click', () => {
      if (state.items.size && !window.confirm('退出会话？未完成的传输会中断。')) return;
      leaveRoom();
    });

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
      enqueueFiles(els.fileInput.files);
      els.fileInput.value = '';
    });
    els.dirInput.addEventListener('change', () => {
      enqueueFiles(els.dirInput.files);
      els.dirInput.value = '';
    });

    els.targetSelect.addEventListener('change', () => {
      state.target = els.targetSelect.value;
    });

    els.autoReceive.addEventListener('change', () => {
      state.autoReceive = els.autoReceive.checked;
      try {
        localStorage.setItem('ld-auto', state.autoReceive ? '1' : '0');
      } catch {}
      if (state.autoReceive) {
        for (const it of state.items.values()) {
          if (it.direction === 'in' && it.status === 'received' && !it.saved) saveItem(it);
        }
      }
    });

    els.saveAllBtn.addEventListener('click', () => {
      const list = [...state.items.values()].filter((it) => it.direction === 'in' && it.status === 'received' && !it.saved);
      if (!list.length) return;
      list.forEach((it, i) => setTimeout(() => saveItem(it), i * 350));
      toast(`正在保存 ${list.length} 个文件`, 'ok');
    });

    els.clearBtn.addEventListener('click', () => {
      [...state.items.values()]
        .filter((it) => it.status === 'done' || it.status === 'received' || it.status === 'error')
        .forEach(removeItem);
      renderListMeta();
      toast('已清空完成记录');
    });

    els.manualOfferBtn.addEventListener('click', makeOffer);
    els.manualAnswerBtn.addEventListener('click', makeAnswer);
    els.manualFinalBtn.addEventListener('click', finishManual);
    els.copyOfferBtn.addEventListener('click', async () => {
      if (!els.manualOffer.value) return toast('先生成邀请码', 'err');
      const ok = await copyText(els.manualOffer.value);
      toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err');
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
      const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
      if (entries.some((en) => en.isDirectory)) {
        toast('正在读取文件夹…');
        const nested = await Promise.all(entries.map((en) => readEntry(en)));
        enqueueFiles(nested.flat());
      } else {
        enqueueFiles(e.dataTransfer.files);
      }
    });

    window.addEventListener('pagehide', () => {
      for (const p of state.peers.values()) {
        try {
          sendSignal({ t: 'bye', to: p.id });
        } catch {}
      }
    });
  }

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
        const next = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) {
              const nested = await Promise.all(all.map((e) => readEntry(e, path + entry.name + '/')));
              return resolve(nested.flat());
            }
            all.push(...entries);
            next();
          }, () => resolve([]));
        };
        next();
        return;
      }
      resolve([]);
    });
  }

  /* ------------------------------------------------------------------ *
   * 11. 启动
   * ------------------------------------------------------------------ */

  function boot() {
    initTheme();
    bind();
    try {
      if (localStorage.getItem('ld-auto') === '1') {
        els.autoReceive.checked = true;
        state.autoReceive = true;
      }
    } catch {}

    const codeParam = new URLSearchParams(location.search).get('code');
    if (/^\d{4}$/.test(codeParam || '')) {
      els.codeInput.value = codeParam;
      joinRoom(codeParam);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  // 调试/自检入口（只读快照，不影响功能）
  window.__landrop = { state, items: state.items };
})();
