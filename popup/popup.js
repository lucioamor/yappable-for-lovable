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
    "elevenStyle", "elevenSpeed",
    "elevenTextNormalization", "elevenSeedRandom", "elevenSeed"
  ]
};

const SAMPLE = "Yappable is active. This is the selected voice.";
const VOICE_CACHE_KEY = "elevenVoicesCache"; // chrome.storage.local: { key, at, voices:[{id,name,lang}] }
const LAST_OUTPUT_KEY = "lovableNarratorLastOutput";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_DELAY_MS = 3000;
const MODES = ["fast", "beginner", "advanced", "completo"];
const LEGACY_TO_MODE = {
  raw: "completo", full: "completo", technical: "completo",
  resumo: "beginner", summary: "beginner", title: "beginner",
  concise: "beginner", briefing: "beginner", body: "beginner"
};
const normalizeMode = (m) =>
  (MODES.includes(m) ? m : (LEGACY_TO_MODE[m] || DEFAULTS.mode));

// Logger estruturado (src/logger.js, carregado antes deste no popup.html).
// Fallback no-op se ausente. As operações do popup entram no MESMO store
// (yapLogs) e aparecem no download junto com content e background.
const L = globalThis.YapLog || {
  ok() {}, info() {}, fallback() {}, fail() {}, start: () => () => {},
  isOn: () => false, dump: () => [], clear() {}
};

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };
const fmt = (v, digits) => digits === 0 ? String(Math.round(v)) : Number(v).toFixed(digits);
// Mostra valor interno (0–1) como percentual. Não altera o valor salvo.
const fmtPct = (v) => Math.round(Number(v) * 100) + "%";
// Speed: percentual relativo a 100% (1.0). Ex.: 0.9 -> "-10%", 1.2 -> "+20%". Não altera o valor salvo.
const fmtSpeedPct = (v) => { const d = Math.round((Number(v) - 1) * 100); return (d > 0 ? "+" : "") + d + "%"; };

let cfg = { ...DEFAULTS };
let lastOutput = null;

function set(key, value) {
  cfg[key] = value;
  // elevenKey and debug stored in local (credentials + debug state off sync).
  if (key === "elevenKey" || key === "debug") {
    chrome.storage.local.set({ [key]: value });
    // Phase 5: mirror elevenKey into the auth credential object
    if (key === "elevenKey") {
      chrome.storage.local.get({ auth: null }, (st) => {
        if (chrome.runtime.lastError) return;
        const authBase = st.auth || {
          v: 1, activeEngine: cfg.engine || "native",
          providers: { elevenlabs: { credential: null, status: "unconfigured", account: null, voices: [], voicesAt: null } }
        };
        const auth = JSON.parse(JSON.stringify(authBase));
        if (!auth.providers) auth.providers = {};
        if (!auth.providers.elevenlabs) auth.providers.elevenlabs = { credential: null, status: "unconfigured" };
        const prev = auth.providers.elevenlabs.credential;
        auth.providers.elevenlabs.credential = value ? {
          type: "apiKey", value,
          addedAt: (prev && prev.addedAt) || Date.now(),
          lastVerifiedAt: null
        } : null;
        auth.providers.elevenlabs.status = value ? "unverified" : "unconfigured";
        cfg._authStatus = auth.providers.elevenlabs.status;
        chrome.storage.local.set({ auth });
        reflectKeyStatus();
      });
    }
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
function bindRange(id, outId, fmtArg = 2) {
  const el = $(id);
  const fmtFn = typeof fmtArg === "function" ? fmtArg : (v) => fmt(v, fmtArg);
  el.addEventListener("input", () => { $(outId).textContent = fmtFn(el.value); });
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
$("segEleven").addEventListener("click", () => setEngine("elevenlabs"));

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
    L.info("popup", "triggerNarrateNow", "pedido de re-narração enviado à aba", { mode: normalizeMode(cfg.mode) });
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
    setDebug(!cfg.debug);
    msg(cfg.debug ? "🔧 Debug on" : "Debug off");
    setTimeout(() => msg(""), 2000);
  }
});

// ---------------------------------------------------------------------------
// Diagnostics: debug toggle + download (TXT + JSONL) + clear
// ---------------------------------------------------------------------------
const LOG_STORE_KEY = "yapLogs";
const BCUMB_KEY = "yapBreadcrumbs"; // Phase 3: always-on fail ring

