const DEFAULTS = {
  enabled: true,
  engine: "native", // "native" | "elevenlabs"
  lang: "auto", // "auto" = detect from browser, fallback en-US (resolved by resolveLang)
  rate: 1.05,
  pitch: 1.0,
  volume: 1.0,
  nativeVoice: "",
  delayMs: 100,
  mode: "beginner", // fast | beginner | advanced | completo
  cueEnabled: true,
  cueFile: "assets/single-sound-message-icq-ooh.mp3",
  cueVolume: 0.8,
  errorAlertEnabled: true,
  errorVolume: 0.4,
  verboseEnabled: false,
  elevenKey: "",
  elevenVoiceId: "cgSgspJ2msm6clMCkdW9", // Jessica (default voice, expressiva/playful)
  elevenModel: "eleven_flash_v2_5",
  elevenOutputFormat: "mp3_44100_64",
  elevenStability: 0.2,
  elevenSimilarity: 0.2,
  elevenStyle: 0.5,
  elevenSpeed: 1.1,
  elevenSpeakerBoost: true,
  elevenTextNormalization: "on",
  elevenSeedRandom: true,
  elevenSeed: null
};

// modelos que aceitam language_code (enforce). Multilingual v2 auto-detecta.
const LANG_MODELS = /turbo_v2_5|flash_v2_5|eleven_v3/;
const langCode = (l) => (l || "").split("-")[0];

// idiomas: [BCP-47, country-code exibido localmente, nome].
const LANGS = [
  ["pt-BR", "br", "Português (Brasil)"],
  ["pt-PT", "pt", "Português (Portugal)"],
  ["en-US", "us", "English (US)"],
  ["en-GB", "gb", "English (UK)"],
  ["es-ES", "es", "Español (España)"],
  ["es-MX", "mx", "Español (México)"],
  ["fr-FR", "fr", "Français"],
  ["de-DE", "de", "Deutsch"],
  ["it-IT", "it", "Italiano"],
  ["nl-NL", "nl", "Nederlands"],
  ["pl-PL", "pl", "Polski"],
  ["ru-RU", "ru", "Русский"],
  ["tr-TR", "tr", "Türkçe"],
  ["ar-SA", "sa", "العربية"],
  ["hi-IN", "in", "हिन्दी"],
  ["ja-JP", "jp", "日本語"],
  ["ko-KR", "kr", "한국어"],
  ["zh-CN", "cn", "中文"]
];

// "auto" -> melhor match com o idioma do navegador; fallback en-US.
const SUPPORTED_LANGS = LANGS.map((l) => l[0]);
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

// field groups for the Reset button
const GROUPS = {
  native: ["nativeVoice", "rate", "pitch", "volume"],
  eleven: [
    "elevenModel", "elevenOutputFormat", "elevenStability", "elevenSimilarity",
    "elevenStyle", "elevenSpeed", "elevenSpeakerBoost",
    "elevenTextNormalization", "elevenSeedRandom", "elevenSeed"
  ]
};

const SAMPLE = "Yappable is active. This is the selected voice.";
const VOICE_CACHE_KEY = "elevenVoicesCache"; // chrome.storage.local: { key, at, voices:[{id,name,lang}] }
// Payload de diagnostico publicado por content.js: ultimo output observado,
// variantes por modo de "O que narrar" e status do resumo local.
const LAST_OUTPUT_KEY = "lovableNarratorLastOutput";
const MAX_DELAY_MS = 3000;
const MODES = ["fast", "beginner", "advanced", "completo"];
// Migração: eixos antigos (announce × lens) e o par anterior (resumo/completo).
const LEGACY_TO_MODE = {
  raw: "completo", full: "completo", technical: "completo",
  resumo: "beginner", summary: "beginner", title: "beginner",
  concise: "beginner", briefing: "beginner", body: "beginner"
};
const normalizeMode = (m) =>
  (MODES.includes(m) ? m : (LEGACY_TO_MODE[m] || DEFAULTS.mode));

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };
const fmt = (v, digits) => digits === 0 ? String(Math.round(v)) : Number(v).toFixed(digits);

let cfg = { ...DEFAULTS };
let lastOutput = null;

