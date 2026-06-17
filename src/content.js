(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config (sincronizada com a página de opções via chrome.storage.sync)
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    enabled: true,
    engine: "native", // "native" | "elevenlabs"
    lang: "auto", // "auto" = detecta pelo navegador; fallback en-US (resolveLang)
    rate: 1.05,
    pitch: 1.0,
    volume: 1.0,
    nativeVoice: "", // nome exato da voz; vazio = melhor match por lang
    delayMs: 100, // pequeno settle do DOM antes do cue
    mode: "beginner", // fast | beginner | advanced | completo

    cueEnabled: true, // toca um som antes da narração
    cueFile: "assets/single-sound-message-icq-ooh.mp3",
    cueVolume: 0.5,

    // Alerta de ERRO do Lovable (toast "Try to fix" no #preview-panel).
    // Sinal distinto da "nova mensagem": bipe de atenção + chamado curto pra
    // que o usuário intervenha (o app não continua sem o clique).
    errorAlertEnabled: true,
    errorVolume: 0.4,

    // VERBOSE MODE (eixo independente da narração final): lê os placeholders de
    // progresso que o Lovable atualiza enquanto trabalha (a linha em
    // .text-muted-foreground + o cabeçalho de ação "Edited <arquivo>"). Toggle
    // separado: pode estar ligado mesmo com a narração final, ou sozinho.
    verboseEnabled: false,

    elevenKey: "",
    elevenVoiceId: "cgSgspJ2msm6clMCkdW9", // Jessica (default voice, expressiva/playful)
    elevenModel: "eleven_flash_v2_5",
    elevenOutputFormat: "mp3_44100_64", // query param output_format
    elevenStability: 0.2, // 0–1
    elevenSimilarity: 0.2, // similarity_boost 0–1
    elevenStyle: 0.5, // style exaggeration 0–1 (v2+)
    elevenSpeed: 1.1, // velocidade (REST 0.25–4.0)
    elevenSpeakerBoost: true, // use_speaker_boost
    elevenTextNormalization: "on", // auto | on | off
    elevenSeedRandom: true, // true = sem seed fixo
    elevenSeed: null // seed determinístico 0–4294967295
  };

  // modelos que aceitam language_code (Multilingual v2 auto-detecta)
  const LANG_MODELS = /turbo_v2_5|flash_v2_5|eleven_v3/;
  const langCode = (l) => (l || "").split("-")[0];
  // "auto" -> melhor match com o idioma do navegador; fallback en-US.
  const SUPPORTED_LANGS = [
    "pt-BR", "pt-PT", "en-US", "en-GB", "es-ES", "es-MX", "fr-FR", "de-DE",
    "it-IT", "nl-NL", "pl-PL", "ru-RU", "tr-TR", "ar-SA", "hi-IN", "ja-JP", "ko-KR", "zh-CN"
  ];
  function resolveLang(l) {
    if (l && l !== "auto") return l;
    const navs = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || ""];
    for (const nav of navs) {
      const n = String(nav).toLowerCase().replace(/_/g, "-");
      let hit = SUPPORTED_LANGS.find((c) => c.toLowerCase() === n);
      if (hit) return hit;
      const base = n.split("-")[0];
      hit = SUPPORTED_LANGS.find((c) => c.toLowerCase().split("-")[0] === base);
      if (hit) return hit;
    }
    return "en-US";
  }
  // Canal de diagnostico do popup: o content script publica o ultimo output
  // observado e responde a pedidos diretos da aba ativa.
  const LAST_OUTPUT_KEY = "lovableNarratorLastOutput";
  const MODES = ["fast", "beginner", "advanced", "completo"];
  // Migração: eixos antigos (announce × lens) e o par anterior (resumo/completo).
  // raw/full/technical → completo; resumo e os demais sabores curtos → beginner.
  const LEGACY_TO_MODE = {
    raw: "completo", full: "completo", technical: "completo",
    resumo: "beginner", summary: "beginner", title: "beginner",
    concise: "beginner", briefing: "beginner", body: "beginner"
  };
  const normalizeMode = (m) =>
    (MODES.includes(m) ? m : (LEGACY_TO_MODE[m] || DEFAULTS.mode));

  let cfg = { ...DEFAULTS };

  chrome.storage.sync.get({ ...DEFAULTS, mode: "", announce: "", lens: "" }, (stored) => {
    cfg = { ...DEFAULTS, ...stored };
    delete cfg.announce;
    delete cfg.lens;
    cfg.mode = normalizeMode(stored.mode || stored.announce);
    cfg.lang = resolveLang(cfg.lang); // "auto" -> idioma concreto
    cfg.elevenKey = ""; // loaded from local below
    if (stored.elevenKey) chrome.storage.sync.remove("elevenKey");
    if (stored.mode !== cfg.mode) chrome.storage.sync.set({ mode: cfg.mode });
    if (stored.announce || stored.lens) chrome.storage.sync.remove(["announce", "lens"]);
  });
  // elevenKey lives in storage.local (Fase 5 — keeps credentials off sync).
  chrome.storage.local.get({ elevenKey: "" }, (local) => {
    cfg.elevenKey = local.elevenKey || "";
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.elevenKey) cfg.elevenKey = changes.elevenKey.newValue || "";
      return;
    }
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) {
      if (k === "elevenKey") continue; // elevenKey is now in local, ignore sync
      if (k === "announce" || k === "lens") continue; // eixos antigos, ignorados
      if (k === "mode") cfg.mode = normalizeMode(v.newValue);
      else if (k === "lang") cfg.lang = resolveLang(v.newValue);
      else cfg[k] = v.newValue;
    }
    // trocou o idioma -> o summarizer foi criado p/ o idioma anterior; descarta e
    // re-aquece. (O Prompt API é lang-agnóstico: idioma vai no system prompt.)
    if (changes.lang && _summarizerLang && _summarizerLang !== cfg.lang) {
      summarizer = null;
      _summarizerLang = null;
      summarizerDead = false;
      warmupSummarizer();
    }
    // desligou "narrar conclusões" -> para a fala imediatamente
    if (changes.enabled && changes.enabled.newValue === false) {
      stopSpeaking();
      try { clearPreview(); } catch (_) {}
    }
    // trocou o modo de narração -> atualiza o preview no chat
    if (changes.mode) {
      try { showPreview(); } catch (_) {}
    }
  });

  // ---------------------------------------------------------------------------
  // Fila de fala (uma thread global; evita falas embaralhadas)
  // ---------------------------------------------------------------------------
  const queue = [];
  let speaking = false;
  let audioUnlocked = false;
  let ready = false; // só narra via observer depois do baseline (evita ler histórico no load)
  let currentAudio = null; // <audio> ElevenLabs em andamento (p/ poder parar)
  let currentCue = null;   // <audio> do som de cue (p/ garantir 1 áudio por vez)
  let playbackEpoch = 0;   // invalida awaits antigos quando a fala é interrompida

  // ---------------------------------------------------------------------------
  // Waveform de telemetria (Web Audio API) — barra animada no topo do chat
  // durante a fala. Verde simulado para nativo; lilás real (FFT) para ElevenLabs.
  // ---------------------------------------------------------------------------
  let _wfEl = null, _wfCanvas = null, _wfCtx = null;
  let _wfAnimId = null, _wfAudioCtx = null, _wfAnalyser = null;

  function _wfEnsure() {
    if (_wfEl) return;
    _wfEl = document.createElement("div");
    _wfEl.id = "__ln_wf";
    Object.assign(_wfEl.style, {
      position: "fixed", top: "0", left: "0", right: "0", height: "32px",
      zIndex: "2147483645", pointerEvents: "none",
      background: "linear-gradient(to bottom, rgba(17,17,27,.88) 0%, transparent 100%)",
      opacity: "0", transition: "opacity .25s ease"
    });
    _wfCanvas = document.createElement("canvas");
    _wfCanvas.height = 32;
    Object.assign(_wfCanvas.style, { display: "block", height: "32px", width: "100%" });
    _wfEl.appendChild(_wfCanvas);
    (document.body || document.documentElement).appendChild(_wfEl);
    function _resizeWf() {
      if (_wfCanvas && _wfEl) _wfCanvas.width = _wfEl.offsetWidth || window.innerWidth;
    }
    _resizeWf();
    window.addEventListener("resize", _resizeWf, { passive: true });
  }

  function _wfShow() { _wfEnsure(); _wfEl.style.opacity = "1"; }

  function _wfHide() {
    if (_wfEl) _wfEl.style.opacity = "0";
    if (_wfAnimId) { cancelAnimationFrame(_wfAnimId); _wfAnimId = null; }
    _wfAnalyser = null;
  }

  function _wfDrawSimulated() {
    if (!_wfCtx || !_wfCanvas) return;
    const w = _wfCanvas.width, h = _wfCanvas.height;
    _wfCtx.clearRect(0, 0, w, h);
    const bars = 48, gap = w / bars, bw = Math.max(1, gap * 0.45);
    const t = Date.now() / 190;
    _wfCtx.fillStyle = "rgba(166,227,161,.72)";
    for (let i = 0; i < bars; i++) {
      const amp = (Math.sin(t + i * 0.58) * 0.38 + 0.5 + Math.sin(t * 1.25 + i * 1.05) * 0.12);
      const bh = Math.max(2, amp * h * 0.76);
      _wfCtx.fillRect(i * gap + gap / 2 - bw / 2, (h - bh) / 2, bw, bh);
    }
    _wfAnimId = requestAnimationFrame(_wfDrawSimulated);
  }

  function _wfDrawReal() {
    if (!_wfCtx || !_wfCanvas || !_wfAnalyser) { _wfAnimId = null; return; }
    const w = _wfCanvas.width, h = _wfCanvas.height;
    const bufLen = _wfAnalyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    _wfAnalyser.getByteFrequencyData(data);
    _wfCtx.clearRect(0, 0, w, h);
    const bars = Math.min(48, bufLen), gap = w / bars, bw = Math.max(1, gap * 0.45);
    _wfCtx.fillStyle = "rgba(203,166,247,.85)";
    for (let i = 0; i < bars; i++) {
      const v = data[Math.floor(i * bufLen / bars)] / 255;
      const bh = Math.max(2, v * h * 0.88);
      _wfCtx.fillRect(i * gap + gap / 2 - bw / 2, (h - bh) / 2, bw, bh);
    }
    _wfAnimId = requestAnimationFrame(_wfDrawReal);
  }

  function _wfStartNative() {
    _wfEnsure();
    _wfCtx = _wfCanvas.getContext("2d");
    if (_wfAnimId) { cancelAnimationFrame(_wfAnimId); _wfAnimId = null; }
    _wfAnalyser = null;
    _wfShow();
    _wfDrawSimulated();
  }

  function _wfStartEleven(audioEl) {
    _wfEnsure();
    _wfCtx = _wfCanvas.getContext("2d");
    if (_wfAnimId) { cancelAnimationFrame(_wfAnimId); _wfAnimId = null; }
    _wfShow();
    try {
      if (!_wfAudioCtx) _wfAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_wfAudioCtx.state === "suspended") _wfAudioCtx.resume();
      // CRÍTICO: só roteia o <audio> pelo AudioContext se ele estiver REALMENTE
      // tocando. Um contexto "suspended" (autoplay — sem gesto na página) engole
      // o áudio roteado e a narração fica MUDA, sem erro. Nesse caso deixa o
      // elemento tocar direto (saída padrão) e usa a waveform simulada.
      // createMediaElementSource é irreversível por elemento — a decisão é aqui.
      if (_wfAudioCtx.state !== "running") {
        _wfAnalyser = null;
        _wfDrawSimulated();
        return;
      }
      const src = _wfAudioCtx.createMediaElementSource(audioEl);
      _wfAnalyser = _wfAudioCtx.createAnalyser();
      _wfAnalyser.fftSize = 128;
      src.connect(_wfAnalyser);
      _wfAnalyser.connect(_wfAudioCtx.destination);
      _wfDrawReal();
    } catch (_) {
      _wfAnalyser = null;
      _wfDrawSimulated();
    }
  }

  // ---------------------------------------------------------------------------
  // Cache de áudio ElevenLabs (ArrayBuffer por hash do texto + parâmetros de voz)
  // Evita re-chamada para briefings repetidos (ex.: reload da página).
  // ---------------------------------------------------------------------------
  const _audioCache = new Map(); // key -> ArrayBuffer
  const AUDIO_CACHE_MAX = 15;

  function _audioCacheKey(text, vSettings) {
    return JSON.stringify({ t: text, ...vSettings });
  }

  // para tudo: limpa fila, cancela TTS nativo e o áudio ElevenLabs atual
  function stopSpeaking() {
    playbackEpoch++;
    queue.length = 0;
    try { speechSynthesis.cancel(); } catch (_) {}
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (_) {}
      currentAudio = null;
    }
    if (currentCue) {
      try { currentCue.pause(); currentCue.currentTime = 0; } catch (_) {}
      currentCue = null;
    }
    _wfHide();
    speaking = false;
  }

  function playbackCurrent(epoch) {
    return epoch === playbackEpoch && cfg.enabled;
  }

  // FILA ÚNICA DE ÁUDIO: TODO som da extensão (cue, narração final, progresso,
  // monitor de silêncio, alerta de erro) passa por aqui. Um item por vez; o
  // próximo só começa quando o anterior TERMINA (onended/onend — não precisamos
  // saber a duração de antemão). Isso elimina vozes/cues sobrepostos.
  // meta.kind: "final" (narração de conclusão, com cue + highlight)
  //          | "transient" (progresso/monitor/erro — single-slot, sem cue)
  function enqueue(text, el, meta) {
    if (!text) return;
    queue.push({ text, el, meta });
    drain();
  }

  // remove itens transientes pendentes: só o estado mais recente importa
  // (a fala não pode ficar atrasada em relação ao que está na tela).
  function dropTransient() {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].meta && queue[i].meta.kind === "transient") queue.splice(i, 1);
    }
  }

  async function drain() {
    if (speaking || !queue.length) return;
    speaking = true;
    const epoch = playbackEpoch;
    const { text, el, meta } = queue.shift();
    try {
      // Cue faz parte do MESMO slot da fila: nada toca por cima dele e ele
      // nunca toca em paralelo com outra fala.
      if (meta && meta.cue) {
        await playCue(epoch);
        if (!playbackCurrent(epoch)) return;
      }
      // Motor é absoluto: ElevenLabs (com key) narra tudo; senão, nativa.
      const useEleven = cfg.engine === "elevenlabs" && cfg.elevenKey;
      if (useEleven) await speakEleven(text, epoch);
      else await speakNative(text);
    } catch (err) {
      if (!playbackCurrent(epoch)) return;
      console.warn("[Yappable] speech failed, native fallback:", err);
      _wfHide();
      try { await speakNative(text); } catch (_) {}
    }
    if (!playbackCurrent(epoch)) return;
    if (meta && meta.kind === "final") markRead(el); // narração terminou: rosa escuro
    speaking = false;
    drain();
  }

  // --- TTS nativo (Web Speech API) ---
  // normaliza tag de idioma: "pt_BR" / "pt-br" -> "pt-br"
  const normLang = (l) => String(l || "").toLowerCase().replace(/_/g, "-");

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    if (cfg.nativeVoice) {
      const exact = voices.find((v) => v.name === cfg.nativeVoice);
      if (exact) return exact;
    }

    const want = normLang(cfg.lang); // ex.: "pt-br"
    const base = want.split("-")[0]; // ex.: "pt"

    // 1) REGIÃO EXATA (pt-BR): jamais cai em pt-PT se houver pt-BR.
    const exactRegion = voices.filter((v) => normLang(v.lang) === want);
    // 2) mesmo idioma, qualquer região (pt-PT, etc.) — só se não houver exata.
    const sameBase = voices.filter((v) => normLang(v.lang).split("-")[0] === base);

    // dentro de cada grupo: Google > Microsoft/Natural > primeira.
    // Brasil também costuma vir como "(Brazil)"/"brasil" no nome.
    const pick = (list) =>
      list.find((v) => /google/i.test(v.name) && /bra[sz]il/i.test(v.name)) ||
      list.find((v) => /google/i.test(v.name)) ||
      list.find((v) => /microsoft|natural/i.test(v.name)) ||
      list[0];

    return pick(exactRegion) || pick(sameBase) || voices[0];
  }

  // ref global: sem isso o Chrome pode GC a utterance no meio e a fala "loopa"/repete
  let currentUtterance = null;
  let keepAlive = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function speakNative(text) {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) return reject(new Error("sem speechSynthesis"));
      // limpa qualquer fala pendente (evita empilhar/repetir)
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      currentUtterance = u; // mantém ref viva
      u.lang = cfg.lang;
      u.rate = cfg.rate;
      u.pitch = cfg.pitch;
      u.volume = cfg.volume;
      const v = pickVoice();
      if (v) u.voice = v;
      const cleanup = () => {
        _wfHide();
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        currentUtterance = null;
      };
      u.onend = () => { cleanup(); resolve(); };
      u.onerror = (e) => { cleanup(); reject(e.error || new Error("speech error")); };
      // keepalive: Chrome corta fala >~15s; pause+resume evita o corte e o restart
      keepAlive = setInterval(() => {
        if (!speechSynthesis.speaking) { clearInterval(keepAlive); keepAlive = null; return; }
        speechSynthesis.pause();
        speechSynthesis.resume();
      }, 10000);
      _wfStartNative();
      speechSynthesis.speak(u);
    });
  }

  // --- TTS ElevenLabs ---
  async function speakEleven(text, epoch) {
    const fmtParam = cfg.elevenOutputFormat || "mp3_44100_64";
    const sendText = text;
    const voiceSettings = {
      stability: cfg.elevenStability,
      similarity_boost: cfg.elevenSimilarity,
      style: cfg.elevenStyle,
      speed: cfg.elevenSpeed,
      use_speaker_boost: cfg.elevenSpeakerBoost
    };
    const body = {
      text: sendText,
      model_id: cfg.elevenModel,
      voice_settings: voiceSettings,
      apply_text_normalization: cfg.elevenTextNormalization || "auto"
    };
    if (LANG_MODELS.test(cfg.elevenModel)) body.language_code = langCode(cfg.lang);
    if (!cfg.elevenSeedRandom && cfg.elevenSeed != null) body.seed = cfg.elevenSeed;

    // Cache: evita re-chamada para texto + parâmetros idênticos (ex.: reload).
    const cacheKey = _audioCacheKey(sendText, {
      v: cfg.elevenVoiceId, m: cfg.elevenModel, f: fmtParam,
      st: voiceSettings.stability, si: voiceSettings.similarity_boost,
      sy: voiceSettings.style, sp: voiceSettings.speed, b: voiceSettings.use_speaker_boost,
      ln: LANG_MODELS.test(cfg.elevenModel) ? langCode(cfg.lang) : "",
      tn: body.apply_text_normalization,
      sr: !!cfg.elevenSeedRandom,
      seed: cfg.elevenSeedRandom ? null : body.seed
    });
    let audioBuffer = _audioCache.get(cacheKey);
    if (!audioBuffer) {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoiceId}?output_format=${fmtParam}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": cfg.elevenKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg"
          },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
      audioBuffer = await res.arrayBuffer();
      if (_audioCache.size >= AUDIO_CACHE_MAX) {
        _audioCache.delete(_audioCache.keys().next().value);
      }
      _audioCache.set(cacheKey, audioBuffer);
    }
    if (epoch != null && !playbackCurrent(epoch)) return;

    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    let audio = null;
    await new Promise((resolve, reject) => {
      if (epoch != null && !playbackCurrent(epoch)) return resolve();
      audio = new Audio(url);
      currentAudio = audio; // ref global p/ stopSpeaking()
      audio.volume = cfg.volume;
      _wfStartEleven(audio);
      audio.onended = () => { _wfHide(); resolve(); };
      audio.onpause = () => {
        if (epoch != null && !playbackCurrent(epoch)) {
          _wfHide();
          resolve();
        }
      };
      audio.onerror = () => { _wfHide(); reject(new Error("audio play error")); };
      audio.play().catch((err) => { _wfHide(); reject(err); });
    }).finally(() => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; });
  }

  // ---------------------------------------------------------------------------
  // Extração: detectar mensagem do agente concluída
  // Âncoras semânticas (sobrevivem a rebuild de CSS):
  //   [data-message-id], button[aria-label="Copy message"], .prose-chat
  // ---------------------------------------------------------------------------
  // id -> texto já narrado. Map (não Set) porque a MESMA caixa (#ast) muda de
  // conteúdo: "começando a rodar" -> texto final. Dedup por conteúdo deixa o
  // update final re-disparar; dedup só por id travaria no início.
  const spoken = new Map();
  const msgKey = (data) => cleanText([data.taskTitle, data.body].filter(Boolean).join("\n"));
  const allowActiveTaskRead = () => normalizeMode(cfg.mode) === "completo";

  function cleanText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function cleanBlockText(s) {
    return String(s || "")
      .replace(/\r/g, "\n")
      .replace(/ /g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function stripInlineNoise(s) {
    return String(s || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " link ")
      .replace(/[*_#`>]/g, " ");
  }

  function stripUnwantedNarration(s) {
    return String(s || "")
      .replace(/\bMexeu em layout ou responsividade,?\s+mas n[aã]o h[aá] men[cç][aã]o de valida[cç][aã]o visual\.?\s*/gi, " ")
      .replace(/\bConfira em mobile e desktop antes de publicar\.?\s*/gi, " ")
      .replace(/\bLayout or responsiveness was touched,?\s+but there'?s no mention of visual validation\.?\s*/gi, " ")
      .replace(/\bCheck on mobile and desktop before shipping\.?\s*/gi, " ");
  }

  // tira ruído de markdown/UI antes do TTS (e antes de decidir resumir).
  // Camada determinística: melhora a fala mais que pedir tudo à LLM.
  function cleanForSpeech(s) {
    return cleanText(
      stripUnwantedNarration(s)
        .replace(/```[\s\S]*?```/g, " ") // blocos de código
        .replace(/`[^`]*`/g, " ") // inline code
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // imagens markdown
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links [txt](url) -> txt
        .replace(/https?:\/\/\S+/g, " link ") // urls cruas
        .replace(/^[\s>#*+-]+/gm, " ") // marcadores de lista/heading/quote no início da linha
        .replace(/[*_#`>]/g, " ") // restos de markdown
    );
  }

  // lê os campos de uma mensagem (sem dedup nem gating) — usado por
  // qualifies (gating de narração) e pickLastCompleted (preview de highlight)
  function normalizeSpeechTokens(s, style = "compact") {
    let out = String(s || "")
      .replace(/\s*→\s*/g, " para ")
      .replace(/\s*—\s*/g, " - ")
      .replace(/~\s*/g, "aproximadamente ")
      .replace(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*s\b/gi, "$1 a $2 segundos")
      .replace(/(\d+(?:[.,]\d+)?)\s*s\b/gi, "$1 segundos");

    if (style === "natural") {
      out = out
        .replace(/(\d+(?:[.,]\d+)?)\s*MB\b/gi, "$1 megabytes")
        .replace(/(\d+(?:[.,]\d+)?)\s*KB\b/gi, "$1 quilobytes");
    } else {
      out = out
        .replace(/(\d+(?:[.,]\d+)?)\s*MB\b/gi, "$1 megas")
        .replace(/(\d+(?:[.,]\d+)?)\s*KB\b/gi, "$1 ká")
        .replace(/(\d+[.,]\d+)\s+megas\b/gi, "$1 mega")
        .replace(/\b1\s+megas\b/gi, "1 mega");
    }
    return cleanText(out);
  }

  function cleanForNarration(s, style = "natural") {
    return normalizeSpeechTokens(
      cleanText(stripInlineNoise(stripUnwantedNarration(s)).replace(/^[\s>+-]+/gm, " ")),
      style
    );
  }

  function readProseStructure(proseEl) {
    const structure = { intro: "", sections: [], expected: "" };
    if (!proseEl) return structure;
    let current = null;

    for (const child of [...proseEl.children]) {
      const tag = child.tagName;
      const text = cleanBlockText(child.innerText || child.textContent || "");
      if (!text) continue;

      if (/^Esperado:/i.test(text)) {
        structure.expected = text;
        continue;
      }

      if (/^H[1-6]$/.test(tag) || isStrongParagraph(child, text)) {
        current = { title: text, items: [] };
        structure.sections.push(current);
        continue;
      }

      if (tag === "UL" || tag === "OL") {
        const items = [...child.querySelectorAll("li")]
          .map((li) => cleanBlockText(li.innerText || li.textContent || ""))
          .filter(Boolean);
        if (!current) {
          current = { title: "", items: [] };
          structure.sections.push(current);
        }
        current.items.push(...items);
        continue;
      }

      // Primeiro bloco de texto (antes de qualquer seção) = intro.
      if (!structure.intro && !structure.sections.length) {
        structure.intro = text;
        continue;
      }
      // Parágrafo de conteúdo — inclui o caso <p><strong>chamada</strong> corpo…</p>,
      // em que o <strong> NÃO é o parágrafo inteiro. Antes isso caía no vão e era
      // descartado (perdendo o corpo de cada ponto). Agora vira item da seção
      // corrente; sem seção ainda, abre uma sem título. Nunca descarta.
      if (!current) {
        current = { title: "", items: [] };
        structure.sections.push(current);
      }
      current.items.push(text);
    }

    if (!structure.intro || !structure.expected || !structure.sections.length) {
      fillStructureFromLines(structure, cleanBlockText(proseEl.innerText || ""));
    }
    return structure;
  }

  function isStrongParagraph(el, text) {
    if (el.tagName !== "P") return false;
    const strong = el.querySelector(":scope > strong");
    return !!strong && cleanText(strong.innerText || strong.textContent || "") === cleanText(text);
  }

  function fillStructureFromLines(structure, body) {
    const lines = cleanBlockText(body).split(/\n+/).map(cleanText).filter(Boolean);
    let current = structure.sections[structure.sections.length - 1] || null;
    for (const line of lines) {
      if (/^Esperado:/i.test(line)) {
        if (!structure.expected) structure.expected = line;
        continue;
      }
      if (!structure.intro && /^(Mudanças|Feito|Conclu)/i.test(line)) {
        structure.intro = line;
        continue;
      }
      if (looksLikeSectionTitle(line)) {
        if (structure.sections.some((sct) => cleanText(sct.title) === line)) continue;
        current = { title: line, items: [] };
        structure.sections.push(current);
        continue;
      }
      if (current && !current.items.includes(line)) current.items.push(line.replace(/^[-*]\s*/, ""));
    }
  }

  function looksLikeSectionTitle(line) {
    if (!line || /^[-*]/.test(line) || /^Esperado:/i.test(line) || line.length > 70) return false;
    return /\b(LCP|Preload|Outros|Arquivos|Correções|Mudanças|Imagens|Performance)\b/i.test(line);
  }

  function readMessage(msgEl) {
    const titleEl = msgEl.querySelector('[aria-label^="Open background task"]') || null;
    const taskTitle = cleanText(titleEl?.getAttribute("title") || titleEl?.textContent || "");
    const proseEl = [...msgEl.querySelectorAll(".prose-chat")]
      .filter((p) => {
        const st = getComputedStyle(p);
        return st.opacity !== "0" && st.display !== "none" && cleanText(p.innerText).length > 0;
      })
      .pop() || null;
    // Fonte do corpo: o atributo data-message-copy-text — o texto limpo e ÍNTEGRO
    // que o Lovable usa no botão "Copiar mensagem". Só existe quando a mensagem
    // terminou (mesma barra de ações do "Copy message", que já é o nosso gate).
    // É âncora semântica (sobrevive a rebuild de CSS) e captura TODOS os
    // parágrafos — inclusive os <p><strong>chamada</strong><span>corpo</span></p>
    // que a extração por tag/heading descartava. Fallback: innerText do prose.
    const copyAttr =
      msgEl.querySelector("[data-message-copy-text]")?.getAttribute("data-message-copy-text") || "";
    const body = copyAttr
      ? cleanBlockText(copyAttr)
      : (proseEl ? cleanBlockText(proseEl.innerText) : "");
    const structure = readProseStructure(proseEl);
    return { titleEl, taskTitle, proseEl, body, structure };
  }

  // detecta se a mensagem é uma resposta do Lovable JÁ concluída e ainda não
  // narrada. SEM efeito colateral (não marca spoken) — quem narra é quem commita.
  function qualifies(msgEl) {
    const id = msgEl.getAttribute("data-message-id");
    if (!id) return null;

    // só respostas do Lovable (id contém #ast:<hash>); ignora as minhas (#usr:<hash>)
    if (!/#ast:/.test(id)) return null;
    if (msgEl.querySelector('[data-current-user="true"]')) return null;
    // gate: só completa quando a barra de ações renderizou
    if (!msgEl.querySelector('button[aria-label="Copy message"]')) return null;
    const data = readMessage(msgEl);
    const hasActiveTask = !!msgEl.querySelector(".animate-shimmer-gradient");
    if (hasActiveTask) return null;
    if (!data.taskTitle && !data.body) return null;
    // dedup por CONTEÚDO: se já narrei exatamente este texto pra este id, ignora.
    // Se o texto mudou (início -> final na mesma caixa), re-narra o final.
    if (spoken.get(id) === msgKey(data)) return null;
    return { id, el: msgEl, ...data };
  }

  // Lista virtualizada do Lovable: cada turno vive num wrapper com
  // position:absolute + style.top — a ordem do DOM NÃO garante ordem
  // cronológica (React remonta nós fora de ordem). O maior `top` é sempre a
  // mensagem mais recente, então a ordenação canônica é por top, com a ordem
  // do DOM como desempate (mensagens sem wrapper posicionado).
  function topOf(el) {
    let n = el;
    while (n && n !== document.body) {
      const t = n.style && n.style.top;
      if (t) {
        const v = parseFloat(t);
        if (!Number.isNaN(v)) return v;
      }
      n = n.parentElement;
    }
    return -1;
  }

  // Mensagens do agente (#ast) em ordem cronológica garantida.
  function agentMessages() {
    return [...document.querySelectorAll('[data-message-id*="#ast:"]')]
      .map((el, i) => ({ el, top: topOf(el), i }))
      .sort((a, b) => (a.top - b.top) || (a.i - b.i))
      .map((x) => x.el);
  }

  // Âncora primária: .active-turn é o container do turno corrente — sempre
  // contém a resposta em curso/recém-concluída do agente. Mais barato e mais
  // confiável que varrer o chat inteiro.
  function activeTurnAgentMessage() {
    const turn = document.querySelector(".active-turn");
    if (!turn) return null;
    const msgs = turn.querySelectorAll('[data-message-id*="#ast:"]');
    return msgs.length ? msgs[msgs.length - 1] : null;
  }

  // Devolve candidata SÓ se a ÚLTIMA mensagem do agente ainda não foi narrada.
  // CRÍTICO: considera só a mais recente — NUNCA anda pra trás pelo histórico.
  // Se a última já foi falada -> null (mesmo havendo antigas pendentes).
  // Isso mata o loop "relê do começo": narra só a nova que entrou.
  function newestQualifying() {
    const active = activeTurnAgentMessage();
    if (active) return qualifies(active);
    const msgs = agentMessages();
    return msgs.length ? qualifies(msgs[msgs.length - 1]) : null;
  }

  // varre o chat do mais recente pro mais antigo e devolve a última mensagem
  // concluída (sem dedup) — base do preview de highlight e do reload
  function pickLastCompleted(allowActiveTask = false) {
    const msgs = agentMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.querySelector('[data-current-user="true"]')) continue;
      if (!m.querySelector('button[aria-label="Copy message"]')) continue;
      const d = readMessage(m);
      if (m.querySelector(".animate-shimmer-gradient") && !(allowActiveTask && d.taskTitle)) continue;
      if (d.taskTitle || d.body) {
        return { id: m.getAttribute("data-message-id"), el: m, ...d };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // IR cache — uma IR por mensagem; evita reconstrução em cada chamada.
  // ---------------------------------------------------------------------------
  let cachedIR = null; // { key, ir }

  function getOrBuildIR(result) {
    if (!result) return null;
    const key = `${result.id || ""}\n${msgKey(result)}`;
    if (cachedIR && cachedIR.key === key) return cachedIR.ir;
    if (!self.LovableIR) return null;
    const ir = self.LovableIR.buildIR(result, { lang: cfg.lang });
    cachedIR = { key, ir };
    return ir;
  }

  // ---------------------------------------------------------------------------
  // renderText — thin wrapper ao renderer (fast | beginner | advanced | completo).
  // ---------------------------------------------------------------------------
  function renderText(result, mode) {
    const ir = getOrBuildIR(result);
    if (!ir || !self.LovableRenderer) return "";
    return self.LovableRenderer.render(ir, {
      mode: normalizeMode(mode != null ? mode : cfg.mode),
      lang: cfg.lang
    });
  }

  // segmentos que serão narrados, amarrados ao elemento de origem (preview).
  function buildNarrationParts(result, mode) {
    const text = renderText(result, mode);
    return [{ el: result.proseEl || result.titleEl, type: "read", text }];
  }

  // ---------------------------------------------------------------------------
  // Resumo local via Chrome Built-in AI (Summarizer / Gemini Nano).
  // Singleton: cria uma vez e reusa (download/init caro só na 1ª). Fallback total
  // se indisponível (device incompat, pt sem suporte, modelo ainda baixando).
  // ---------------------------------------------------------------------------
  const FAST_START_MAX_DELAY = 100;
  // No fallback genérico (sem padrão reconhecido) não há resumo determinístico
  // bom; aí vale ESPERAR o Nano um pouco mais (a fala atrasa só nesse caso).
  const NANO_TIMEOUT = 2500;
  const NANO_MIN_LEN = 220; // texto curto já é falável; Nano só agrega em texto longo
  // Limite de tamanho é responsabilidade do PROMPT (o modelo gera curto e
  // completo). NUNCA cortamos o texto depois de gerado — cropping mutila a
  // informação exatamente onde ela importa.
  const NANO_WORD_BUDGET = 100;
  let summarizer = null;
  let _summarizerLang = null; // idioma com que o summarizer foi criado
  let lastOutputPayload = null;
  let lastSummarizerStatus = "idle";
  let summarizerWarming = false; // create() em andamento
  let summarizerDead = false; // indisponível nesta sessão (não re-tenta)

  // Prompt API (self.LanguageModel) — motor PRIMÁRIO dos modos fast/beginner/
  // advanced. Diferente do Summarizer (tldr), aceita system prompt e segue
  // instrução fina por modo. Singleton de disponibilidade; sessão criada por
  // chamada (com o system prompt do modo) e destruída em seguida.
  let promptModelReady = false;
  let promptModelWarming = false;
  let promptModelDead = false;
  let _promptLangOptsOk = true; // create() aceita outputLanguage? (memo)

  // BCP-47 -> rótulo humano para injetar no system prompt. Fallback: o próprio
  // código (as LLMs entendem "pt-BR"); default English se vazio.
  const LANG_LABELS = {
    "en-US": "English (United States)", "en-GB": "English (United Kingdom)", en: "English",
    "pt-BR": "Brazilian Portuguese", "pt-PT": "European Portuguese", pt: "Portuguese",
    "es-ES": "Spanish (Spain)", "es-MX": "Spanish (Mexico)", es: "Spanish",
    "fr-FR": "French", fr: "French", "de-DE": "German", de: "German",
    "it-IT": "Italian", it: "Italian", "nl-NL": "Dutch", "pl-PL": "Polish",
    "ru-RU": "Russian", "tr-TR": "Turkish", "ar-SA": "Arabic", "hi-IN": "Hindi",
    "ja-JP": "Japanese", ja: "Japanese", "ko-KR": "Korean", "zh-CN": "Simplified Chinese", zh: "Chinese"
  };
  const langLabel = (bcp47) =>
    LANG_LABELS[bcp47] || LANG_LABELS[langCode(bcp47)] || bcp47 || "English (United States)";

  // System prompt: bloco BASE (regras de áudio) + delta do modo. Escrito em
  // inglês (máxima aderência das LLMs), mas o BASE OBRIGA a saída no idioma da
  // extensão via {{LANG}}.
  const PROMPT_BASE =
    "You turn a coding agent's reply into text that will be SPOKEN aloud to a non-technical user. " +
    "Return ONLY the speakable text — no markdown, lists, code, file paths, or URLs (refer to them " +
    "generically: 'the code', 'the file', 'the link'). Turn tables and lists into sentences. Address " +
    "the user as 'you', calm tone. Do NOT name the tool. Invent nothing beyond the source text. If the " +
    "message is waiting on a decision or confirmation from the user, that is the most important point — " +
    "never hide it. CRITICAL: write the entire spoken output in {{LANG}}, regardless of the language of " +
    "the source text.";
  const PROMPT_DELTA = {
    fast:
      "Ignore technical explanation. Answer only: does the user need to do or decide something? If yes, " +
      "say exactly what, in simple steps. If it's a confirmation request ('want me to implement?'), make " +
      "clear which one. If nothing depends on the user, say only the equivalent of 'You're clear to " +
      "continue, nothing depends on you right now' and stop. Max 3 sentences.",
    beginner:
      "Summarize in 3 to 5 spoken sentences, layman's language, one short analogy only if it clarifies. " +
      "Translate technical points into practical impact. Order: first what was done or analyzed; then what " +
      "you need to know (risks and limits); then what to decide. If nothing is pending, say so at the end.",
    advanced:
      "Summarize in 4 to 6 sentences, keeping technical terms. Order: done, then risks and limits, then the " +
      "pending decision. No analogy, no padding. Prioritize what changes the user's decision."
  };
  function systemPromptFor(mode) {
    const delta = PROMPT_DELTA[mode] || PROMPT_DELTA.beginner;
    return `${PROMPT_BASE.replace("{{LANG}}", langLabel(cfg.lang))} ${delta}`;
  }

  function summarizerOptions() {
    return {
      type: "tldr",
      length: "short",
      format: "plain-text",
      preference: "speed", // baixa latência (ignora nuance)
      sharedContext:
        "You summarize a coding agent's reply so it can be spoken aloud to a non-technical user. " +
        `Use at most ${NANO_WORD_BUDGET} words, always in COMPLETE, natural sentences — never stop mid-sentence. ` +
        "Speak directly about what was done or proposed; do NOT name the tool. " +
        "Order: first what was done or analyzed; then what the user needs to know (risks, limits, the most critical problems); " +
        "finally, if the reply asks a question or awaits a decision, state it clearly — that is the most important point and must never be omitted. " +
        "No markdown, lists, code, file paths, or URLs. " +
        `CRITICAL: write the output in ${langLabel(cfg.lang)}, regardless of the source language.`
    };
  }

  // Aquece o modelo em BACKGROUND. Nunca chamado com await no caminho de narração
  // — se Nano está 'downloadable'/'downloading', o download não pode travar a fala.
  async function warmupSummarizer() {
    if (summarizer || summarizerWarming || summarizerDead) return;
    if (!("Summarizer" in self)) { summarizerDead = true; return; }
    summarizerWarming = true;
    try {
      const avail = await Summarizer.availability();
      if (avail === "unavailable") { summarizerDead = true; return; }
      const base = summarizerOptions();
      const outLang = langCode(cfg.lang) || "en";
      try {
        summarizer = await Summarizer.create({
          ...base,
          expectedInputLanguages: [...new Set(["en", "pt", outLang])],
          outputLanguage: outLang
        });
      } catch (_) {
        summarizer = await Summarizer.create(base); // build sem dicas de idioma
      }
      _summarizerLang = cfg.lang;
    } catch (err) {
      // NÃO marca summarizerDead aqui: create() pode falhar por falta de user
      // activation (download exige gesto). Deixa o unlock() tentar de novo no 1º
      // clique. "unavailable"/sem-API (acima) é que são permanentes.
      console.warn("[Yappable] Summarizer not ready yet (retry on first gesture):", err);
    } finally {
      summarizerWarming = false;
    }
  }

  // Aquece o Prompt API em background (dispara o download do modelo, que é
  // one-time e separado do Summarizer). Não trava a fala: a 1ª narração usa o
  // fallback se ainda não estiver pronto.
  async function warmupPromptModel() {
    if (promptModelReady || promptModelWarming || promptModelDead) return;
    if (!("LanguageModel" in self)) { promptModelDead = true; return; }
    promptModelWarming = true;
    try {
      const avail = await self.LanguageModel.availability();
      if (avail === "unavailable") { promptModelDead = true; return; }
      const s = await self.LanguageModel.create(); // dispara download/init
      try { s.destroy(); } catch (_) {}
      promptModelReady = true;
    } catch (err) {
      // create() pode falhar por falta de user activation (download exige gesto).
      // Não marca dead: o 1º clique (unlock) re-tenta. "unavailable" acima é permanente.
      console.warn("[Yappable] Prompt API not ready yet (retry on first gesture):", err);
    } finally {
      promptModelWarming = false;
    }
  }

  const promptModelAvailable = () => promptModelReady;

  // Roda o modo via Prompt API: system prompt do modo (com idioma forçado) +
  // o corpo como user turn. Sessão por chamada, destruída no fim (evita acúmulo
  // de histórico). Qualquer falha/timeout -> null (cai no próximo fallback).
  async function runMode(mode, text) {
    if (!promptModelReady || !("LanguageModel" in self)) return null;
    const system = systemPromptFor(mode);
    const outLang = langCode(cfg.lang) || "en";
    let session = null;
    try {
      const baseOpts = { initialPrompts: [{ role: "system", content: system }] };
      const create = () =>
        Promise.race([
          self.LanguageModel.create(
            _promptLangOptsOk ? { ...baseOpts, outputLanguage: outLang } : baseOpts
          ),
          new Promise((_, rej) => setTimeout(() => rej(new Error("prompt create timeout")), NANO_TIMEOUT))
        ]);
      try {
        session = await create();
      } catch (e) {
        // outputLanguage pode não ser aceito nesta versão -> memo e retry sem ele.
        if (_promptLangOptsOk) { _promptLangOptsOk = false; session = await create(); }
        else throw e;
      }
      const out = await Promise.race([
        session.prompt(text),
        new Promise((_, rej) => setTimeout(() => rej(new Error("prompt timeout")), NANO_TIMEOUT))
      ]);
      return cleanText(out) || null;
    } catch (err) {
      console.warn("[Yappable] Prompt API failed, fallback:", err);
      return null;
    } finally {
      if (session) { try { session.destroy(); } catch (_) {} }
    }
  }

  // ---------------------------------------------------------------------------
  // Rótulo de projeto: a fala só identifica DE QUAL projeto se trata quando há
  // MAIS DE UMA aba do lovable.dev aberta. Com uma só aba não há ambiguidade —
  // nenhum rótulo. Contar abas exige chrome.tabs (service worker); o content
  // script pergunta por mensagem ao background.js. O nome do projeto sai do
  // título da aba (estável; não depende de classe de CSS, que muda a cada deploy).
  // ---------------------------------------------------------------------------
  let _tabCountCache = { n: 1, at: 0 };
  function countLovableTabs() {
    return new Promise((resolve) => {
      if (Date.now() - _tabCountCache.at < 4000) return resolve(_tabCountCache.n);
      let settled = false;
      const done = (n) => {
        if (settled) return;
        settled = true;
        _tabCountCache = { n, at: Date.now() };
        resolve(n);
      };
      try {
        chrome.runtime.sendMessage({ __yappable: true, type: "countLovableTabs" }, (resp) => {
          if (chrome.runtime.lastError) return done(1); // worker dormindo -> assume 1
          done(resp && Number(resp.count) > 0 ? Number(resp.count) : 1);
        });
      } catch (_) { done(1); }
      setTimeout(() => done(1), 300); // nunca trava a fala esperando o worker
    });
  }

  function getProjectName() {
    // título da aba costuma ser "Nome do Projeto – Lovable" — pega a parte antes
    // do separador. Se sobrar só "Lovable" (ou vazio), não há nome utilizável.
    const raw = cleanText(document.title || "");
    if (!raw) return "";
    const name = raw.split(/\s[–—|]\s|\s-\s/)[0].trim();
    return (!name || /^lovable$/i.test(name)) ? "" : name;
  }

  async function projectLabel() {
    try {
      if (!onProjectPage()) return "";
      if ((await countLovableTabs()) <= 1) return "";
      const name = getProjectName();
      return name ? `Project ${name}. ` : "";
    } catch (_) { return ""; }
  }

  // Nano só está "disponível" se já foi aquecido com sucesso nesta sessão.
  const nanoAvailable = () => !!summarizer;

  // PRIVACIDADE: o resumo é gerado 100% on-device pelo Gemini Nano. O texto da
  // resposta do Lovable NUNCA sai da máquina aqui — só o texto falável FINAL vai
  // pro ElevenLabs (e isso já era verdade no caminho determinístico). Este passo
  // não adiciona nenhuma chamada de rede com o conteúdo do output.
  async function summarizeWithNano(text) {
    if (!summarizer) return null;
    try {
      const out = await Promise.race([
        summarizer.summarize(text, {
          context:
            `Summarize in at most ${NANO_WORD_BUDGET} words, in complete, clear, natural sentences for speech. ` +
            "Do not name the tool. If there is a pending question or decision, end with it. " +
            `Always finish the sentence. No markdown, lists, or code. Write the output in ${langLabel(cfg.lang)}.`
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("nano timeout")), NANO_TIMEOUT))
      ]);
      // SEM cropping pós-geração: o limite vive no prompt. O que o modelo
      // devolver inteiro é o que será falado inteiro.
      return cleanText(out) || null;
    } catch (err) {
      console.warn("[Yappable] Nano failed, keeping deterministic:", err);
      return null;
    }
  }

  // summarizer foi criado para o idioma atual? (se o usuário trocou o idioma
  // depois do warmup, a sessão antiga ainda emite no idioma velho -> não usa)
  const nanoUsable = () => nanoAvailable() && _summarizerLang === cfg.lang;

  function deterministic(result, mode, label) {
    const cleaned = cleanForNarration(renderText(result, mode), mode === "completo" ? "compact" : "natural");
    lastSummarizerStatus = "deterministic";
    return cleaned ? label + cleaned : cleaned;
  }

  // Monta o texto falável. Fonte = corpo COMPLETO (data-message-copy-text), nunca
  // o render condensado (resumir títulos perderia o conteúdo). Cadeia por modo:
  //   fast/beginner/advanced: Prompt API (comportamento por modo) -> Summarizer
  //     (resumo genérico, só beginner/advanced) -> renderer determinístico.
  //   completo: leitura íntegra determinística, sem LLM.
  // Idioma da fala = cfg.lang (forçado nos prompts). Com >1 aba de projeto aberta,
  // prefixa "Projeto X." pra desambiguar.
  async function buildSpeech(result, mode) {
    mode = normalizeMode(mode != null ? mode : cfg.mode);
    const label = await projectLabel();

    if (mode === "completo") return deterministic(result, mode, label);

    const source = cleanForNarration(result.body || "", "natural");
    // fast vale mesmo curto (pode ser só "quer que eu implemente?"); os resumos
    // só agregam em texto longo.
    const longEnough = mode === "fast" || source.length >= NANO_MIN_LEN;

    if (source && longEnough) {
      if (promptModelAvailable()) {
        const out = await runMode(mode, source);
        if (out) { lastSummarizerStatus = "prompt"; return label + out; }
      }
      if ((mode === "beginner" || mode === "advanced") && source.length >= NANO_MIN_LEN && nanoUsable()) {
        const nano = await summarizeWithNano(source);
        if (nano) { lastSummarizerStatus = "nano"; return label + nano; }
      }
    }
    return deterministic(result, mode, label);
  }

  function observedText(result) {
    return [result.taskTitle, result.body].filter(Boolean).join("\n\n");
  }

  // Publica o diagnóstico no storage: agora persiste a IR (o gerador),
  // não a matriz de variantes. popup.js renderiza sob demanda via renderer.js.
  function publishOutput(result, ir, readText) {
    readText = readText || "";
    const payload = {
      at: Date.now(),
      id: result.id,
      taskTitle: result.taskTitle || "",
      body: result.body || "",
      observed: observedText(result),
      ir: ir || null,
      readText,
      summarizerStatus: lastSummarizerStatus
    };
    lastOutputPayload = payload;
    try { chrome.storage.local.set({ [LAST_OUTPUT_KEY]: payload }); } catch (_) {}
  }

  function publishOutputWithIR(result, ir, prefix, readText) {
    prefix = prefix || "";
    const finalRead = readText ? (prefix ? prefix + readText : readText) : "";
    publishOutput(result, ir, finalRead);
  }

  // toca o som de cue (mp3 da extensão) e resolve quando termina
  function playCue(epoch) {
    return new Promise((resolve) => {
      if (!cfg.cueEnabled) return resolve();
      if (epoch != null && !playbackCurrent(epoch)) return resolve();
      try {
        const a = new Audio(chrome.runtime.getURL(cfg.cueFile));
        currentCue = a; // ref global: evita colisão (1 áudio por vez)
        a.volume = cfg.cueVolume;
        const done = () => { if (currentCue === a) currentCue = null; resolve(); };
        a.onended = done;
        a.onpause = done;
        a.onerror = done; // não trava narração se o som falhar
        a.play().catch(done);
      } catch (_) {
        resolve();
      }
    });
  }

  // overlay: enquanto lê = rosa claro (highlight); depois de lido = rosa escuro.
  // dataset.lnMark sinaliza ao observer que mutações de style aqui são NOSSAS
  // (não re-acionam narração — evita auto-loop).
  function highlightReading(el) {
    if (!el) return;
    el.dataset.lnMark = "1";
    el.style.borderRadius = "6px";
    el.style.transition = "background-color 0.3s ease";
    el.style.backgroundColor = "rgba(255, 105, 180, 0.2)"; // claro
  }
  function markRead(el) {
    if (!el) return;
    el.dataset.lnMark = "1";
    el.style.backgroundColor = "rgba(199, 21, 133, 0.45)"; // mediumvioletred escuro
  }

  // ---------------------------------------------------------------------------
  // Preview de highlight: mostra no chat o EXATO texto que cada modo "o que
  // narrar" vai ler. Overlay absoluto (não muta o DOM do React) desenhado sobre
  // os retângulos do Range. Atualiza ao trocar announce no popup.
  //   azul  = título da task   |   rosa = corpo/resposta lida
  // ---------------------------------------------------------------------------
  let overlay = null;
  let previewItems = []; // [{ type, range?, el? }]
  let rafPending = false;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "__ln_preview_overlay";
    Object.assign(overlay.style, {
      position: "fixed", left: "0", top: "0", right: "0", bottom: "0",
      pointerEvents: "none", zIndex: "2147483646"
    });
    (document.body || document.documentElement).appendChild(overlay);
  }

  function clearPreview() {
    previewItems = [];
    if (overlay) overlay.replaceChildren();
  }

  function paintPreview() {
    if (!overlay) return;
    overlay.replaceChildren();
    for (const item of previewItems) {
      const rects = item.range
        ? item.range.getClientRects()
        : (item.el ? [item.el.getBoundingClientRect()] : []);
      for (const r of rects) {
        if (!r.width || !r.height) continue;
        const d = document.createElement("div");
        Object.assign(d.style, {
          position: "absolute",
          left: r.left + "px", top: r.top + "px",
          width: r.width + "px", height: r.height + "px",
          background: item.type === "title" ? "rgba(137,180,250,.35)" : "rgba(255,105,180,.30)",
          boxShadow: item.type === "title"
            ? "0 0 0 1px rgba(137,180,250,.6) inset"
            : "0 0 0 1px rgba(255,105,180,.55) inset",
          borderRadius: "3px"
        });
        overlay.appendChild(d);
      }
    }
  }

  function repaintPreview() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paintPreview(); });
  }

  // localiza um Range cobrindo o texto-alvo (normalizado/colapsado) dentro de el.
  // Espelha cleanText: \s+ -> " " + trim, então o prefixo falado bate 1:1.
  function rangeForText(rootEl, target) {
    if (!rootEl || !target) return null;
    const want = cleanText(target);
    if (!want) return null;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let norm = "";
    const map = []; // map[i] = { node, offset } da posição i em norm
    let node;
    let prevSpace = true; // true no início colapsa espaços líderes
    while ((node = walker.nextNode())) {
      const s = node.nodeValue;
      for (let k = 0; k < s.length; k++) {
        if (/\s/.test(s[k])) {
          if (prevSpace) continue;
          norm += " "; map.push({ node, offset: k }); prevSpace = true;
        } else {
          norm += s[k]; map.push({ node, offset: k }); prevSpace = false;
        }
      }
    }
    while (norm.endsWith(" ")) { norm = norm.slice(0, -1); map.pop(); }
    const idx = norm.indexOf(want);
    if (idx < 0 || !map[idx] || !map[idx + want.length - 1]) return null;
    const a = map[idx];
    const b = map[idx + want.length - 1];
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset + 1);
    return range;
  }

  function showPreview() {
    ensureOverlay();
    clearPreview();
    const result = pickLastCompleted(allowActiveTaskRead());
    if (!result) return;
    // sem corte por maxChars: destaca o texto INTEIRO que alimenta a narração
    // (resumo Nano define a brevidade na fala, não um corte no DOM).
    const parts = buildNarrationParts(result);
    for (const p of parts) {
      if (!p.el) continue;
      const range = rangeForText(p.el, p.text);
      if (range) previewItems.push({ type: p.type, range });
      else previewItems.push({ type: p.type, el: p.el }); // fallback: caixa do elemento
    }
    paintPreview();
  }

  // reposiciona ao rolar/redimensionar (rects são coords de viewport)
  window.addEventListener("scroll", repaintPreview, true);
  window.addEventListener("resize", repaintPreview);

  // Caminho rapido: tenta narrar imediatamente a ultima mensagem concluida.
  // Dedup por conteudo + stopSpeaking() fazem a ultima versao vencer sem debounce.
  function tryNarrateNewest() {
    if (!ready || !cfg.enabled) return false;
    const r = newestQualifying();
    if (!r) return false;
    commitNarrate(r);
    return true;
  }

  function requestNarration(withFastRetries = false) {
    if (tryNarrateNewest() || !withFastRetries) return;
    [50, FAST_START_MAX_DELAY].forEach((ms) => {
      setTimeout(() => { tryNarrateNewest(); }, ms);
    });
  }

  // ponto único de narração: registra id->texto (dedup por conteúdo) + token de
  // geração. Cancela qualquer narração anterior pra garantir que só a ÚLTIMA toque.
  // prefix opcional (ex.: reload -> "Última mensagem: ").
  let narrationToken = 0;
  function commitNarrate(result, prefix) {
    if (!result) return;
    const key = msgKey(result);
    if (spoken.get(result.id) === key) return; // mesmo id+texto já narrado
    spoken.set(result.id, key);
    narrationToken++;
    stopSpeaking(); // mata fila/áudio/TTS anterior: só a última sobrevive
    // Sinaliza ao monitor de silêncio que a conclusão foi detectada.
    try { if (self.LovableSilence) self.LovableSilence.reset(); } catch (_) {}
    onComplete(result, narrationToken, prefix);
  }

  function onComplete(result, token, prefix) {
    clearPreview();
    if (!cfg.enabled) return;
    // Constrói a IR uma vez; todas as funções abaixo reutilizam via cachedIR.
    const ir = getOrBuildIR(result);
    publishOutputWithIR(result, ir, prefix);
    highlightReading(result.proseEl);
    const startDelay = Math.min(Number(cfg.delayMs) || 0, FAST_START_MAX_DELAY);

    setTimeout(async () => {
      if (!cfg.enabled || token !== narrationToken) return;
      const body = await buildSpeech(result);
      if (!body || !cfg.enabled || token !== narrationToken) return;
      const text = prefix ? prefix + body : body;
      // Atualiza o payload com o texto efetivamente narrado.
      publishOutputWithIR(result, ir, prefix, body);
      // cue toca DENTRO do slot da fila (drain), serializado com a voz —
      // impossível sobrepor cue/voz ou tocar o cue mais de uma vez por slot.
      enqueue(text, result.proseEl, { kind: "final", cue: true });
    }, startDelay);
  }

  // ---------------------------------------------------------------------------
  // VERBOSE MODE — narra os placeholders de progresso enquanto o Lovable trabalha.
  // Âncoras semânticas: a mensagem em curso tem .animate-shimmer-gradient; o
  // cabeçalho de ação (span shimmer) traz "Edited <arquivo>"; a linha descritiva
  // vive em p.text-muted-foreground.line-clamp-1. Lê a descrição (preferida) ou,
  // na ausência, o cabeçalho de ação. Dedup por conteúdo (a MESMA caixa muda de
  // texto várias vezes). Single-slot: snippets velhos na fila são descartados —
  // a fala não pode ficar atrasada em relação ao que está na tela.
  // ---------------------------------------------------------------------------
  let lastVerbose = ""; // último snippet enfileirado (dedup)
  let lastVerboseAt = 0; // timestamp do último verbose (throttle)
  const VERBOSE_MIN_INTERVAL = 30000; // mín. 30s entre leituras de progresso

  // Cabeçalhos de ação genéricos: não valem uma leitura sozinhos.
  const RE_PROGRESS_NOISE = /^(working|thinking|loading|thought.*)\.{0,3}$/i;

  // Widget novo de "background task" (barra flutuante acima do #chat-input).
  // Vive FORA da mensagem do agente, então o varredor de mensagem não o alcança.
  // Âncora semântica estável: o status sr-only "N background task(s)" (sobrevive
  // a rebuild de CSS). Anatomia de cada task:
  //   ul.flex-col-reverse > li > button
  //     <span ícone>            -> spinner (task-status-spin) / check / erro
  //     <span ...truncate>      -> TÍTULO<span.text-muted-foreground>: DESCRIÇÃO</span>
  // Devolve { title, desc } (campos vazios filtrados por ruído) ou null se não há
  // widget. O título é o RÓTULO da tarefa (lido uma vez); a descrição muda a cada
  // passo e é lida a cada mudança — quem cuida disso é narrateTaskWidget.
  function extractTaskWidget() {
    const status = [...document.querySelectorAll('[role="status"][aria-live]')]
      .find((s) => /background task/i.test(s.textContent || ""));
    if (!status) return null;
    const scope = status.parentElement || status;
    const btn = [...scope.querySelectorAll("li button")].pop();
    if (!btn) return null;
    const muted = btn.querySelector("span.text-muted-foreground");
    let desc = muted ? cleanText(muted.textContent).replace(/^[\s:]+/, "") : "";
    if (desc && RE_PROGRESS_NOISE.test(desc)) desc = "";
    // título = wrapper do texto, descontando o trecho muted da descrição
    const wrap = muted ? muted.parentElement : btn.querySelector("span.truncate");
    let title = "";
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("span.text-muted-foreground").forEach((n) => n.remove());
      title = cleanText(clone.textContent);
    }
    if (title && RE_PROGRESS_NOISE.test(title)) title = "";
    return (title || desc) ? { title, desc } : null;
  }

  // Extrai o snippet de progresso da task EM CURSO no LAYOUT ANTIGO (task dentro
  // da mensagem do agente). O widget flutuante novo é tratado à parte em
  // narrateTaskWidget — aqui é só fallback.
  //
  // Anatomia do botão de task em andamento (layout antigo):
  //   button[aria-label^="Open background task"]
  //     shimmer linha 1 -> cabeçalho de ação ("Working...", "Read arquivo.tsx")
  //     shimmer linha 2 -> DESCRIÇÃO rica ("Implementing onboarding ... now")
  // A descrição (ÚLTIMO shimmer) é o que vale ler; o cabeçalho é fallback.
  // Se já concluiu (sem shimmer), devolve null — a conclusão é tratada pelo
  // caminho normal de narração.
  function extractProgress() {
    const m = activeTurnAgentMessage() || agentMessages().pop();
    if (!m) return null;
    const taskBtn = m.querySelector('button[aria-label^="Open background task"]');
    const shimmers = [...(taskBtn || m).querySelectorAll(".animate-shimmer-gradient")];
    const texts = shimmers
      .map((s) => cleanText(s.innerText || s.textContent))
      .filter(Boolean);
    if (texts.length) {
      const desc = texts.length > 1 ? texts[texts.length - 1] : "";
      const action = texts[0];
      if (desc && !RE_PROGRESS_NOISE.test(desc)) return desc;
      if (action && !RE_PROGRESS_NOISE.test(action)) return action;
      return null;
    }
    if (taskBtn) {
      const title = cleanText(
        taskBtn.getAttribute("title") ||
        (taskBtn.getAttribute("aria-label") || "").replace(/^Open background task:\s*/i, "")
      );
      if (title && !RE_PROGRESS_NOISE.test(title)) return title;
    }
    // layout antigo: linha descritiva no header expandido
    const statusEl = m.querySelector("p.text-muted-foreground.line-clamp-1");
    const status = statusEl ? cleanText(statusEl.innerText || statusEl.textContent) : "";
    return status || null;
  }

  // Enfileira um snippet transiente (progresso/monitor). Descarta transientes
  // pendentes (single-slot): só o estado mais recente importa. NÃO usa
  // stopSpeaking — não interrompe a fala em curso (deixa terminar e fala o
  // próximo); a conclusão final é que preempta tudo via commitNarrate.
  function enqueueVerbose(text) {
    const t = cleanForSpeech(text);
    if (!t) return;
    dropTransient();
    queue.push({ text: t, el: null, meta: { kind: "transient" } });
    drain();
  }

  // Estado do widget de task: rótulo (título) é lido UMA vez; a descrição é lida
  // a cada mudança, sem repetir o rótulo.
  let lastTaskTitle = "";
  let lastTaskDesc = "";

  // Narra o widget novo. Título novo -> anuncia a tarefa uma vez (com a 1ª
  // descrição junta, num único enfileiramento — dropTransient descartaria um 2º).
  // Mesma tarefa, descrição mudou -> lê só a descrição. SEM o throttle de 30s: o
  // ritmo já é dado pela fila (um item por vez) + single-slot (só o estado mais
  // recente sobrevive enquanto a fala anterior toca).
  function narrateTaskWidget(w) {
    if (w.title && w.title !== lastTaskTitle) {
      lastTaskTitle = w.title;
      lastTaskDesc = w.desc || "";
      const lead = `Current task: ${w.title}.`;
      enqueueVerbose(w.desc ? `${lead} ${w.desc}` : lead);
      return;
    }
    if (w.desc && w.desc !== lastTaskDesc) {
      lastTaskDesc = w.desc;
      enqueueVerbose(w.desc);
    }
  }

  function tryNarrateProgress() {
    if (!ready || !cfg.enabled || !(cfg.verboseEnabled || allowActiveTaskRead())) return;
    // Widget flutuante novo: rótulo uma vez, descrição a cada mudança (pacing
    // pela fila, sem o throttle de 30s — senão perderia os passos rápidos).
    const w = extractTaskWidget();
    if (w) { narrateTaskWidget(w); return; }
    // widget sumiu (tarefa concluída/removida): rearma p/ a próxima tarefa, mesmo
    // que reaproveite o mesmo título.
    if (lastTaskTitle || lastTaskDesc) { lastTaskTitle = ""; lastTaskDesc = ""; }
    // layout antigo (task dentro da mensagem): mantém o throttle de 30s.
    const snippet = extractProgress();
    if (!snippet || snippet === lastVerbose) return;
    // throttle: no máx. 1 leitura de progresso a cada 30s (evita tagarelar)
    if (Date.now() - lastVerboseAt < VERBOSE_MIN_INTERVAL) return;
    lastVerbose = snippet;
    lastVerboseAt = Date.now();
    enqueueVerbose(snippet);
  }

  // ---------------------------------------------------------------------------
  // Detector de ERRO do Lovable (toast "Try to fix" no #preview-panel).
  // O Lovable EXIGE clique em "Try to fix" — sem intervenção, o app não segue
  // sozinho. Por isso o sinal é diferente da narração: bipe de atenção curto +
  // chamado imperativo pra que o usuário olhe a tela.
  // Âncoras semânticas: texto do botão "Try to fix" + visibilidade do toast.
  // Edge-dedup: dispara UMA vez por erro (rearma quando o toast some).
  // ---------------------------------------------------------------------------
  let errorActive = false;

  function findErrorToast() {
    const panel = document.querySelector("#preview-panel");
    if (!panel) return null;
    for (const b of panel.querySelectorAll("button")) {
      if (!/try to fix|tentar corrigir/i.test(cleanText(b.textContent))) continue;
      // confirma que o toast está realmente visível (não escondido offscreen)
      const toast = b.closest(".pointer-events-auto") || b;
      if (parseFloat(getComputedStyle(toast).opacity || "1") < 0.05) return null;
      return toast;
    }
    return null;
  }

  function errorDetailText(toast) {
    return [...toast.querySelectorAll("p")]
      .map((p) => cleanText(p.textContent))
      .filter((t) => t && !/^(try to fix|tentar corrigir|show logs|ver logs|error|erro)$/i.test(t))
      .join(". ");
  }

  // bipe de atenção (dois toques descendentes) sintetizado — sem asset novo.
  // Reusa o AudioContext da waveform (já destravado no 1º gesto).
  function playErrorChime() {
    try {
      if (!_wfAudioCtx) _wfAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_wfAudioCtx.state === "suspended") _wfAudioCtx.resume();
      const ctx = _wfAudioCtx, now = ctx.currentTime, vol = cfg.errorVolume || 0.4;
      for (const [freq, off] of [[880, 0], [660, 0.16]]) {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, now + off);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now + off);
        g.gain.exponentialRampToValueAtTime(vol, now + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + off + 0.14);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(now + off); osc.stop(now + off + 0.16);
      }
    } catch (_) {}
  }

  function onErrorDetected(toast) {
    const detail = errorDetailText(toast);
    const phrase = "Attention. Lovable encountered an error and stopped. " +
      "It won't continue on its own — click Try to fix.";
    playErrorChime();
    stopSpeaking(); // erro tem prioridade sobre narração em curso
    // narra pela FILA ÚNICA (respeita o motor escolhido; fallback nativo é do
    // drain). Delay curto só pra não falar por cima do bipe.
    setTimeout(() => {
      enqueue(phrase, null, { kind: "transient" });
    }, 450);
    try { chrome.storage.local.set({ lovableNarratorLastError: { at: Date.now(), detail } }); } catch (_) {}
  }

  function checkErrorToast() {
    if (!ready || !cfg.enabled || !cfg.errorAlertEnabled) return;
    const toast = findErrorToast();
    if (toast && !errorActive) {
      errorActive = true;
      onErrorDetected(toast);
    } else if (!toast && errorActive) {
      errorActive = false; // toast sumiu (clicou/fechou) -> rearma p/ próximo erro
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver: childList + atributos (opacity/aria mudam no fim do stream)
  // ---------------------------------------------------------------------------
  // a mutação tocou alguma mensagem? (alvo dentro de uma, ou nó de msg adicionado)
  function mutationTouchesMessage(m) {
    // ignora NOSSAS escritas de highlight (style/dataset em elemento marcado) —
    // senão narrar -> mutar style -> observer -> narrar = auto-loop.
    if (m.type === "attributes" && m.target?.dataset?.lnMark === "1") return false;
    if (m.type === "characterData" && m.target?.parentElement?.closest?.("[data-message-id]")) return true;
    if (m.target?.nodeType === 1 && m.target.closest?.("[data-message-id]")) return true;
    if (m.addedNodes) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.matches?.("[data-message-id]") || n.querySelector?.("[data-message-id]"))) {
          return true;
        }
      }
    }
    return false;
  }

  // Observer tenta narrar imediatamente quando uma mutacao toca mensagem.
  // Dedup por conteudo impede repetir o mesmo output.
  const observer = new MutationObserver((mutations) => {
    if (!ready) return; // durante warmup, não agenda (baseline em curso)
    checkErrorToast(); // toast de erro vive fora do chat — checa sempre
    if (cfg.verboseEnabled) tryNarrateProgress(); // lê placeholders de progresso
    for (const m of mutations) {
      const touchesMessage = mutationTouchesMessage(m);
      if (allowActiveTaskRead() && touchesMessage) tryNarrateProgress();
      if (touchesMessage) { requestNarration(); return; }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    // characterData: o texto do placeholder de progresso muda in-place (verbose)
    characterData: true,
    attributeFilter: ["class", "style", "aria-label", "title", "data-message-copy-text", "data-current-user"]
  });

  // Baseline: marca tudo que já existe como visto (não narra histórico no load).
  // SPA renderiza tarde, então re-marca após warmup e só então libera narração.
  function markBaseline() {
    document.querySelectorAll("[data-message-id]").forEach((m) => {
      const id = m.getAttribute("data-message-id");
      if (id) spoken.set(id, msgKey(readMessage(m))); // guarda id->texto atual
    });
  }

  // só num projeto: lovable.dev/projects/<id>...
  const onProjectPage = () => /^\/projects\//.test(location.pathname);

  // Ao recarregar uma página de projeto: NÃO lê durante o load caótico; após o
  // settle, narra APENAS a última resposta uma vez (respeitando "o que narrar").
  function narrateLastOnLoad() {
    if (!onProjectPage()) return;
    const last = pickLastCompleted();
    if (!last) return;
    spoken.delete(last.id); // baseline marked it; force-read the last on reload
    commitNarrate(last, "Last message: "); // prefix only on reload
  }

  markBaseline();
  warmupSummarizer(); // aquece Nano em background (download não trava 1ª narração)
  warmupPromptModel(); // aquece o Prompt API (motor primário dos modos)
  setTimeout(() => {
    markBaseline();
    ready = true;
    if (allowActiveTaskRead()) tryNarrateProgress();
    narrateLastOnLoad(); // lê a última resposta da página recarregada
  }, 2500);

  // ---------------------------------------------------------------------------
  // Sinal do MAIN world (inject.js): tenta narrar na hora. Se o DOM ainda nao
  // estiver pronto, faz retries leves em 50/100ms.
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.__yappable !== true || d.type !== "completion") return;
    requestNarration(true);
  });

  // ---------------------------------------------------------------------------
  // Autoplay unlock + painel flutuante (1º gesto destrava SpeechSynthesis)
  // ---------------------------------------------------------------------------
  function unlock() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (_) {}
    // 1º gesto = user activation: cria/resume o AudioContext da waveform AGORA,
    // enquanto há ativação. Sem isso o contexto nasce "suspended" e a 1ª
    // narração ElevenLabs (roteada por ele) sairia muda.
    try {
      if (!_wfAudioCtx) _wfAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_wfAudioCtx.state === "suspended") _wfAudioCtx.resume();
    } catch (_) {}
    // 1º gesto = user activation: pode disparar o download dos modelos on-device
    // se a 1ª tentativa (no load, sem activation) não conseguiu criar.
    warmupSummarizer();
    warmupPromptModel();
    document.removeEventListener("click", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  }
  document.addEventListener("click", unlock, true);
  document.addEventListener("keydown", unlock, true);

  // Constrói um payload de diagnóstico a partir da última mensagem concluída
  // SEM narrar — usado quando o popup abre numa conversa já finalizada e não há
  // payload em memória (nenhuma conclusão nova nesta sessão).
  function buildOnDemandPayload() {
    const r = pickLastCompleted(allowActiveTaskRead());
    if (!r) return null;
    const ir = getOrBuildIR(r);
    return {
      at: Date.now(),
      id: r.id,
      taskTitle: r.taskTitle || "",
      body: r.body || "",
      observed: observedText(r),
      ir: ir || null,
      readText: "",
      summarizerStatus: lastSummarizerStatus
    };
  }

  // Força a narração da última mensagem concluída com a cfg atual, ignorando o
  // dedup (o popup chama isto ao trocar lente / "o que narrar").
  function narrateLastNow() {
    const r = pickLastCompleted(allowActiveTaskRead());
    if (!r) return false;
    spoken.delete(r.id); // bypass dedup: queremos reler com o novo modo
    cachedIR = null;     // rebuild IR (cfg.lang/mode podem ter mudado)
    commitNarrate(r);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LN_GET_LAST_OUTPUT") {
      // Permite ao popup recuperar o estado da aba ativa mesmo que tenha perdido
      // o evento de chrome.storage.local enquanto estava fechado. Se não houver
      // payload (sem conclusão nova nesta sessão), constrói um sob demanda.
      sendResponse({ output: lastOutputPayload || buildOnDemandPayload() });
      return false;
    }
    if (message?.type === "LN_NARRATE_NOW") {
      // Aplica o modo já aqui: o storage.onChanged pode não ter chegado ainda
      // (o popup acabou de gravar). Evita narrar com o modo anterior.
      if (message.mode != null) cfg.mode = normalizeMode(message.mode);
      sendResponse({ ok: narrateLastNow() });
      return false;
    }
    return false;
  });

  // ---------------------------------------------------------------------------
  // Ponte para o silence-monitor: fala pela MESMA fila — respeita o motor
  // escolhido e a serialização 1-áudio-por-vez. Sem isso o monitor falaria em
  // voz nativa POR CIMA do áudio ElevenLabs (speechSynthesis.speaking não
  // enxerga <audio>).
  // ---------------------------------------------------------------------------
  self.LovableNarrator = {
    say(text) {
      if (!cfg.enabled) return;
      enqueueVerbose(text);
    },
    isSpeaking() {
      return speaking;
    }
  };

})();