function isLogEntry(e) {
  return !!e && typeof e === "object" && typeof e.iso === "string" &&
    typeof e.stage === "string" && typeof e.hook === "string";
}

function logDedupeKey(e) {
  return `${e.ctx || ""}|${e.seq || ""}|${e.iso}`;
}

function setDebug(next) {
  set("debug", next);
  cfg.debug = next;
  $("debug").checked = next;
  $("debugPanel").hidden = !next;
  if (next) refreshLogCount();
}

$("debug").addEventListener("change", () => {
  setDebug($("debug").checked);
  msg($("debug").checked ? "🔧 Debug logging on" : "Debug logging off");
  setTimeout(() => msg(""), 1800);
});

// Buffer em memória da aba Lovable ativa (fonte mais fresca do pipeline de fala).
function getLiveLogs(cb) {
  if (!chrome.tabs?.query) return cb([]);
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return cb([]);
    chrome.tabs.sendMessage(tab.id, { type: "LN_GET_LOGS" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return cb([]);
      cb(resp.logs || []);
    });
  });
}

// Complete view: merge live tab buffer + persisted storage (all contexts) +
// Phase 3 breadcrumbs. Dedupe by ctx|seq|iso, sort chronologically.
function gatherAllLogs(cb) {
  chrome.storage.local.get({ [LOG_STORE_KEY]: [], [BCUMB_KEY]: [] }, (st) => {
    const stored = Array.isArray(st[LOG_STORE_KEY]) ? st[LOG_STORE_KEY].filter(isLogEntry) : [];
    const breadcrumbs = Array.isArray(st[BCUMB_KEY]) ? st[BCUMB_KEY].filter(isLogEntry) : [];
    getLiveLogs((live) => {
      const liveLogs = Array.isArray(live) ? live.filter(isLogEntry) : [];
      const map = new Map();
      for (const e of stored) map.set(logDedupeKey(e), e);
      for (const e of liveLogs) map.set(logDedupeKey(e), e);
      // Phase 3: include breadcrumbs not already present in the trace
      for (const e of breadcrumbs) {
        const k = logDedupeKey(e);
        if (!map.has(k)) map.set(k, e);
      }
      const all = [...map.values()].sort((a, b) =>
        ((Number(a.t) || 0) - (Number(b.t) || 0)) ||
        ((Number(a.seq) || 0) - (Number(b.seq) || 0))
      );
      cb(all, liveLogs.length ? "live+stored" : "stored", breadcrumbs);
    });
  });
}

function refreshLogCount() {
  gatherAllLogs((logs, _origin, breadcrumbs) => {
    const el = $("logCount");
    const bcTxt = breadcrumbs && breadcrumbs.length ? ` + ${breadcrumbs.length} crumbs` : "";
    if (el) el.textContent = logs.length ? `${logs.length} entries${bcTxt}` : "no logs yet";
  });
}

// Phase 2: compute derived metrics from log entries.
function computeMetrics(logs) {
  const runs = new Map();
  for (const e of logs) {
    if (!e.runId) continue;
    if (!runs.has(e.runId)) runs.set(e.runId, { failed: false });
    if (e.outcome === "fail") runs.get(e.runId).failed = true;
  }
  const totalRuns = runs.size;
  const failedRuns = [...runs.values()].filter((r) => r.failed).length;
  const fallbackByStage = {}, totalByStage = {};
  for (const e of logs) {
    if (!e.stage) continue;
    totalByStage[e.stage] = (totalByStage[e.stage] || 0) + 1;
    if (e.outcome === "fallback") fallbackByStage[e.stage] = (fallbackByStage[e.stage] || 0) + 1;
  }
  const fallbackRateByStage = {};
  for (const [stage, cnt] of Object.entries(fallbackByStage)) {
    fallbackRateByStage[stage] = Math.round(cnt / (totalByStage[stage] || 1) * 100) / 100;
  }
  function percentiles(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)] };
  }
  const elevenMs = logs.filter((e) => e.hook === "speakEleven" && e.ms != null).map((e) => e.ms);
  const localMs = logs.filter((e) => e.hook === "localizeLine" && e.ms != null).map((e) => e.ms);
  const latencyMs = {};
  const ep = percentiles(elevenMs); if (ep) latencyMs.speakEleven = ep;
  const lp = percentiles(localMs); if (lp) latencyMs.localizeLine = lp;
  const mutedButAnimating = logs.filter(
    (e) => e.hook === "_wfStartEleven" && e.detail && e.detail.routed === false
  ).length;
  return { runs: totalRuns, failedRuns, fallbackRateByStage, latencyMs, mutedButAnimating };
}

