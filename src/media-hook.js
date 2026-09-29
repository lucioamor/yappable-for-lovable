// ============================================================================
// media-hook.js — MAIN world, document_start. Makes the SITE's own TTS audio
// controllable (pause, ±seek, speed) from the extension's player modal.
//
// How each site plays its native "read aloud" (probed 2026-09-28):
//   chatgpt.com  detached <audio> fed by MediaSource (blob:). Seekable,
//                preservesPitch=true -> we just adopt the element.
//   claude.ai    Web Audio: ~100 ms PCM AudioBuffers scheduled back to back on
//                AudioBufferSourceNodes, arriving 2–3x faster than real time.
//                No element to control, so we CAPTURE the chunks (muting the
//                originals) and replay them through our own <audio> built from
//                a WAV blob — which gives seek + pitch-preserving speed.
//
// Bridge (window.postMessage, same origin):
//   page -> ext  { "yap-media": true, state: { active, paused, t, dur, rate, kind } }
//   ext -> page  { "yap-ctl": true, cmd: "toggle|play|pause|seek|rate|stop|config", value }
//                { "yap-ctl": true, cmd: "tts", value: { prefix?, override?, lang? } }
//
// TEXT REWRITING (claude.ai, gemini.google.com). Both sites send the text to
// read from the browser, so we can change it before it leaves:
//   claude.ai   WebSocket wss://…/text_to_speech/text_stream, frame
//               {"type":"text_chunk","text":"…"}.
//   gemini      batchexecute RPC XqA3Ic, args ["<voice>","<text>","<locale>",null,2].
//   chatgpt.com GET /backend-api/synthesize?message_id=… sends NO text (the
//               server reads the stored message), so it can't be rewritten.
// `prefix` (e.g. "Resposta do Claude:") is added to every read, including the
// user's own clicks on the site's button. `override` (a summary) replaces the
// text for the NEXT read only.
// ============================================================================
(() => {
  "use strict";
  if (window.__yapMediaHook) return;
  window.__yapMediaHook = true;

  const OUT = "yap-media";
  const IN = "yap-ctl";
  // Only short buffers are TTS stream chunks; longer ones (UI sounds) pass through.
  const CAPTURE_MAX_CHUNK_S = 0.5;
  const REBUILD_LOW_WATER_S = 1.5; // rebuild blob when this little is left to play
  const STREAM_IDLE_MS = 400; // no new chunk for this long = stream finished (so far)

  const origPlay = HTMLMediaElement.prototype.play;
  const origStart = AudioBufferSourceNode.prototype.start;

  let prefRate = 1;
  let target = null; // HTMLMediaElement currently controlled
  let userStopped = false;

  // ---- state out -----------------------------------------------------------
  // grok.com streams its read-aloud audio over plain HTTP without range support:
  // seekable is [0,0] (or [0,Infinity] while loading) and every seek jumps to 0.
  // Only seek when the element reports a real, finite seekable range.
  function canSeek(el) {
    try {
      return el.seekable.length > 0 && Number.isFinite(el.seekable.end(0)) && el.seekable.end(0) > 0;
    } catch (_) { return false; }
  }

  let emitQueued = false;
  function emit() {
    if (emitQueued) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      const el = target;
      const cap = capture && el === capture.el;
      const dur = cap ? capture.samples / capture.sampleRate : (el && el.duration);
      window.postMessage({
        [OUT]: true,
        state: el ? {
          active: !userStopped && !(el.ended && !(cap && capture.streaming())),
          paused: el.paused,
          t: el.currentTime || 0,
          dur: Number.isFinite(dur) ? dur : 0,
          rate: el.playbackRate,
          seekable: canSeek(el),
          kind: cap ? "site-webaudio" : "site-media"
        } : { active: false }
      }, location.origin);
    });
  }

  const EVENTS = ["play", "pause", "ratechange", "timeupdate", "ended", "durationchange", "seeked"];
  function adopt(el) {
    if (target === el) return;
    if (target) EVENTS.forEach((e) => target.removeEventListener(e, emit));
    target = el;
    userStopped = false;
    try { el.preservesPitch = true; } catch (_) {}
    el.defaultPlaybackRate = prefRate;
    el.playbackRate = prefRate;
    EVENTS.forEach((e) => el.addEventListener(e, emit));
    emit();
  }

  HTMLMediaElement.prototype.play = function (...args) {
    if (this instanceof HTMLAudioElement) { adopt(this); userStopped = false; }
    return origPlay.apply(this, args);
  };

  // ---- Web Audio capture (claude.ai) ----------------------------------------
  let capture = null;
  const silent = new WeakMap(); // ctx -> zero-gain node (keeps the app's clock running)
  const schedEnd = new WeakMap(); // ctx -> time the app's schedule would end
  const stoppedCtx = new WeakSet();

  function silentFor(ctx) {
    let g = silent.get(ctx);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = 0;
      g.connect(ctx.destination);
      silent.set(ctx, g);
    }
    return g;
  }

  function newCapture(ctx, sampleRate) {
    if (capture) capture.dispose();
    const el = new Audio();
    el.dataset.yapOwn = "1";
    const c = {
      ctx, sampleRate, el,
      chunks: [], samples: 0, built: 0, lastAt: Date.now(), url: null, wantPlay: true,
      streaming: () => Date.now() - c.lastAt < STREAM_IDLE_MS,
      dispose() {
        clearInterval(c.iv);
        try { el.pause(); } catch (_) {}
        if (c.url) URL.revokeObjectURL(c.url);
      }
    };
    el.addEventListener("pause", () => { if (!el.ended && !c.rebuilding) c.wantPlay = false; });
    el.addEventListener("play", () => { c.wantPlay = true; });
    el.addEventListener("ended", () => { if (c.samples > c.built) rebuild(c); });
    c.iv = setInterval(() => tick(c), 250);
    capture = c;
    return c;
  }

  function tick(c) {
    if (c !== capture || c.samples === c.built) return;
    const el = c.el;
    const first = c.built === 0;
    const buffered = c.samples / c.sampleRate;
    const left = (c.built / c.sampleRate) - (el.currentTime || 0);
    if (first ? (buffered >= 1 || !c.streaming()) : (left < REBUILD_LOW_WATER_S || !c.streaming())) {
      rebuild(c);
    }
  }

  function rebuild(c) {
    const el = c.el;
    const t = c.built ? el.currentTime : 0;
    const resume = c.wantPlay && !userStopped;
    c.built = c.samples;
    const url = URL.createObjectURL(encodeWav(c.chunks, c.samples, c.sampleRate));
    const old = c.url;
    c.url = url;
    c.rebuilding = true;
    el.addEventListener("loadedmetadata", () => {
      el.currentTime = Math.min(t, el.duration || t);
      c.rebuilding = false;
      if (old) URL.revokeObjectURL(old);
      if (resume) origPlay.call(el).catch(() => {});
      emit();
    }, { once: true });
    // Loading a new src resets playbackRate to defaultPlaybackRate (kept in sync).
    el.src = url;
    adopt(el);
  }

  function pushChunk(buf, ctx) {
    let c = capture;
    if (!c || c.ctx !== ctx || c.sampleRate !== buf.sampleRate) c = newCapture(ctx, buf.sampleRate);
    const n = buf.length;
    const mono = new Float32Array(n);
    const chs = buf.numberOfChannels;
    for (let ch = 0; ch < chs; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
    }
    c.chunks.push(mono);
    c.samples += n;
    c.lastAt = Date.now();
    emit();
  }

  AudioBufferSourceNode.prototype.start = function (when, ...rest) {
    const buf = this.buffer;
    const ctx = this.context;
    if (buf && buf.duration <= CAPTURE_MAX_CHUNK_S && ctx instanceof AudioContext) {
      try {
        // After a user stop, the rest of that stream stays muted and uncaptured.
        if (!stoppedCtx.has(ctx)) pushChunk(buf, ctx);
        const end = Math.max(schedEnd.get(ctx) || 0, (when || ctx.currentTime) + buf.duration);
        schedEnd.set(ctx, end);
        this.disconnect();
        this.connect(silentFor(ctx));
      } catch (_) { /* never break the site's audio */ }
    }
    return origStart.call(this, when, ...rest);
  };

  // The site's own pause/stop button suspends/closes its context. Mirror that,
  // but only when it happens BEFORE its schedule ends: a close at the natural
  // end must not stop our (possibly slower or rewound) playback.
  const early = (ctx) => ctx.currentTime < (schedEnd.get(ctx) || 0) - 0.2;
  const origSuspend = AudioContext.prototype.suspend;
  const origResume = AudioContext.prototype.resume;
  const origClose = AudioContext.prototype.close;
  AudioContext.prototype.suspend = function (...a) {
    if (capture && capture.ctx === this && early(this)) capture.el.pause();
    return origSuspend.apply(this, a);
  };
  AudioContext.prototype.resume = function (...a) {
    if (capture && capture.ctx === this && capture.el.paused && capture.built) origPlay.call(capture.el).catch(() => {});
    return origResume.apply(this, a);
  };
  AudioContext.prototype.close = function (...a) {
    if (capture && capture.ctx === this && early(this)) stop();
    return origClose.apply(this, a);
  };

  function encodeWav(chunks, samples, sr) {
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); w(8, "WAVE");
    w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, samples * 2, true);
    let o = 44;
    for (const ch of chunks) {
      for (let i = 0; i < ch.length; i++, o += 2) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---- TTS text rewriting -------------------------------------------------------
  const OVERRIDE_TTL_MS = 60000;
  const tts = { prefix: "", override: null, lang: "", at: 0 };

  // One-shot: consumed by the first request that uses it.
  function takeOverride() {
    if (tts.override == null || Date.now() - tts.at > OVERRIDE_TTL_MS) { tts.override = null; return null; }
    const o = { text: tts.override, lang: tts.lang };
    tts.override = null;
    return o;
  }
  const withPrefix = (text) => (tts.prefix ? `${tts.prefix} ${text}` : text);

  // claude.ai
  const wsState = new WeakMap(); // socket -> { n, replaced }
  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string" && /text_to_speech\/text_stream/.test(this.url || "")) {
      try {
        const m = JSON.parse(data);
        if (m && m.type === "text_chunk" && typeof m.text === "string") {
          const st = wsState.get(this) || { n: 0, replaced: false };
          wsState.set(this, st);
          if (st.n++ === 0) {
            const ov = takeOverride();
            st.replaced = !!ov;
            m.text = withPrefix(ov ? ov.text : m.text);
            return origWsSend.call(this, JSON.stringify(m));
          }
          if (st.replaced) return; // the summary was sent whole in the first chunk
        }
      } catch (_) { /* never break the site's TTS */ }
    }
    return origWsSend.call(this, data);
  };

  // gemini.google.com
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__yapTts = /batchexecute/.test(String(url)) && /[?&]rpcids=XqA3Ic\b/.test(String(url));
    return origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__yapTts && typeof body === "string") {
      try {
        const p = new URLSearchParams(body);
        const req = JSON.parse(p.get("f.req"));
        const call = req[0][0]; // ["XqA3Ic", "<json args>", null, "generic"]
        const args = JSON.parse(call[1]);
        if (typeof args[1] === "string") {
          const ov = takeOverride();
          args[1] = withPrefix(ov ? ov.text : args[1]);
          if (ov && ov.lang) args[2] = ov.lang;
          call[1] = JSON.stringify(args);
          p.set("f.req", JSON.stringify(req));
          body = p.toString();
        }
      } catch (_) { /* send the original request untouched */ }
    }
    return origXhrSend.call(this, body);
  };

  // ---- control in ------------------------------------------------------------
  function stop() {
    userStopped = true;
    if (target) { try { target.pause(); } catch (_) {} }
    if (capture) { stoppedCtx.add(capture.ctx); capture.dispose(); capture = null; }
    emit();
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data[IN] !== true) return;
    const { cmd, value } = e.data;
    if (cmd === "config") {
      if (Number.isFinite(value)) prefRate = value;
      return;
    }
    if (cmd === "tts" && value && typeof value === "object") {
      if (typeof value.prefix === "string") tts.prefix = value.prefix.trim();
      if (typeof value.override === "string" && value.override.trim()) {
        tts.override = value.override.trim();
        tts.lang = typeof value.lang === "string" ? value.lang : "";
        tts.at = Date.now();
      } else if (value.override === null) {
        tts.override = null;
      }
      return;
    }
    const el = target;
    if (!el) return emit();
    switch (cmd) {
      case "toggle":
        if (el.paused) origPlay.call(el).catch(() => {}); else el.pause();
        break;
      case "play": origPlay.call(el).catch(() => {}); break;
      case "pause": el.pause(); break;
      case "seek": {
        if (!canSeek(el)) break;
        const max = Number.isFinite(el.duration) ? el.duration : el.currentTime;
        el.currentTime = Math.max(0, Math.min(max, el.currentTime + Number(value || 0)));
        break;
      }
      case "rate":
        if (Number.isFinite(value)) { prefRate = value; el.defaultPlaybackRate = value; el.playbackRate = value; }
        break;
      case "stop": stop(); break;
    }
    emit();
  });
})();
