/*!
 * mqtt-lite.js — 极简 MQTT 3.1.1 over WebSocket 客户端（仅 QoS 0）
 * 只为本项目的「配对信令」服务：CONNECT / SUBSCRIBE / PUBLISH / PING。
 * 无依赖，约 200 行，浏览器与 Node 18+ 通用。
 */
(function (global) {
  'use strict';

  const CONNECT = 0x10;
  const CONNACK = 0x20;
  const PUBLISH = 0x30;
  const SUBSCRIBE = 0x82;
  const PINGREQ = 0xc0;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function encStr(str) {
    const b = enc.encode(str);
    const out = new Uint8Array(b.length + 2);
    out[0] = (b.length >> 8) & 0xff;
    out[1] = b.length & 0xff;
    out.set(b, 2);
    return out;
  }

  function encLen(len) {
    const out = [];
    do {
      let d = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) d |= 0x80;
      out.push(d);
    } while (len > 0);
    return out;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function packet(type, body) {
    return concat([new Uint8Array([type, ...encLen(body.length)]), body]);
  }

  class MqttLite {
    constructor(options = {}) {
      this.url = options.url || 'wss://broker.emqx.io:8084/mqtt';
      this.clientId = options.clientId || 'landrop_' + Math.random().toString(36).slice(2, 10);
      this.keepalive = options.keepalive || 30;
      this.connectTimeout = options.connectTimeout || 9000;
      this.buffer = new Uint8Array(0);
      this.packetId = 1;
      this.connected = false;
      this.closedByUser = false;
      this.handlers = new Map(); // topic -> fn
      this.ws = null;
    }

    connect() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve(this);
        };

        const timer = setTimeout(() => {
          try {
            this.close();
          } catch {}
          done(new Error('信令服务器连接超时'));
        }, this.connectTimeout);

        try {
          this.ws = new WebSocket(this.url, 'mqtt');
        } catch (e) {
          return done(new Error('无法建立信令通道：' + e.message));
        }
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          const flags = 0x02; // clean session
          const body = concat([
            encStr('MQTT'),
            new Uint8Array([4, flags, (this.keepalive >> 8) & 0xff, this.keepalive & 0xff]),
            encStr(this.clientId),
          ]);
          this._raw(packet(CONNECT, body));
        };

        this.ws.onmessage = (e) => {
          try {
            this._onData(new Uint8Array(e.data));
          } catch {}
        };

        this.ws.onerror = () => done(new Error('信令服务器连接失败'));

        this.ws.onclose = () => {
          clearInterval(this.pingTimer);
          const wasConnected = this.connected;
          this.connected = false;
          if (!wasConnected) done(new Error('信令通道被关闭'));
          else if (!this.closedByUser && this.onclose) this.onclose();
        };

        this._onConnected = () => done();
      });
    }

    subscribe(topic, handler) {
      this.handlers.set(topic, handler);
      const body = concat([new Uint8Array([(this.packetId >> 8) & 0xff, this.packetId & 0xff]), encStr(topic), new Uint8Array([0])]);
      this.packetId = (this.packetId % 60000) + 1;
      this._raw(packet(SUBSCRIBE, body));
    }

    publish(topic, message) {
      if (!this.connected) return false;
      const payload = typeof message === 'string' ? enc.encode(message) : message;
      this._raw(packet(PUBLISH, concat([encStr(topic), payload])));
      return true;
    }

    close() {
      this.closedByUser = true;
      clearInterval(this.pingTimer);
      try {
        if (this.ws && this.ws.readyState === 1) this._raw(new Uint8Array([0xe0, 0x00]));
        this.ws && this.ws.close();
      } catch {}
    }

    _raw(bytes) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
    }

    _onConnected() {}

    _onData(chunk) {
      this.buffer = concat([this.buffer, chunk]);
      for (;;) {
        const buf = this.buffer;
        if (buf.length < 2) return;
        const type = buf[0] & 0xf0;
        let len = 0;
        let mult = 1;
        let i = 1;
        let complete = false;
        for (; i < buf.length && i <= 4; i++) {
          const b = buf[i];
          len += (b & 0x7f) * mult;
          mult *= 128;
          if ((b & 0x80) === 0) {
            complete = true;
            i++;
            break;
          }
        }
        if (!complete) return; // 长度字段还没收全
        const total = i + len;
        if (buf.length < total) return; // 包还没收全

        const body = buf.slice(i, total);
        this.buffer = buf.slice(total);

        if (type === CONNACK) {
          this.connected = true;
          this.pingTimer = setInterval(() => this._raw(new Uint8Array([PINGREQ, 0x00])), this.keepalive * 700);
          this._onConnected();
        } else if (type === PUBLISH) {
          const tlen = (body[0] << 8) | body[1];
          const topic = dec.decode(body.slice(2, 2 + tlen));
          const payload = dec.decode(body.slice(2 + tlen));
          const fn = this.handlers.get(topic);
          if (fn) {
            try {
              fn(payload, topic);
            } catch {}
          }
        }
      }
    }
  }

  MqttLite.isSupported = () => typeof WebSocket !== 'undefined';

  if (typeof module === 'object' && module.exports) module.exports = MqttLite;
  global.MqttLite = MqttLite;
})(typeof window !== 'undefined' ? window : globalThis);