// Phase 2: JSONL export — one JSON per line, auto-descriptive header, metrics block.
function formatLogsAsJsonl(logs) {
  const extVer = (chrome.runtime && chrome.runtime.getManifest
    ? chrome.runtime.getManifest().version : "?");
  // Credential status snapshot (redacted — key value never included)
  const credStatus = (cfg._authStatus) || (cfg.elevenKey ? "unverified" : "unconfigured");
  const header = {
    schema: "yappable-log",
    v: 2,
    exportedAt: new Date().toISOString(),
    extensionVersion: extVer,
    userAgent: navigator.userAgent,
    credentialStatus: credStatus,
    fields: ["v", "runId", "parentId", "seq", "t", "iso", "ctx", "stage", "hook", "action", "outcome", "detail", "ms", "source"]
  };
  const lines = [JSON.stringify(header)];
  for (const e of logs) lines.push(JSON.stringify(e));
  const metrics = computeMetrics(logs);
  lines.push(JSON.stringify({ metrics }));
  return lines.join("\n") + "\n";
}

// Legacy TXT format (kept for human-readable copy-paste).
function formatLogs(logs) {
  const head = [
    "Yappable diagnostic log",
    `generated: ${new Date().toISOString()}`,
    `entries: ${logs.length}`,
    "format: [ISO] [run:ID] STAGE/hook · action → OUTCOME  {detail}",
    "—".repeat(60)
  ].join("\n");
  const lines = logs.map((e) => {
    const ms = e.ms != null ? ` (${e.ms}ms)` : "";
    const ctx = e.ctx ? ` [${e.ctx}]` : "";
    const run = e.runId ? ` [run:${e.runId}]` : "";
    const src = e.source ? ` [${e.source}]` : "";
    const detail = e.detail && Object.keys(e.detail).length ? "  " + JSON.stringify(e.detail) : "";
    return `[${e.iso}]${ctx}${run}${src} ${e.stage}/${e.hook} \xb7 ${e.action} → ${String(e.outcome).toUpperCase()}${ms}${detail}`;
  });
  return head + "\n" + lines.join("\n") + "\n";
}

function triggerDownload(content, mimeType, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

$("downloadLogs").addEventListener("click", () => {
  gatherAllLogs((logs, origin) => {
    if (!logs.length) {
      msg(cfg.debug ? "No logs captured yet." : "Turn on Debug logging first.");
      setTimeout(() => msg(""), 2500);
      return;
    }
    const text = formatLogs(logs);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(text, "text/plain", `yappable-log-${stamp}.txt`);
    msg(`Downloaded ${logs.length} entries (${origin}).`);
    setTimeout(() => msg(""), 2500);
  });
});

// Phase 2: JSONL download button
if ($("downloadLogsJsonl")) {
  $("downloadLogsJsonl").addEventListener("click", () => {
    gatherAllLogs((logs, origin) => {
      if (!logs.length) {
        msg(cfg.debug ? "No logs captured yet." : "Turn on Debug logging first.");
        setTimeout(() => msg(""), 2500);
        return;
      }
      const jsonl = formatLogsAsJsonl(logs);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      triggerDownload(jsonl, "application/x-ndjson", `yappable-log-${stamp}.jsonl`);
      msg(`Downloaded ${logs.length} entries as JSONL (${origin}).`);
      setTimeout(() => msg(""), 2500);
    });
  });
}

$("clearLogs").addEventListener("click", () => {
  // Phase 3: also clear breadcrumb ring
  chrome.storage.local.remove([LOG_STORE_KEY, BCUMB_KEY]);
  if (chrome.tabs?.query) {
    chrome.tabs.query({ url: "https://lovable.dev/*" }, (tabs) => {
      for (const tab of tabs || []) {
        if (!tab?.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "LN_CLEAR_LOGS" }, () => void chrome.runtime.lastError);
      }
    });
  }
  const el = $("logCount");
  if (el) el.textContent = "no logs yet";
  msg("Logs cleared.");
  setTimeout(() => msg(""), 1800);
});

