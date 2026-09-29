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
//   chatAnnounce   (bool, default true)         start with "Resposta do Claude:" etc.
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
    chatVoiceMode: "yappable",
    chatAnnounce: true,
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
    elevenTextNormalization: "on"
  };
  const LANG_MODELS = /turbo_v2_5|flash_v2_5|eleven_v3/;
  const ELEVEN_TIMEOUT_MS = 30000;
  const MODEL_TIMEOUT_MS = 20000;
  const SITE_BUTTON_WAIT_MS = 5000;
  const NATIVE_CHUNK = 220; // Chrome drops long utterances; speak sentence chunks
  const CHARS_PER_SEC = 15; // rough speech pace at rate 1, for native seek/progress

  let cfg = { ...DEFAULTS, elevenKey: "" };

  const resolveLang = (l) => (l && l !== "auto" ? l : navigator.language || "en-US");
  const elevenKeyFrom = (local) => {
    const p = local.auth && local.auth.providers && local.auth.providers.elevenlabs;
    return (p && p.credential && p.credential.value) || local.elevenKey || "";
  };

  // Spoken before every reply: "Resposta do Claude:" (pt), "Claude's reply:" (en)...
  const PREFIXES = {
    pt: (s) => `Resposta do ${s}:`,
    en: (s) => `${s}'s reply:`,
    es: (s) => `Respuesta de ${s}:`,
    fr: (s) => `Réponse de ${s} :`,
    de: (s) => `Antwort von ${s}:`,
    it: (s) => `Risposta di ${s}:`
  };
  const prefixFor = (lang) => {
    if (!cfg.chatAnnounce) return "";
    const make = PREFIXES[String(lang || cfg.lang).split("-")[0].toLowerCase()] || PREFIXES.en;
    return make(adapter.name);
  };
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
    if (changes.lang || changes.chatAnnounce) syncPrefix();
    if (!active()) own.stop();
  });
  Player.onModeChange((m) => {
    cfg.chatVoiceMode = m;
    try { chrome.storage.sync.set({ chatVoiceMode: m }); } catch (_) {}
  });

  const active = () => cfg.enabled && cfg.chatNarration;
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
      try { speechSynthesis.cancel(); } catch (_) {}
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
        u.onend = u.onerror = () => resolve();
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
      speechSynthesis.cancel(); // current chunk resolves; loop replays nat.idx
    }

    async function playNative(text, lang, my) {
      const chunks = chunksOf(text);
      const starts = [];
      let acc = 0;
      for (const c of chunks) { starts.push(acc); acc += c.length + 1; }
      speechSynthesis.cancel();
      nat = { chunks, starts, total: acc, idx: 0, paused: false, restart: false, lang, charInChunk: 0 };
      Player.activate("own");
      await runNative(my);
    }

    // ---- ElevenLabs: real <audio>, so seek and pitch-preserving speed are exact ----
    async function playEleven(text, lang, my) {
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
      if (LANG_MODELS.test(cfg.elevenModel)) body.language_code = lang.split("-")[0];
      const ctrl = new AbortController();
      fetchCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), ELEVEN_TIMEOUT_MS);
      let buf;
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoiceId}?output_format=${cfg.elevenOutputFormat}`,
          {
            method: "POST",
            headers: { "xi-api-key": cfg.elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify(body),
            signal: ctrl.signal
          }
        );
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
        buf = await res.arrayBuffer();
      } finally {
        clearTimeout(timer);
        if (fetchCtrl === ctrl) fetchCtrl = null;
      }
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

    async function speak(text, lang) {
      stop(); // newest reply wins
      const my = epoch;
      if (cfg.engine === "elevenlabs" && cfg.elevenKey) {
        try { await playEleven(text, lang, my); return; }
        catch (_) { if (my !== epoch) return; } // fall through to the system voice
      }
      await playNative(text, lang, my);
    }

    const src = {
      id: "own",
      state() {
        if (audio) {
          return {
            active: true, paused: audio.paused, t: audio.currentTime || 0,
            dur: Number.isFinite(audio.duration) ? audio.duration : 0, rate: audio.playbackRate
          };
        }
        if (nat) {
          const pos = nat.starts[Math.min(nat.idx, nat.starts.length - 1)] + nat.charInChunk;
          return {
            active: true, paused: nat.paused, t: pos / CHARS_PER_SEC,
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
        else { nat.paused = true; speechSynthesis.cancel(); }
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
    return { speak, stop };
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
  async function readWithSiteVoice(el, text) {
    if (adapter.rewritable) {
      const out = await interpret(text);
      // "full" = keep the site's own text; the hook only adds the prefix.
      sendTts({ prefix: prefixFor(cfg.lang), override: out.via === "model" ? out.text : null, lang: out.lang });
    }
    if (adapter.readAloud) return adapter.readAloud(el);
    return clickSiteReadAloud(el);
  }

  Chat.watch({
    async onComplete(text, _key, el) {
      if (!active()) return;
      if (cfg.chatVoiceMode === "site" && await readWithSiteVoice(el, text)) return;
      const out = await interpret(text);
      if (!active()) return;
      const prefix = prefixFor(out.lang);
      own.speak(prefix ? `${prefix} ${out.text}` : out.text, out.lang);
    }
  });
})();