function set(key, value) {
  cfg[key] = value;
  // elevenKey is stored in local (never sync) to keep credentials off cloud sync.
  if (key === "elevenKey") {
    chrome.storage.local.set({ elevenKey: value });
  } else {
    chrome.storage.sync.set({ [key]: value });
  }
}

// ---------------------------------------------------------------------------
// Stop-anterior
// ---------------------------------------------------------------------------
let currentAudio = null;
let currentAudioUrl = "";
function stopAll() {
  try { speechSynthesis.cancel(); } catch (_) {}
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (_) {}
    currentAudio = null;
  }
  if (currentAudioUrl) {
    try { URL.revokeObjectURL(currentAudioUrl); } catch (_) {}
    currentAudioUrl = "";
  }
}

// ---------------------------------------------------------------------------
// Bind helpers (salvam na hora)
// ---------------------------------------------------------------------------
const bindToggle = (id) => $(id).addEventListener("change", () => set(id, $(id).checked));
const bindSelect = (id) => $(id).addEventListener("change", () => set(id, $(id).value));
const bindNumber = (id) => $(id).addEventListener("change", () => {
  const raw = $(id).value;
  set(id, raw === "" ? null : Number(raw));
});
function bindRange(id, outId, digits = 2) {
  const el = $(id);
  el.addEventListener("input", () => { $(outId).textContent = fmt(el.value, digits); });
  el.addEventListener("change", () => set(id, Number(el.value)));
}

// master on/off: rótulo Ativado/Desativado ao lado do switch
function reflectEnabledState() {
  const on = $("enabled").checked;
  const el = $("enabledState");
  el.textContent = on ? "Enabled" : "Disabled";
  el.classList.toggle("on", on);
  el.classList.toggle("off", !on);
  $("masterCard").classList.toggle("on", on); // ring amber no herói quando ativo
}
$("enabled").addEventListener("change", reflectEnabledState);

// engine: dois botões grandes (Nativa / ElevenLabs) são a fonte única. O painel
// de ajustes do motor inativo some — não faz sentido configurar o que não usa.
function reflectEngine() {
  const eleven = cfg.engine === "elevenlabs";
  $("segNative").classList.toggle("on", !eleven);
  $("segEleven").classList.toggle("on", eleven);
  $("panelNative").hidden = eleven;
  $("panelEleven").hidden = !eleven;
  const badge = $("engineBadge");
  if (badge) badge.textContent = eleven ? "☁️ ElevenLabs" : "🔊 Native";
  reflectSummaries();
}

// Resumo de estado nos grupos recolhidos: o usuário vê o que está ativo sem
// abrir. Motor + idioma no grupo de voz; chips on/off no grupo de sons.
function reflectSummaries() {
  const vs = $("voiceState");
  if (vs) {
    const eng = cfg.engine === "elevenlabs" ? "☁️ ElevenLabs" : "🔊 Native";
    const cc = (LANGS.find((l) => l[0] === resolveLang(cfg.lang)) || LANGS[0])[1].toUpperCase();
    vs.textContent = `${eng} · ${cc}`;
  }
}
function setEngine(engine) {
  if (cfg.engine === engine) return;
  set("engine", engine);
  reflectEngine();
}
$("segNative").addEventListener("click", () => setEngine("native"));
$("segEleven").addEventListener("click", () => setEngine("elevenlabs"));

// badge do herói: abre o grupo Voice & engine e rola até ele (atalho pro seletor)
$("engineBadge").addEventListener("click", () => {
  const d = $("cfgVoice");
  if (d) {
    d.open = true;
    d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

// Trocar o modo: atualiza o texto lido E renarra com o motor ativo (o usuário
// pediu ouvir o modo no ato — respeitando o engine escolhido).
function triggerNarrateNow() {
  if (!cfg.enabled) return;
  if (!chrome.tabs?.query) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(
      tab.id,
      { type: "LN_NARRATE_NOW", mode: normalizeMode(cfg.mode) },
      () => void chrome.runtime.lastError
    );
  });
}

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    set("mode", r.value);
    updateReadDebug();
    triggerNarrateNow();
  });
});

// origem do texto lido: determinístico (heurística) vs Nano (LLM local on-device)
function originLabel(status) {
  if (status === "nano") return "Nano (local)";
  if (status === "deterministic") return "Deterministic";
  return status || "—";
}