// ---------------------------------------------------------------------------
// Dropdown de idioma
// ---------------------------------------------------------------------------
function makeFlagPill(cc) {
  const span = document.createElement("span");
  span.className = "flag-pill";
  span.textContent = cc.toUpperCase();
  span.setAttribute("aria-hidden", "true");
  return span;
}

function buildLangDropdown() {
  const list = $("langList");
  list.replaceChildren();
  for (const [code, cc, name] of LANGS) {
    const o = document.createElement("div");
    o.className = "dd-opt";
    o.dataset.code = code;
    const label = document.createElement("span");
    label.textContent = name;
    o.append(makeFlagPill(cc), label);
    o.addEventListener("click", () => { set("lang", code); reflectLang(); $("langList").hidden = true; });
    list.appendChild(o);
  }
}
function reflectLang() {
  const resolved = resolveLang(cfg.lang);
  const [, cc] = LANGS.find((l) => l[0] === resolved) || LANGS[0];
  $("langBtn").replaceChildren(makeFlagPill(cc));
  $("langBtn").title = (LANGS.find((l) => l[0] === resolved) || LANGS[0])[2];
  $("langList").querySelectorAll(".dd-opt").forEach((o) => o.classList.toggle("sel", o.dataset.code === resolved));
  populateNativeVoices();
  reflectSummaries();
}
$("langBtn").addEventListener("click", (e) => { e.stopPropagation(); $("langList").hidden = !$("langList").hidden; });
document.addEventListener("click", () => { $("langList").hidden = true; });

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
// Phase 5: auth status labels
const AUTH_STATUS_LABELS = {
  unconfigured: "No API key",
  unverified: "Configured",
  verifying: "Verifying…",
  valid: "Verified ✓",
  invalid: "Invalid key",
  quota_exceeded: "Quota exceeded",
  network_error: "Network error"
};

