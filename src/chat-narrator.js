// ============================================================================
// chat-narrator.js — reads finished ChatGPT / Claude / Gemini replies aloud.
//
// Separate from content.js on purpose: that file is coupled to Lovable's DOM
// (summaries, verbose progress, error toasts). Pipeline here:
//   YapChat.watch (chat-adapters.js) -> voice mode:
//     "site"     click the site's own read-aloud button (free, native voice);
//                media-hook.js + player-ui.js make it controllable. On Claude and
//                Gemini media-hook.js also rewrites the text the site sends to its
//                TTS: "<Site> reply:" prefix, and the summary when cfg.mode asks
//                for one. ChatGPT sends no text, so it always reads the full reply.
//     "yappable" interpretation (on-device Prompt API, by cfg.mode) ->
//                ElevenLabs if a key is set, else the system voice.
//   Both paths are driven by the same player modal (player-ui.js).
//
// Reuses the user's settings (engine, voice, lang, rate, volume, mode,
// ElevenLabs params + key). Extra keys in storage.sync:
//   chatNarration  (bool, default true)         master switch for chat sites
//   chatVoiceMode  ("yappable" | "site")        toggled from the modal
//   chatAnnouncementStyle ("concise" | "casual") mandatory spoken identity
//   <platform>VoiceId (string)                  optional ElevenLabs voice override
// The full text is always spoken: never add a length cap here.
// ============================================================================
(() => {
  "use strict";

  const Chat = globalThis.YapChat;
  const Player = globalThis.YapPlayer;
  const adapter = Chat && Chat.detect();
  if (!adapter || !Player) return;

  const DEFAULTS = {
    enabled: true,
    chatNarration: true,
    chatgptEnabled: true,
    claudeEnabled: true,
    geminiEnabled: true,
    grokEnabled: true,
    chatVoiceMode: "yappable",
    chatAnnounce: true, // retained for migration; identity is mandatory from 1.2 onward
    chatAnnouncementStyle: "concise",
    chatgptVoiceId: "",
    claudeVoiceId: "",
    geminiVoiceId: "",
    grokVoiceId: "",
    mode: "beginner", // fast | beginner | advanced | completo (shared with Lovable)
    engine: "native",
    lang: "auto",
    rate: 1.05,
    pitch: 1.0,
    volume: 1.0,
    nativeVoice: "",
    elevenVoiceId: "cgSgspJ2msm6clMCkdW9",
    elevenModel: "eleven_flash_v2_5",
    elevenOutputFormat: "mp3_44100_64",
    elevenStability: 0.2,
    elevenSimilarity: 0.2,
    elevenStyle: 0.5,
    elevenSpeed: 1.1,
    elevenTextNormalization: "auto"
  };
  const LANG_MODELS = /flash_v2_5|eleven_v3|eleven_v4/;
  const ELEVEN_TIMEOUT_MS = 30000;
  const MODEL_TIMEOUT_MS = 20000;
  const SITE_BUTTON_WAIT_MS = 5000;
  const NATIVE_CHUNK = 220; // Chrome drops long utterances; speak sentence chunks
  const CHARS_PER_SEC = 15; // rough speech pace at rate 1, for native seek/progress
  const PLAY_CONFIRM_MS = 400; // sound must last this long before it counts as "playing" for other tabs
  const MIN_READING_S = 2; // shorter clips are UI sounds, not a reading

  let cfg = { ...DEFAULTS, elevenKey: "" };

  const resolveLang = (l) => (l && l !== "auto" ? l : navigator.language || "en-US");
  const elevenKeyFrom = (local) => {
    const p = local.auth && local.auth.providers && local.auth.providers.elevenlabs;
    return (p && p.credential && p.credential.value) || local.elevenKey || "";
  };

  // Every reply identifies its source. This is intentionally not optional:
  // voices can be similar and several LLM tabs may finish close together.
  const PREFIXES = {
    concise: {
      pt: (s) => `Resposta do ${s}:`, en: (s) => `${s}'s reply:`,
      es: (s) => `Respuesta de ${s}:`, fr: (s) => `Réponse de ${s} :`,
      de: (s) => `Antwort von ${s}:`, it: (s) => `Risposta di ${s}:`
    },
    casual: {
      pt: (s) => `Oi, agora é o ${s} falando.`, en: (s) => `Hi, this is ${s} speaking.`,
      es: (s) => `Hola, ahora habla ${s}.`, fr: (s) => `Bonjour, ici ${s}.`,
      de: (s) => `Hallo, hier spricht ${s}.`, it: (s) => `Ciao, qui parla ${s}.`
    }
  };
  const prefixFor = (lang) => {
    const style = PREFIXES[cfg.chatAnnouncementStyle] || PREFIXES.concise;
    const make = style[String(lang || cfg.lang).split("-")[0].toLowerCase()] || style.en;
    return make(adapter.name);
  };
  const voiceForPlatform = () => cfg[`${adapter.id}VoiceId`] || cfg.elevenVoiceId;
  // media-hook.js lives in the page's MAIN world; talk to it over postMessage.
  const sendTts = (value) => window.postMessage({ "yap-ctl": true, cmd: "tts", value }, location.origin);
  const syncPrefix = () => { if (adapter.rewritable) sendTts({ prefix: prefixFor(cfg.lang) }); };

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    cfg = { ...cfg, ...stored, lang: resolveLang(stored.lang) };
    Player.setMode(cfg.chatVoiceMode);
    syncPrefix();
  });
  chrome.storage.local.get({ elevenKey: "", auth: null }, (local) => {
    cfg.elevenKey = elevenKeyFrom(local);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.auth || changes.elevenKey) {
        chrome.storage.local.get({ elevenKey: "", auth: null }, (local) => {
          cfg.elevenKey = elevenKeyFrom(local);
        });
      }
      return;
    }
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) {
      if (k === "elevenKey") continue;
      cfg[k] = k === "lang" ? resolveLang(v.newValue) : v.newValue;
    }
    if (changes.chatVoiceMode) Player.setMode(cfg.chatVoiceMode);
    if (changes.lang || changes.chatAnnouncementStyle) syncPrefix();
    // Turning narration off must silence every source, including the site's own voice.
    if (!active()) Player.stopAll();
  });
  Player.onModeChange((m) => {
    cfg.chatVoiceMode = m;
    try { chrome.storage.sync.set({ chatVoiceMode: m }); } catch (_) {}
  });

  const active = () => cfg.enabled && cfg.chatNarration && cfg[`${adapter.id}Enabled`] !== false;

  // Register completion immediately, then mark it ready only after local
  // interpretation / ElevenLabs generation. The background grants jobs FIFO.
  const audioQueue = (() => {
    let seq = 0;
    let port = null;
    let heartbeat = null;
    const waiting = new Map();
    const jobs = new Set();
    const updateHeartbeat = () => {
      if (jobs.size && port && !heartbeat) {
        heartbeat = setInterval(() => {
          try { port.postMessage({ type: "YAP_AUDIO_HEARTBEAT", jobId: "heartbeat", platform: adapter.id }); }
          catch (_) {}
        }, 20000);
      } else if ((!jobs.size || !port) && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    const connect = () => {
      if (port) return true;
      try {
        const next = chrome.runtime.connect({ name: "yappable-chat-audio" });
        port = next;
        next.onMessage.addListener((message) => {
          if (!message) return;
          if (message.type === "YAP_AUDIO_GRANTED") {
            const resolve = waiting.get(message.jobId);
            if (resolve) { waiting.delete(message.jobId); resolve(true); }
          } else if (message.type === "YAP_QUEUE") {
            Player.setQueue(message);
          } else if (message.type === "YAP_PAUSE_NOW") {
            // Another tab took the floor: pause (not stop) so this one can be resumed.
            Player.pauseAll();
          } else if (message.type === "YAP_RESUME_NOW") {
            Player.resume();
          }
        });
        next.onDisconnect.addListener(() => {
          if (port === next) port = null;
          updateHeartbeat();
          for (const resolve of waiting.values()) resolve(false);
          waiting.clear();
        });
        updateHeartbeat();
        // A fresh port (first load or after the worker restarted) knows nothing
        // about this tab: describe it and ask for the current queue.
        try { next.postMessage({ type: "YAP_HELLO", jobId: "hello", platform: adapter.id, state: reported }); } catch (_) {}
        return true;
      } catch (_) { port = null; return false; }
    };
    let reported = "idle";
    connect();

    const post = (type, jobId, extra) => {
      if (!port) return false;
      try { port.postMessage({ type, jobId, platform: adapter.id, ...extra }); return true; }
      catch (_) { return false; }
    };
    const enqueue = () => {
      connect();
      const jobId = `${adapter.id}-${Date.now()}-${++seq}`;
      jobs.add(jobId);
      updateHeartbeat();
      post("YAP_AUDIO_ENQUEUE", jobId);
      return {
        async ready() {
          if (!jobs.has(jobId)) return false;
          // Never trade the no-overlap guarantee for a best-effort local play.
          if (!port) return false;
          const granted = new Promise((resolve) => waiting.set(jobId, resolve));
          if (!post("YAP_AUDIO_READY", jobId)) { waiting.delete(jobId); return false; }
          return granted;
        },
        done() { jobs.delete(jobId); updateHeartbeat(); waiting.delete(jobId); post("YAP_AUDIO_DONE", jobId); },
        cancel() { jobs.delete(jobId); updateHeartbeat(); waiting.delete(jobId); post("YAP_AUDIO_CANCEL", jobId); }
      };
    };
    // This tab's audio state, whatever started it (a queued reply, the user's click
    // on the site's own button, or the modal). It is how the coordinator keeps a
    // single voice audible and knows what to pause when another tab starts.
    const playback = (state) => {
      reported = state;
      connect();
      post("YAP_PLAYBACK", "playback", { state });
    };
    const playNext = () => { connect(); post("YAP_AUDIO_PLAY_NEXT", "playnext"); };
    const cancelAll = () => {
      for (const jobId of jobs) post("YAP_AUDIO_CANCEL", jobId);
      jobs.clear();
      updateHeartbeat();
      for (const resolve of waiting.values()) resolve(false);
      waiting.clear();
    };
    return { enqueue, cancelAll, playback, playNext };
  })();

  // Report this tab's audio state to the coordinator. "playing" is confirmed only
  // after it lasts a moment and is not a short UI sound, so a notification ding
  // can never pause a reading in another tab.
  let playConfirm = null;
  Player.onPlayback((state) => {
    clearTimeout(playConfirm);
    if (state !== "playing") { audioQueue.playback(state); return; }
    playConfirm = setTimeout(() => {
      const st = Player.snapshot();
      if (!st.active || st.paused) return;
      if (st.dur && st.dur < MIN_READING_S) return;
      audioQueue.playback("playing");
    }, PLAY_CONFIRM_MS);
  });
  Player.onPlayNext(() => audioQueue.playNext());

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "LN_STOP_NOW") {
      audioQueue.cancelAll();
      Player.stopAll();
    }
  });
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

  // ---- interpretation layer (on-device) --------------------------------------
  const langName = (bcp47) => {
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(bcp47) || bcp47; }
    catch (_) { return bcp47; }
  };
  const PROMPT_BASE =
    "You turn a chatbot's reply into text that will be SPOKEN aloud. Return ONLY the speakable text: " +
    "no markdown, lists, code, or URLs (say 'a code example' or 'a link' instead). Turn lists and tables " +
    "into sentences. Invent nothing beyond the source. If the reply asks the user a question or needs a " +
    "decision, keep it. CRITICAL: write the entire output in {{LANG}}, regardless of the source language.";
  const PROMPT_DELTA = {
    fast: "Give only the direct answer or conclusion, in one or two sentences.",
    beginner: "Summarize in plain, everyday language: the answer first, then the key supporting points.",
    advanced: "Summarize keeping technical terms and numbers: the answer first, then the key points, no padding."
  };

  let detector = null;
  async function detectLang(text) {
    try {
      if (!("LanguageDetector" in self)) return cfg.lang;
      if (!detector) detector = await timeout(self.LanguageDetector.create(), MODEL_TIMEOUT_MS);
      // Detection only looks at a sample; this never shortens what is spoken.
      const [top] = await detector.detect(text.slice(0, 2000));
      if (!top || top.confidence < 0.6) return cfg.lang;
      const base = top.detectedLanguage.split("-")[0];
      return cfg.lang.split("-")[0] === base ? cfg.lang : top.detectedLanguage;
    } catch (_) { return cfg.lang; }
  }

  // Returns { text, lang }. Any model failure falls back to the full reply.
  async function interpret(text) {
    const delta = PROMPT_DELTA[cfg.mode];
    const full = async () => ({ text, lang: await detectLang(text), via: "full" });
    if (!delta || !("LanguageModel" in self)) return full(); // "completo" or no model
    let session = null;
    try {
      if ((await self.LanguageModel.availability()) !== "available") return full();
      const system = `${PROMPT_BASE.replace("{{LANG}}", langName(cfg.lang))} ${delta}`;
      session = await timeout(self.LanguageModel.create({ initialPrompts: [{ role: "system", content: system }] }), MODEL_TIMEOUT_MS);
      const out = String(await timeout(session.prompt(text), MODEL_TIMEOUT_MS) || "").trim();
      return out ? { text: out, lang: cfg.lang, via: "model" } : full();
    } catch (_) {
      return full();
    } finally {
      if (session) { try { session.destroy(); } catch (_) {} }
    }
  }

  // ---- own audio source (registered with the player) --------------------------
  const chunksOf = (text) => {
    const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
    const out = [];
    let buf = "";
    for (const p of parts) {
      if (buf && (buf + p).length > NATIVE_CHUNK) { out.push(buf.trim()); buf = ""; }
      buf += p;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  };

  const own = (() => {
    let epoch = 0;
    let audio = null; // ElevenLabs playback
    let nat = null; // { chunks, starts, total, idx, paused, restart, lang, charInChunk }
    let fetchCtrl = null;
    // speechSynthesis is shared by the whole browser: a cancel() from an idle tab
    // would silence a voice speaking in ANOTHER tab. Only cancel while this tab
    // has an utterance of its own in flight.
    let inFlight = 0;
    const cancelSpeech = () => { if (inFlight > 0) { try { speechSynthesis.cancel(); } catch (_) {} } };

    const pickVoice = (lang) => {
      const voices = speechSynthesis.getVoices();
      if (cfg.nativeVoice && lang === cfg.lang) {
        const v = voices.find((x) => x.name === cfg.nativeVoice);
        if (v) return v;
      }
      const norm = (l) => String(l || "").toLowerCase().replace(/_/g, "-");
      const want = norm(lang);
      const exact = voices.filter((v) => norm(v.lang) === want);
      const pool = exact.length ? exact : voices.filter((v) => norm(v.lang).split("-")[0] === want.split("-")[0]);
      return pool.find((v) => /google/i.test(v.name)) || pool[0] || null;
    };

    function stop() {
      epoch++;
      cancelSpeech();
      if (audio) { try { audio.pause(); } catch (_) {} audio = null; }
      if (fetchCtrl) { try { fetchCtrl.abort(); } catch (_) {} fetchCtrl = null; }
      nat = null;
      Player.render();
    }

    // ---- native (Web Speech): chunked, so seek/speed restart at a chunk ----
    function speakChunk(i, my) {
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(nat.chunks[i]);
        u.lang = nat.lang;
        u.rate = Math.min(10, cfg.rate * Player.rate());
        u.pitch = cfg.pitch;
        u.volume = cfg.volume;
        const v = pickVoice(nat.lang);
        if (v) u.voice = v;
        nat.charInChunk = 0;
        u.onboundary = (e) => { if (my === epoch && nat) nat.charInChunk = e.charIndex || 0; };
        let settled = false;
        const finish = () => { if (settled) return; settled = true; inFlight = Math.max(0, inFlight - 1); resolve(); };
        u.onend = u.onerror = finish;
        inFlight++;
        speechSynthesis.speak(u);
      });
    }

    async function runNative(my) {
      if (!nat) return;
      const loop = nat.loop = (nat.loop || 0) + 1; // a fast pause/resume must not run two loops
      while (my === epoch && nat && nat.idx < nat.chunks.length) {
        if (nat.paused) return;
        await speakChunk(nat.idx, my);
        if (my !== epoch || !nat || nat.loop !== loop) return;
        if (nat.restart) { nat.restart = false; continue; }
        if (nat.paused) return;
        nat.idx++;
      }
      if (my === epoch && nat) { nat = null; Player.render(); }
    }

    function restartNative() {
      nat.restart = true;
      cancelSpeech(); // current chunk resolves; loop replays nat.idx
    }

    async function playNative(text, lang, my) {
      const chunks = chunksOf(text);
      const starts = [];
      let acc = 0;
      for (const c of chunks) { starts.push(acc); acc += c.length + 1; }
      cancelSpeech();
      nat = { chunks, starts, total: acc, idx: 0, paused: false, restart: false, lang, charInChunk: 0 };
      Player.activate("own");
      await runNative(my);
    }

    // ---- ElevenLabs: generate before queue grant, play only after grant ---------
    async function fetchEleven(text, lang) {
      const body = {
        text,
        model_id: cfg.elevenModel,
        voice_settings: {
          stability: cfg.elevenStability,
          similarity_boost: cfg.elevenSimilarity,
          style: cfg.elevenStyle,
          speed: cfg.elevenSpeed,
          use_speaker_boost: false
        },
        apply_text_normalization: cfg.elevenTextNormalization || "auto"
      };
      if (cfg.elevenModel === "eleven_flash_v2_5" && body.apply_text_normalization === "on") {
        body.apply_text_normalization = "auto";
      }
      if (LANG_MODELS.test(cfg.elevenModel)) body.language_code = lang.split("-")[0];
      const ctrl = new AbortController();
      fetchCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), ELEVEN_TIMEOUT_MS);
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceForPlatform()}?output_format=${cfg.elevenOutputFormat}`,
          {
            method: "POST",
            headers: { "xi-api-key": cfg.elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify(body),
            signal: ctrl.signal
          }
        );
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
        return await res.arrayBuffer();
      } finally {
        clearTimeout(timer);
        if (fetchCtrl === ctrl) fetchCtrl = null;
      }
    }

    async function playElevenBuffer(buf, my) {
      if (my !== epoch) return;
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
      try {
        await new Promise((resolve, reject) => {
          const a = new Audio(url);
          audio = a;
          a.volume = cfg.volume;
          a.preservesPitch = true;
          a.defaultPlaybackRate = a.playbackRate = Player.rate();
          a.onended = () => resolve();
          a.onerror = () => reject(new Error("audio playback error"));
          a.onpause = () => { if (my !== epoch) resolve(); };
          Player.activate("own");
          a.play().catch(reject);
        });
      } finally {
        URL.revokeObjectURL(url);
        if (my === epoch) { audio = null; Player.render(); }
      }
    }

    async function prepare(text, lang) {
      let elevenBuffer = null;
      if (cfg.engine === "elevenlabs" && cfg.elevenKey) {
        try { elevenBuffer = await fetchEleven(text, lang); }
        catch (_) { elevenBuffer = null; } // fall through to the system voice
      }
      return async () => {
        stop();
        const my = epoch;
        if (elevenBuffer) await playElevenBuffer(elevenBuffer, my);
        else await playNative(text, lang, my);
      };
    }

    async function speak(text, lang) {
      const play = await prepare(text, lang);
      return play();
    }

    const src = {
      id: "own",
      state() {
        if (audio) {
          return {
            active: true, playing: !audio.paused && !audio.ended, paused: audio.paused, t: audio.currentTime || 0,
            dur: Number.isFinite(audio.duration) ? audio.duration : 0, rate: audio.playbackRate
          };
        }
        if (nat) {
          const pos = nat.starts[Math.min(nat.idx, nat.starts.length - 1)] + nat.charInChunk;
          return {
            active: true, playing: !nat.paused, paused: nat.paused, t: pos / CHARS_PER_SEC,
            dur: nat.total / CHARS_PER_SEC, rate: Player.rate()
          };
        }
        return { active: false };
      },
      toggle() {
        if (audio) { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); return; }
        if (!nat) return;
        // Pause = cancel + remember the chunk (speechSynthesis.pause is unreliable in Chrome).
        if (nat.paused) { nat.paused = false; runNative(epoch); }
        else { nat.paused = true; cancelSpeech(); }
      },
      pause() {
        if (audio) { audio.pause(); return; }
        if (nat && !nat.paused) { nat.paused = true; cancelSpeech(); }
      },
      seek(sec) {
        if (audio) {
          const max = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime;
          audio.currentTime = Math.max(0, Math.min(max, audio.currentTime + sec));
          return;
        }
        if (!nat) return;
        const target = nat.starts[nat.idx] + nat.charInChunk + sec * CHARS_PER_SEC;
        let i = nat.starts.findIndex((s, k) => target < (nat.starts[k + 1] ?? Infinity));
        i = Math.max(0, Math.min(nat.chunks.length - 1, i < 0 ? nat.chunks.length - 1 : i));
        nat.idx = i;
        if (!nat.paused) restartNative();
      },
      setRate(r) {
        if (audio) { audio.defaultPlaybackRate = r; audio.playbackRate = r; return; }
        if (nat && !nat.paused) restartNative(); // next utterance picks up Player.rate()
      },
      stop
    };
    Player.register(src);
    return { prepare, speak, stop };
  })();

  // ---- site voice ---------------------------------------------------------------
  const IDLE_LABEL = /^(read aloud|ler em voz alta|leer en voz alta|lire à voix haute|vorlesen|leggi ad alta voce|voorlezen)$/i;

  async function clickSiteReadAloud(el) {
    const until = Date.now() + SITE_BUTTON_WAIT_MS;
    while (Date.now() < until) {
      const b = adapter.readAloudButton && adapter.readAloudButton(el);
      if (b) {
        // Only click when it's idle; if it already reads, a click would pause it.
        if (IDLE_LABEL.test(b.getAttribute("aria-label") || "")) b.click();
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  // Click the site's own read-aloud. Where the hook can rewrite the request
  // (Claude, Gemini), first hand it the summary so the site reads that instead.
  async function readWithSiteVoice(el, out) {
    if (adapter.rewritable) {
      // "full" = keep the site's own text; the hook only adds the prefix.
      sendTts({ prefix: prefixFor(cfg.lang), override: out.via === "model" ? out.text : null, lang: out.lang });
    }
    if (adapter.readAloud) return adapter.readAloud(el);
    return clickSiteReadAloud(el);
  }

  async function waitForSitePlayback() {
    const startBy = Date.now() + 8000;
    while (Date.now() < startBy) {
      if (Player.state("site").active) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!Player.state("site").active) return;
    const endBy = Date.now() + 15 * 60 * 1000;
    while (Date.now() < endBy && Player.state("site").active) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  Chat.watch({
    async onComplete(text, _key, el) {
      if (!active()) return;
      const ticket = audioQueue.enqueue();
      try { globalThis.YapStats?.record(text, adapter.id); } catch (_) {}
      try {
        if (cfg.chatVoiceMode === "site") {
          const out = adapter.rewritable
            ? await interpret(text)
            : { text, lang: await detectLang(text), via: "full" };
          // ChatGPT and Grok send only a response id to their TTS endpoint, so
          // their text cannot be rewritten. Speak the mandatory identity first,
          // then hand the answer to the site's original voice.
          const announce = adapter.rewritable ? null : await own.prepare(prefixFor(out.lang), out.lang);
          if (!active() || !(await ticket.ready())) return;
          if (announce) await announce();
          if (!active()) return;
          if (await readWithSiteVoice(el, out)) await waitForSitePlayback();
          return;
        }

        const out = await interpret(text);
        const prefix = prefixFor(out.lang);
        const play = await own.prepare(`${prefix} ${out.text}`, out.lang);
        if (!active() || !(await ticket.ready())) return;
        await play();
      } finally {
        ticket.done();
      }
    }
  });
})();