function updateReadDebug() {
  const observed = $("observedOutput");
  const read = $("readText");
  if (!observed || !read) return;
  observed.value = lastOutput?.observed || "";
  const _ir = lastOutput?.ir;
  read.value = _ir && window.LovableRenderer
    ? window.LovableRenderer.render(_ir, { mode: normalizeMode(cfg.mode), lang: resolveLang(cfg.lang) })
    : (lastOutput?.readText || "");
  const status = lastOutput?.summarizerStatus;
  read.title = status ? `Source: ${originLabel(status)}` : "";
  const lbl = document.querySelector('label[for="readText"]');
  if (lbl) lbl.textContent = status ? `Read text — source: ${originLabel(status)}` : "Read text";
}

function requestLastOutputFromTab() {
  if (!chrome.tabs?.query) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    // Storage cobre o popup fechado; esta consulta cobre o caso em que a aba
    // tem um payload mais novo em memoria que ainda nao foi refletido no popup.
    chrome.tabs.sendMessage(tab.id, { type: "LN_GET_LAST_OUTPUT" }, (response) => {
      if (chrome.runtime.lastError || !response?.output) return;
      lastOutput = response.output;
      updateReadDebug();
    });
  });
}

function reflectSeed() { $("elevenSeed").disabled = cfg.elevenSeedRandom; }

// ---------------------------------------------------------------------------
// Dropdown de idioma (universal: nativa + ElevenLabs)
// ---------------------------------------------------------------------------
function buildLangDropdown() {
  const list = $("langList");
  list.replaceChildren();
  // sem opção "auto" explícita: o idioma detectado já entra pré-selecionado na
  // lista (resolvido em load()). O usuário só vê idiomas concretos para marcar.
  for (const [code, cc, name] of LANGS) {
    const o = document.createElement("div");
    o.className = "dd-opt";
    o.dataset.code = code;
    const flag = document.createElement("span");
    flag.className = "flag-pill";
    flag.textContent = cc;
    const label = document.createElement("span");
    label.textContent = name;
    o.append(flag, label);
    o.addEventListener("click", () => { set("lang", code); reflectLang(); $("langList").hidden = true; });
    list.appendChild(o);
  }
}
function reflectLang() {
  const resolved = resolveLang(cfg.lang);
  const flag = document.createElement("span");
  flag.className = "flag-pill";
  const [, cc] = LANGS.find((l) => l[0] === resolved) || LANGS[0];
  flag.textContent = cc;
  // topbar pill: só a bandeira (compacto); o nome aparece na lista aberta.
  $("langBtn").replaceChildren(flag);
  $("langBtn").title = (LANGS.find((l) => l[0] === resolved) || LANGS[0])[2];
  $("langList").querySelectorAll(".dd-opt").forEach((o) => o.classList.toggle("sel", o.dataset.code === resolved));
  populateNativeVoices(); // lista de vozes nativas segue o idioma
  reflectSummaries();
}
$("langBtn").addEventListener("click", (e) => { e.stopPropagation(); $("langList").hidden = !$("langList").hidden; });
document.addEventListener("click", () => { $("langList").hidden = true; });

// ---------------------------------------------------------------------------
// Settings modal (API key + avançado)
// ---------------------------------------------------------------------------
function reflectKeyStatus() {
  const has = !!cfg.elevenKey;
  $("keyDot").classList.toggle("ok", has);
  $("keyTxt").textContent = has ? "Configured" : "No API key";
  $("keyAffiliate").hidden = has; // link de afiliado só quando falta a chave
}
$("openSettings").addEventListener("click", () => {
  $("elevenKey").value = cfg.elevenKey;
  $("elevenKey").type = "password";
  $("settingsModal").hidden = false;
});
$("settingsClose").addEventListener("click", () => { $("settingsModal").hidden = true; });
$("settingsModal").addEventListener("click", (e) => { if (e.target === $("settingsModal")) $("settingsModal").hidden = true; });
$("keyReveal").addEventListener("click", () => {
  const el = $("elevenKey");
  el.type = el.type === "password" ? "text" : "password";
});
$("elevenKey").addEventListener("change", () => {
  const k = $("elevenKey").value.trim();
  const changed = k !== cfg.elevenKey;
  set("elevenKey", k);
  reflectKeyStatus();
  if (k && changed) loadElevenVoices(true);
  else if (k) loadElevenVoices(false);
});