function reflectKeyStatus() {
  const has = !!cfg.elevenKey;
  const status = cfg._authStatus || (has ? "unverified" : "unconfigured");
  const isOk = status === "valid";
  const isBad = ["invalid", "quota_exceeded", "network_error"].includes(status);
  const dot = $("keyDot");
  dot.classList.toggle("ok", isOk);
  dot.classList.toggle("bad", isBad);
  $("keyTxt").textContent = AUTH_STATUS_LABELS[status] || (has ? "Configured" : "No API key");
  $("keyAffiliate").hidden = has;
}
$("openSettings").addEventListener("click", () => {
  $("elevenKey").value = cfg.elevenKey;
  $("elevenKey").type = "password";
  $("settingsModal").hidden = false;
  refreshLogCount();
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
  L.info("config", "elevenKey", "chave ElevenLabs atualizada", { hasKey: !!k, changed });
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": cfg.elevenKey },
      signal: controller.signal
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return (data.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      lang: v.labels?.language || v.labels?.accent || ""
    }));
  } catch (err) {
    if (controller.signal.aborted) throw new Error("request timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
    const endDbg = L.start("engine", "loadElevenVoices", "GET /v1/voices (ElevenLabs)", { force });
    try {
      const voices = await fetchElevenVoices();
      chrome.storage.local.set({ [VOICE_CACHE_KEY]: { key: cfg.elevenKey, at: Date.now(), voices } });
      populateElevenVoices(voices);
      endDbg("ok", { count: voices.length });
      msg(`${voices.length} voices cached.`);
    } catch (e) {
      endDbg("fail", { err: e });
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
  $("cueVolume").value = cfg.cueVolume; $("cueVolumeOut").textContent = fmtPct(cfg.cueVolume);
  $("errorAlertEnabled").checked = cfg.errorAlertEnabled;
  $("errorVolume").value = cfg.errorVolume; $("errorVolumeOut").textContent = fmtPct(cfg.errorVolume);
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
  $("elevenStability").value = cfg.elevenStability; $("stabOut").textContent = fmtPct(cfg.elevenStability);
  $("elevenSimilarity").value = cfg.elevenSimilarity; $("simOut").textContent = fmtPct(cfg.elevenSimilarity);
  $("elevenStyle").value = cfg.elevenStyle; $("styleOut").textContent = fmtPct(cfg.elevenStyle);
  $("elevenSpeed").value = cfg.elevenSpeed; $("elevenSpeedOut").textContent = fmtSpeedPct(cfg.elevenSpeed);
  $("elevenTextNormalization").value = cfg.elevenTextNormalization;
  $("elevenSeedRandom").checked = cfg.elevenSeedRandom;
  $("elevenSeed").value = cfg.elevenSeed == null ? "" : cfg.elevenSeed;
  reflectSeed();
  reflectKeyStatus();
  updateReadDebug();

  // debug panel + toggle visibility
  $("debug").checked = cfg.debug;
  $("debugPanel").hidden = !cfg.debug;
}

// ---------------------------------------------------------------------------
// Carregar config
// ---------------------------------------------------------------------------
function load() {
  chrome.storage.sync.get({ ...DEFAULTS, mode: "", announce: "", lens: "" }, (stored) => {
    const legacyElevenKey = stored.elevenKey || "";
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

    // Resolve local data after sync. This prevents a slower sync callback from
    // overwriting the credential that a faster local callback just loaded.
    chrome.storage.local.get([LAST_OUTPUT_KEY, "elevenKey", "debug", "auth"], (local) => {
      lastOutput = local[LAST_OUTPUT_KEY] || null;
      // Phase 5: prefer auth credential; fall back to legacy elevenKey
      const auth = local.auth;
      const authKey = auth && auth.providers && auth.providers.elevenlabs
        && auth.providers.elevenlabs.credential && auth.providers.elevenlabs.credential.value;
      cfg.elevenKey = authKey || local.elevenKey || legacyElevenKey;
      cfg._authStatus = auth && auth.providers && auth.providers.elevenlabs
        && auth.providers.elevenlabs.status || null;
      cfg.debug = !!local.debug;

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
      if (cfg.elevenKey) loadElevenVoices(false);
      requestLastOutputFromTab();

      // Copy first, delete second: a failed local write must not destroy the
      // legacy sync credential during extension upgrades.
      if (legacyElevenKey && !local.elevenKey) {
        chrome.storage.local.set({ elevenKey: legacyElevenKey }, () => {
          if (!chrome.runtime.lastError) chrome.storage.sync.remove("elevenKey");
        });
      } else if (legacyElevenKey) {
        chrome.storage.sync.remove("elevenKey");
      }
    });
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
    // Phase 5: sync auth status and credential from storage changes
    if (changes.auth) {
      const auth = changes.auth.newValue;
      const authKey = auth && auth.providers && auth.providers.elevenlabs
        && auth.providers.elevenlabs.credential && auth.providers.elevenlabs.credential.value;
      if (authKey !== undefined) cfg.elevenKey = authKey || cfg.elevenKey;
      cfg._authStatus = auth && auth.providers && auth.providers.elevenlabs
        && auth.providers.elevenlabs.status || null;
      reflectKeyStatus();
    }
    if (changes.debug) {
      cfg.debug = !!changes.debug.newValue;
      $("debug").checked = cfg.debug;
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
bindToggle("elevenSeedRandom");
bindSelect("nativeVoice");
bindSelect("elevenVoiceId");
bindSelect("elevenModel");
bindSelect("elevenOutputFormat");
bindSelect("elevenTextNormalization");
bindNumber("elevenSeed");
bindRange("cueVolume", "cueVolumeOut", fmtPct);
bindRange("errorVolume", "errorVolumeOut", fmtPct);
bindRange("delayMs", "delayMsOut", 0);
bindRange("rate", "rateOut", 2);
bindRange("pitch", "pitchOut", 2);
bindRange("volume", "volumeOut", 2);
bindRange("elevenStability", "stabOut", fmtPct);
bindRange("elevenSimilarity", "simOut", fmtPct);
bindRange("elevenStyle", "styleOut", fmtPct);
bindRange("elevenSpeed", "elevenSpeedOut", fmtSpeedPct);

$("elevenSeedRandom").addEventListener("change", reflectSeed);
$("refreshVoices").addEventListener("click", () => loadElevenVoices(true));
$("resetNative").addEventListener("click", () => resetGroup("native"));
$("resetEleven").addEventListener("click", () => resetGroup("eleven"));
$("testNative").addEventListener("click", testNative);

window.addEventListener("unload", stopAll);

load();
