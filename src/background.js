// ============================================================================
// background.js — service worker (MV3).
//
// Roles:
//   1. Count open Lovable project tabs (content script queries this).
//   2. Phase 1: Log sink — receives __yapLog messages from content/popup and
//      routes them to YapLog.receive() (background-mode logger owns the ring).
//   3. Phase 5: Auth model — owns the `auth` object in storage.local, seeds
//      it on install, migrates legacy elevenKey on first run.
// ============================================================================
"use strict";

// Background-mode logger (IS_BG=true path in logger.js). Owns the run ring
// and breadcrumb ring. importScripts resolved relative to src/.
try { importScripts("logger.js"); } catch (_) {}
try { importScripts("audio-store.js"); } catch (_) {}
const L = globalThis.YapLog || {
  ok() {}, info() {}, fallback() {}, fail() {}, start: () => () => {},
  receive() {}, closeRun() {}
};

// ============================================================================
// Language seeding
// ============================================================================
const SUPPORTED_LANGS = [
  "pt-BR", "pt-PT", "en-US", "en-GB", "es-ES", "es-MX", "fr-FR", "de-DE",
  "it-IT", "nl-NL", "pl-PL", "ru-RU", "tr-TR", "ar-SA", "hi-IN", "ja-JP",
  "ko-KR", "zh-CN"
];

function pickLang(ui) {
  if (!ui) return "en-US";
  const norm = ui.replace("_", "-").toLowerCase();
  const exact = SUPPORTED_LANGS.find((c) => c.toLowerCase() === norm);
  if (exact) return exact;
  const prefix = norm.split("-")[0];
  return SUPPORTED_LANGS.find((c) => c.split("-")[0].toLowerCase() === prefix) || "en-US";
}

const INSTALL_SEED = {
  enabled: true,
  lovableEnabled: true,
  verboseEnabled: false,
  mode: "beginner",
  cueEnabled: true,
  errorAlertEnabled: true,
  waveformEnabled: true
};

// ============================================================================
// Phase 5: Auth model
// ============================================================================
const AUTH_V = 1;

function defaultAuth() {
  return {
    v: AUTH_V,
    activeEngine: "native",
    providers: {
      elevenlabs: {
        credential: null,
        status: "unconfigured", // unconfigured|unverified|verifying|valid|invalid|quota_exceeded|network_error
        account: null,
        voices: [],
        voicesAt: null
      }
    }
  };
}

// Build an auth object from a legacy elevenKey string (migration path).
function authFromLegacyKey(elevenKey) {
  const auth = defaultAuth();
  if (elevenKey) {
    auth.providers.elevenlabs.credential = {
      type: "apiKey",
      value: elevenKey,
      addedAt: null,
      lastVerifiedAt: null
    };
    auth.providers.elevenlabs.status = "unverified";
  }
  return auth;
}

// Ensure the auth object exists in storage.local; migrate from elevenKey if needed.
function ensureAuth() {
  chrome.storage.local.get({ elevenKey: "", auth: null }, (local) => {
    if (chrome.runtime.lastError) return;
    if (local.auth && local.auth.v === AUTH_V) return; // already migrated
    const auth = authFromLegacyKey(local.elevenKey || "");
    chrome.storage.local.set({ auth }, () => {
      if (chrome.runtime.lastError) return;
      L.info("config", "ensureAuth", "auth inicializado/migrado", { hadKey: !!local.elevenKey });
    });
  });
}

function ensureCurrentSpeechModel() {
  chrome.storage.sync.get({ elevenModel: "eleven_flash_v2_5" }, (st) => {
    if (st.elevenModel === "eleven_turbo_v2_5" || st.elevenModel === "eleven_turbo_v2") {
      chrome.storage.sync.set({ elevenModel: "eleven_flash_v2_5" });
    }
  });
}

// ============================================================================
// onInstalled
// ============================================================================
chrome.runtime.onInstalled.addListener((details) => {
  L.info("install", "onInstalled", "extensão instalada/atualizada", { reason: details && details.reason });

  chrome.storage.sync.get({ lang: "" }, (st) => {
    if (st.lang) return;
    let ui = "";
    try { ui = chrome.i18n.getUILanguage(); } catch (_) {}
    const lang = pickLang(ui);
    chrome.storage.sync.set({ lang });
    L.ok("install", "onInstalled", "idioma inicial definido pelo navegador", { ui, lang });
  });

  chrome.storage.sync.get(Object.keys(INSTALL_SEED), (st) => {
    const patch = {};
    for (const k in INSTALL_SEED) if (st[k] === undefined) patch[k] = INSTALL_SEED[k];
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });

  if (details && details.reason === "install") {
    chrome.storage.local.get({ onboardingDone: false }, (st) => {
      if (st.onboardingDone) return;
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL("popup/onboarding.html") });
      } catch (_) {}
    });
  }

  // Phase 5: ensure auth object exists after install/update
  ensureAuth();
});

// Also ensure auth on startup (handles first run after update without reinstall)
ensureAuth();
ensureCurrentSpeechModel();

// ============================================================================
// ElevenLabs audio cache + history (IndexedDB in the extension origin).
// Content scripts run in the lovable.dev origin, so they ask the worker.
// Audio travels as base64: runtime messages are JSON-serialized.
// Returns true when it owns the message (async sendResponse).
// ============================================================================
const CACHE_DEFAULTS = { elevenCache: true, elevenHistory: true };

function handleCacheMessage(msg, sender, sendResponse) {
  if (msg.type !== "YAP_CACHE_GET" && msg.type !== "YAP_CACHE_PUT") return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const Store = globalThis.YapAudioStore;
  chrome.storage.sync.get(CACHE_DEFAULTS, async (st) => {
    const miss = msg.type === "YAP_CACHE_GET" ? { hit: false } : { ok: false };
    try {
      if (!st.elevenCache || !Store) return sendResponse(miss);
      if (msg.type === "YAP_CACHE_GET") {
        const e = await Store.get(String(msg.key));
        if (!e) return sendResponse(miss);
        sendResponse({ hit: true, b64: Store.bufToB64(await e.audio.arrayBuffer()) });
      } else {
        const blob = new Blob([Store.b64ToBuf(msg.b64)], { type: "audio/mpeg" });
        await Store.put({ ...msg.meta, key: String(msg.key), history: !!st.elevenHistory }, blob);
        sendResponse({ ok: true });
      }
    } catch (err) {
      L.fail("cache", msg.type, "falha no cache de áudio", { err });
      sendResponse(miss);
    }
  });
  return true;
}

// ============================================================================
// Message router
// ============================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Phase 1: log sink — entries forwarded from content / popup contexts
  if (msg.__yapLog) {
    const log = globalThis.YapLog;
    if (log && typeof log.receive === "function") {
      log.receive(msg.entry, !!msg.bcumb);
    }
    return false;
  }

  if (handleCacheMessage(msg, sender, sendResponse)) return true;

  // Tab count query from content scripts
  if (!msg.__yappable || msg.type !== "countLovableTabs") return;
  try {
    chrome.tabs.query({ url: "https://lovable.dev/projects/*" }, (tabs) => {
      const count = Array.isArray(tabs) ? tabs.length : 1;
      L.info("tabs", "countLovableTabs", "abas de projeto Lovable contadas", { count });
      sendResponse({ count });
    });
  } catch (err) {
    L.fail("tabs", "countLovableTabs", "falha ao contar abas; assume 1", { err });
    sendResponse({ count: 1 });
  }
  return true; // keep channel open for async sendResponse
});