// ---------------------------------------------------------------------------
// Vozes nativas (Web Speech API)
// ---------------------------------------------------------------------------
const normLang = (l) => String(l || "").toLowerCase().replace(/_/g, "-");
// ordena por provedor: Google > Microsoft/Natural > resto (mesma heurística do content.js)
function rankVoice(v) {
  if (/google/i.test(v.name)) return 0;
  if (/microsoft|natural/i.test(v.name)) return 1;
  return 2;
}
function populateNativeVoices() {
  const sel = $("nativeVoice");
  if (!sel) return;
  const cur = cfg.nativeVoice;
  const all = speechSynthesis.getVoices();
  const want = normLang(resolveLang(cfg.lang)); // ex.: "pt-br"
  const base = want.split("-")[0];

  // só vozes do idioma selecionado: região exata tem prioridade; senão mesmo
  // idioma em qualquer região. Sem match (idioma não instalado) -> mostra todas
  // pra não travar o usuário.
  const exactRegion = all.filter((v) => normLang(v.lang) === want);
  const sameBase = all.filter((v) => normLang(v.lang).split("-")[0] === base);
  let list = exactRegion.length ? exactRegion : sameBase;
  let noMatch = false;
  if (!list.length) { list = all; noMatch = true; }
  list = [...list].sort((a, b) => rankVoice(a) - rankVoice(b));

  sel.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (best match)";
  sel.appendChild(auto);
  for (const v of list) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = noMatch ? `${v.name} (${v.lang})` : v.name;
    sel.appendChild(o);
  }
  // mantém a escolha do usuário só se ainda válida para este idioma; senão Auto.
  sel.value = list.some((v) => v.name === cur) ? cur : "";
}
speechSynthesis.onvoiceschanged = populateNativeVoices;

// ---------------------------------------------------------------------------
// Vozes ElevenLabs (nomes, cacheadas em chrome.storage.local)
// ---------------------------------------------------------------------------
function populateElevenVoices(voices) {
  const sel = $("elevenVoiceId");
  sel.replaceChildren();
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.lang ? `${v.name} — ${v.lang}` : v.name;
    sel.appendChild(o);
  }
  if (cfg.elevenVoiceId) sel.value = cfg.elevenVoiceId;
  if (!sel.value && sel.options.length) { sel.value = sel.options[0].value; set("elevenVoiceId", sel.value); }
}

async function fetchElevenVoices() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": cfg.elevenKey } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return (data.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    lang: v.labels?.language || v.labels?.accent || ""
  }));
}

