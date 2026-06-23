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
  waveformEnabled: true, // barra animada no topo durante a fala
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

// "auto" -> idioma da UI do Chrome primeiro; navigator.languages como fallback.
const SUPPORTED_LANGS = LANGS.map((l) => l[0]);
function detectedLanguageCandidates() {
  const candidates = [];
  try {
    const ui = chrome.i18n?.getUILanguage?.();
    if (ui) candidates.push(ui);
  } catch (_) {}
  const navs = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || ""];
  for (const nav of navs) if (nav && !candidates.includes(nav)) candidates.push(nav);
  return candidates;
}
function resolveLang(l) {
  if (l && l !== "auto") return l;
  for (const nav of detectedLanguageCandidates()) {
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

const SAMPLES = {
  en: "Yappable is active. This is the selected voice.",
  pt: "O Yappable está ativo. Esta é a voz selecionada.",
  es: "Yappable está activo. Esta es la voz seleccionada.",
  fr: "Yappable est actif. Voici la voix sélectionnée.",
  de: "Yappable ist aktiv. Dies ist die ausgewählte Stimme.",
  it: "Yappable è attivo. Questa è la voce selezionata.",
  nl: "Yappable is actief. Dit is de geselecteerde stem.",
  pl: "Yappable jest aktywny. To jest wybrany głos.",
  ru: "Yappable активен. Это выбранный голос.",
  tr: "Yappable etkin. Bu, seçilen sestir.",
  ar: "Yappable نشط. هذا هو الصوت المحدد.",
  hi: "Yappable सक्रिय है। यह चुनी गई आवाज़ है।",
  ja: "Yappable は有効です。これが選択された音声です。",
  ko: "Yappable이 활성화되었습니다. 선택한 음성입니다.",
  zh: "Yappable 已启用。这是所选语音。"
};
const sampleForLanguage = () => SAMPLES[langCode(resolveLang(cfg.lang))] || SAMPLES.en;
const VOICE_CACHE_KEY = "elevenVoicesCache"; // chrome.storage.local: { key, at, voices:[{id,name,lang}] }
const LAST_OUTPUT_KEY = "lovableNarratorLastOutput";
const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io/*";
const MAX_DELAY_MS = 3000;
const MODES = ["fast", "beginner", "advanced", "completo"];
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

function hasElevenLabsAccess() {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [ELEVENLABS_ORIGIN] }, (granted) => {
      resolve(!chrome.runtime.lastError && !!granted);
    });
  });
}

function requestElevenLabsAccess() {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [ELEVENLABS_ORIGIN] }, (granted) => {
      if (chrome.runtime.lastError) {
        msg("Could not request ElevenLabs access.");
        resolve(false);
        return;
      }
      if (!granted) msg("ElevenLabs access was not granted.");
      resolve(!!granted);
    });
  });
}

let cfg = { ...DEFAULTS };
let lastOutput = null;

function set(key, value) {
  cfg[key] = value;
  // elevenKey and debug stored in local (credentials + debug state off sync).
  if (key === "elevenKey" || key === "debug") {
    chrome.storage.local.set({ [key]: value });
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

// master on/off
function reflectEnabledState() {
  const on = $("enabled").checked;
  const el = $("enabledState");
  el.textContent = on ? "Enabled" : "Disabled";
  el.classList.toggle("on", on);
  el.classList.toggle("off", !on);
  $("masterCard").classList.toggle("on", on);
  document.body.classList.toggle("narr-off", !on);
}

function stopAllTabs() {
  if (!chrome.tabs?.query) return;
  chrome.tabs.query({ url: "https://lovable.dev/*" }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab?.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "LN_STOP_NOW" }, () => void chrome.runtime.lastError);
    }
  });
}

$("enabled").addEventListener("change", () => {
  reflectEnabledState();
  if (!$("enabled").checked) stopAllTabs();
});

// engine
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
$("segEleven").addEventListener("click", async () => {
  if (!(await requestElevenLabsAccess())) return;
  setEngine("elevenlabs");
});

$("repeatBtn").addEventListener("click", () => { triggerNarrateNow(); });

$("engineBadge").addEventListener("click", () => {
  const d = $("cfgVoice");
  if (d) {
    d.open = true;
    d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

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
    chrome.tabs.sendMessage(tab.id, { type: "LN_GET_LAST_OUTPUT" }, (response) => {
      if (chrome.runtime.lastError || !response?.output) return;
      lastOutput = response.output;
      updateReadDebug();
    });
  });
}

function reflectSeed() { $("elevenSeed").disabled = cfg.elevenSeedRandom; }

// ---------------------------------------------------------------------------
// Easter egg: 5 rapid clicks on the logo → toggle debug mode
// ---------------------------------------------------------------------------
let _dbgClicks = 0, _dbgTimer = null;
$("brandTitle").addEventListener("click", () => {
  _dbgClicks++;
  clearTimeout(_dbgTimer);
  _dbgTimer = setTimeout(() => { _dbgClicks = 0; }, 2000);
  if (_dbgClicks >= 5) {
    _dbgClicks = 0;
    const next = !cfg.debug;
    set("debug", next);
    cfg.debug = next;
    $("debugPanel").hidden = !next;
    msg(next ? "🔧 Debug on" : "Debug off");
    setTimeout(() => msg(""), 2000);
  }
});

// ---------------------------------------------------------------------------
// Dropdown de idioma
// ---------------------------------------------------------------------------
function makeFlagPill(cc) {
  const span = document.createElement("span");
  span.className = "flag-pill";
  const img = document.createElement("img");
  img.src = `https://flagcdn.com/20x15/${cc}.png`;
  img.width = 20;
  img.height = 15;
  img.alt = cc.toUpperCase();
  span.appendChild(img);
  return span;
}

function buildLangDropdown() {
  const list = $("langList");
  list.replaceChildren();
  const detected = resolveLang("auto");
  for (const [code, cc, name] of LANGS) {
    const o = document.createElement("div");
    o.className = "dd-opt";
    o.dataset.code = code;
    const label = document.createElement("span");
    label.textContent = code === detected ? `${name} (Detected)` : name;
    o.append(makeFlagPill(cc), label);
    o.addEventListener("click", () => { set("lang", code); reflectLang(); $("langList").hidden = true; });
    list.appendChild(o);
  }
}
function reflectLang() {
  const resolved = resolveLang(cfg.lang);
  const [, cc, name] = LANGS.find((l) => l[0] === resolved) || LANGS[0];
  $("langBtn").replaceChildren(
    makeFlagPill(cc),
    document.createTextNode(langCode(resolved).toUpperCase())
  );
  $("langBtn").removeAttribute("title");
  $("langBtn").setAttribute("aria-label", `Narration language: ${name}`);
  $("langList").querySelectorAll(".dd-opt").forEach((o) => o.classList.toggle("sel", o.dataset.code === resolved));
  populateNativeVoices();
  reflectSummaries();
}
$("langBtn").addEventListener("click", (e) => { e.stopPropagation(); $("langList").hidden = !$("langList").hidden; });
document.addEventListener("click", () => { $("langList").hidden = true; });

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
function reflectKeyStatus() {
  const has = !!cfg.elevenKey;
  $("keyDot").classList.toggle("ok", has);
  $("keyTxt").textContent = has ? "Configured" : "No API key";
  $("keyAffiliate").hidden = has;
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
$("elevenKey").addEventListener("change", async () => {
  const k = $("elevenKey").value.trim();
  const changed = k !== cfg.elevenKey;
  if (k && !(await requestElevenLabsAccess())) {
    $("elevenKey").value = cfg.elevenKey;
    return;
  }
  set("elevenKey", k);
  reflectKeyStatus();
  if (k && changed) loadElevenVoices(true);
  else if (k) loadElevenVoices(false);
});

// ---------------------------------------------------------------------------
// Vozes nativas
// ---------------------------------------------------------------------------
const normLang = (l) => String(l || "").toLowerCase().replace(/_/g, "-");
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
  const want = normLang(resolveLang(cfg.lang));
  const base = want.split("-")[0];

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
  sel.value = list.some((v) => v.name === cur) ? cur : "";
}
speechSynthesis.onvoiceschanged = populateNativeVoices;

// ---------------------------------------------------------------------------
// Vozes ElevenLabs
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

async function loadElevenVoices(force) {
  if (!cfg.elevenKey) {
    const sel = $("elevenVoiceId");
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— configure the API key (⚙) —";
    sel.replaceChildren(option);
    return;
  }
  if (!(await hasElevenLabsAccess())) {
    msg("Enable ElevenLabs to grant API access.");
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
// Reset
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
  const u = new SpeechSynthesisUtterance(sampleForLanguage());
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
  $("waveformEnabled").checked = cfg.waveformEnabled;
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

  // debug panel visibility
  $("debugPanel").hidden = !cfg.debug;
}

// ---------------------------------------------------------------------------
// Carregar config
// ---------------------------------------------------------------------------
function load() {
  // Migration: elevenKey from sync → local.
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
    cfg.elevenKey = "";
    cfg.debug = false; // loaded from local below
    if (!cfg.lang || cfg.lang === "auto") {
      cfg.lang = resolveLang("auto");
      chrome.storage.sync.set({ lang: cfg.lang });
    }
    if (stored.mode !== cfg.mode) chrome.storage.sync.set({ mode: cfg.mode });
    if (stored.announce || stored.lens) chrome.storage.sync.remove(["announce", "lens"]);
    buildLangDropdown();
    populateNativeVoices();
    reflectUI();
    if (!cfg.enabled) stopAllTabs();
    const sel = $("elevenVoiceId");
    if (!sel.options.length || sel.options[0].value === "") {
      const option = document.createElement("option");
      option.value = cfg.elevenVoiceId;
      option.textContent = `${cfg.elevenVoiceId} (current)`;
      sel.replaceChildren(option);
    }
  });

  chrome.storage.local.get([LAST_OUTPUT_KEY, "elevenKey", "debug"], (stored) => {
    lastOutput = stored[LAST_OUTPUT_KEY] || null;
    cfg.elevenKey = stored.elevenKey || "";
    cfg.debug = !!stored.debug;
    reflectKeyStatus();
    $("debugPanel").hidden = !cfg.debug;
    if (cfg.elevenKey) loadElevenVoices(false);
    updateReadDebug();
    requestLastOutputFromTab();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes[LAST_OUTPUT_KEY]) {
      lastOutput = changes[LAST_OUTPUT_KEY].newValue || null;
      updateReadDebug();
    }
    if (changes.elevenKey) {
      cfg.elevenKey = changes.elevenKey.newValue || "";
      reflectKeyStatus();
    }
    if (changes.debug) {
      cfg.debug = !!changes.debug.newValue;
      $("debugPanel").hidden = !cfg.debug;
    }
  }
});

// ---------------------------------------------------------------------------
// Sound previews
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
$("cueEnabled").addEventListener("change", (e) => { if (e.target.checked) previewCue(); });
$("errorAlertEnabled").addEventListener("change", (e) => { if (e.target.checked) previewErrorChime(); });
$("cueVolume").addEventListener("input", debounce(previewCue, 350));
$("errorVolume").addEventListener("input", debounce(previewErrorChime, 350));

// ---------------------------------------------------------------------------
// Binds
// ---------------------------------------------------------------------------
bindToggle("enabled");
bindToggle("cueEnabled");
bindToggle("errorAlertEnabled");
bindToggle("verboseEnabled");
bindToggle("waveformEnabled");
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
$("refreshVoices").addEventListener("click", async () => {
  if (!(await requestElevenLabsAccess())) return;
  loadElevenVoices(true);
});
$("resetNative").addEventListener("click", () => resetGroup("native"));
$("resetEleven").addEventListener("click", () => resetGroup("eleven"));
$("testNative").addEventListener("click", testNative);

window.addEventListener("unload", stopAll);

load();