function loadElevenVoices(force) {
  if (!cfg.elevenKey) {
    const sel = $("elevenVoiceId");
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— configure the API key (⚙) —";
    sel.replaceChildren(option);
    return;
  }
  chrome.storage.local.get(VOICE_CACHE_KEY, async (st) => {
    const cache = st[VOICE_CACHE_KEY];
    if (!force && cache && cache.key === cfg.elevenKey && cache.voices?.length) {
      populateElevenVoices(cache.voices);
      return;
    }
    msg("Loading voices…");
    try {
      const voices = await fetchElevenVoices();
      chrome.storage.local.set({ [VOICE_CACHE_KEY]: { key: cfg.elevenKey, at: Date.now(), voices } });
      populateElevenVoices(voices);
      msg(`${voices.length} voices cached.`);
    } catch (e) {
      msg("Failed to load voices: " + e.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Reset (por grupo)
// ---------------------------------------------------------------------------
function resetGroup(group) {
  const keys = GROUPS[group] || [];
  const patch = {};
  for (const k of keys) { cfg[k] = DEFAULTS[k]; patch[k] = DEFAULTS[k]; }
  chrome.storage.sync.set(patch);
  reflectUI();
  msg("Settings for '" + group + "' reset.");
}

// ---------------------------------------------------------------------------
// Testes de voz
// ---------------------------------------------------------------------------
function testNative() {
  stopAll();
  if (!("speechSynthesis" in window)) { msg("speechSynthesis not supported."); return; }
  const u = new SpeechSynthesisUtterance(SAMPLE);
  u.lang = resolveLang(cfg.lang);
  u.rate = cfg.rate;
  u.pitch = cfg.pitch;
  u.volume = cfg.volume;
  const v = speechSynthesis.getVoices().find((x) => x.name === cfg.nativeVoice);
  if (v) u.voice = v;
  speechSynthesis.speak(u);
  msg("Playing native voice…");
  u.onend = () => msg("");
}

// ---------------------------------------------------------------------------
// Refletir cfg -> UI
// ---------------------------------------------------------------------------
function reflectUI() {
  if (Number(cfg.delayMs) > MAX_DELAY_MS) {
    cfg.delayMs = MAX_DELAY_MS;
    chrome.storage.sync.set({ delayMs: cfg.delayMs });
  }
  $("enabled").checked = cfg.enabled;
  reflectEnabledState();
  reflectLang();
  reflectEngine();
  document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === normalizeMode(cfg.mode); });
  $("cueEnabled").checked = cfg.cueEnabled;
  $("cueVolume").value = cfg.cueVolume; $("cueVolumeOut").textContent = fmt(cfg.cueVolume, 2);
  $("errorAlertEnabled").checked = cfg.errorAlertEnabled;
  $("errorVolume").value = cfg.errorVolume; $("errorVolumeOut").textContent = fmt(cfg.errorVolume, 2);
  $("verboseEnabled").checked = cfg.verboseEnabled;
  $("delayMs").value = cfg.delayMs; $("delayMsOut").textContent = fmt(cfg.delayMs, 0);

  // nativa
  $("nativeVoice").value = cfg.nativeVoice;
  $("rate").value = cfg.rate; $("rateOut").textContent = fmt(cfg.rate, 2);
  $("pitch").value = cfg.pitch; $("pitchOut").textContent = fmt(cfg.pitch, 2);
  $("volume").value = cfg.volume; $("volumeOut").textContent = fmt(cfg.volume, 2);

  // eleven
  $("elevenModel").value = cfg.elevenModel;
  $("elevenOutputFormat").value = cfg.elevenOutputFormat;
  $("elevenStability").value = cfg.elevenStability; $("stabOut").textContent = fmt(cfg.elevenStability, 2);
  $("elevenSimilarity").value = cfg.elevenSimilarity; $("simOut").textContent = fmt(cfg.elevenSimilarity, 2);
  $("elevenStyle").value = cfg.elevenStyle; $("styleOut").textContent = fmt(cfg.elevenStyle, 2);
  $("elevenSpeed").value = cfg.elevenSpeed; $("elevenSpeedOut").textContent = fmt(cfg.elevenSpeed, 2);
  $("elevenSpeakerBoost").checked = cfg.elevenSpeakerBoost;
  $("elevenTextNormalization").value = cfg.elevenTextNormalization;
  $("elevenSeedRandom").checked = cfg.elevenSeedRandom;
  $("elevenSeed").value = cfg.elevenSeed == null ? "" : cfg.elevenSeed;
  reflectSeed();
  reflectKeyStatus();
  updateReadDebug();
}

// ---------------------------------------------------------------------------
// Carregar config
// ---------------------------------------------------------------------------
function load() {
  // Migration: if elevenKey still in sync from before Fase 5, move to local.
  chrome.storage.sync.get({ elevenKey: "" }, (syncData) => {
    if (syncData.elevenKey) {
      chrome.storage.local.set({ elevenKey: syncData.elevenKey });
      chrome.storage.sync.remove("elevenKey");
    }
  });

  chrome.storage.sync.get({ ...DEFAULTS, mode: "", announce: "", lens: "" }, (stored) => {
    cfg = { ...DEFAULTS, ...stored };
    delete cfg.announce;
    delete cfg.lens;
    cfg.mode = normalizeMode(stored.mode || stored.announce);
    cfg.elevenKey = ""; // will be overwritten from local below
    // "auto" -> idioma concreto detectado, já marcado na lista (sem opção "auto")
    if (!cfg.lang || cfg.lang === "auto") {
      cfg.lang = resolveLang("auto");
      chrome.storage.sync.set({ lang: cfg.lang });
    }
    if (stored.mode !== cfg.mode) chrome.storage.sync.set({ mode: cfg.mode });
    if (stored.announce || stored.lens) chrome.storage.sync.remove(["announce", "lens"]);
    buildLangDropdown();
    populateNativeVoices();
    reflectUI();
    const sel = $("elevenVoiceId");
    if (!sel.options.length || sel.options[0].value === "") {
      const option = document.createElement("option");
      option.value = cfg.elevenVoiceId;
      option.textContent = `${cfg.elevenVoiceId} (current)`;
      sel.replaceChildren(option);
    }
  });

  chrome.storage.local.get([LAST_OUTPUT_KEY, "elevenKey"], (stored) => {
    lastOutput = stored[LAST_OUTPUT_KEY] || null;
    cfg.elevenKey = stored.elevenKey || "";
    reflectKeyStatus();
    if (cfg.elevenKey) loadElevenVoices(false);
    updateReadDebug();
    requestLastOutputFromTab();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[LAST_OUTPUT_KEY]) {
    lastOutput = changes[LAST_OUTPUT_KEY].newValue || null;
    updateReadDebug();
  }
  if (changes.elevenKey) {
    cfg.elevenKey = changes.elevenKey.newValue || "";
    reflectKeyStatus();
  }
});

// ---------------------------------------------------------------------------
// Preview de sons: toca o respectivo áudio ao ligar o toggle ou ao terminar de
// mexer no volume (debounce). Cue = mp3 da extensão; erro = bipe sintetizado
// (mesmo desenho do content.js: dois toques descendentes 880→660Hz).
// ---------------------------------------------------------------------------
let _previewAudioCtx = null;
function previewCue() {
  try {
    const a = new Audio(chrome.runtime.getURL(cfg.cueFile));
    a.volume = Number($("cueVolume").value);
    a.play().catch(() => {});
  } catch (_) {}
}
function previewErrorChime() {
  try {
    if (!_previewAudioCtx) _previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_previewAudioCtx.state === "suspended") _previewAudioCtx.resume();
    const ctx = _previewAudioCtx, now = ctx.currentTime, vol = Number($("errorVolume").value) || 0.4;
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
function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
// toggles: só ao LIGAR
$("cueEnabled").addEventListener("change", (e) => { if (e.target.checked) previewCue(); });
$("errorAlertEnabled").addEventListener("change", (e) => { if (e.target.checked) previewErrorChime(); });
// volumes: ao terminar de arrastar (debounce sobre 'input')
$("cueVolume").addEventListener("input", debounce(previewCue, 350));
$("errorVolume").addEventListener("input", debounce(previewErrorChime, 350));

// ---------------------------------------------------------------------------
// Binds
// ---------------------------------------------------------------------------
bindToggle("enabled");
bindToggle("cueEnabled");
bindToggle("errorAlertEnabled");
bindToggle("verboseEnabled");
bindToggle("elevenSpeakerBoost");
bindToggle("elevenSeedRandom");
bindSelect("nativeVoice");
bindSelect("elevenVoiceId");
bindSelect("elevenModel");
bindSelect("elevenOutputFormat");
bindSelect("elevenTextNormalization");
bindNumber("elevenSeed");
bindRange("cueVolume", "cueVolumeOut", 2);
bindRange("errorVolume", "errorVolumeOut", 2);
bindRange("delayMs", "delayMsOut", 0);
bindRange("rate", "rateOut", 2);
bindRange("pitch", "pitchOut", 2);
bindRange("volume", "volumeOut", 2);
bindRange("elevenStability", "stabOut", 2);
bindRange("elevenSimilarity", "simOut", 2);
bindRange("elevenStyle", "styleOut", 2);
bindRange("elevenSpeed", "elevenSpeedOut", 2);

$("elevenSeedRandom").addEventListener("change", reflectSeed);
$("refreshVoices").addEventListener("click", () => loadElevenVoices(true));
$("resetNative").addEventListener("click", () => resetGroup("native"));
$("resetEleven").addEventListener("click", () => resetGroup("eleven"));
$("testNative").addEventListener("click", testNative);

window.addEventListener("unload", stopAll);

load();
