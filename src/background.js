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
  chatgptEnabled: true,
  claudeEnabled: true,
  geminiEnabled: true,
  grokEnabled: true,
  verboseEnabled: false,
  mode: "beginner",
  cueEnabled: true,
  errorAlertEnabled: true,
  waveformEnabled: true,
  chatAnnouncementStyle: "concise"
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
// Cross-tab chat audio coordinator
//
// Reply jobs enter the queue as soon as a chat adapter sees completion. A job
// becomes ready only after its summary / ElevenLabs MP3 is prepared. The head
// of the queue is never bypassed, so playback order follows response order even
// when a later ElevenLabs request finishes first. Long-lived ports also keep the
// MV3 worker alive while a reply is playing.
// ============================================================================
const CHAT_AUDIO_URLS = [
  "https://claude.ai/*",
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://grok.com/*"
];
const PAUSED_HOLD_MS = 10 * 60 * 1000; // a paused reading keeps the floor this long
const PLAYING_STALE_MS = 30 * 60 * 1000;
const chatAudioQueue = [];
let activeChatAudio = null;
let checkingAudibleTabs = false;
let audibleRetry = null;
let holdTimer = null;

// One entry per connected chat tab (port): what that tab is sounding right now,
// whoever started it (a queued reply, or the user's click on the site's own
// button). Content scripts report it with YAP_PLAYBACK. Rules:
//   - one voice at a time: whoever starts playing PAUSES (never stops) the others,
//     so a tab's play button resumes only that tab's audio;
//   - a paused reading still holds the floor, so queued replies wait for it to
//     finish instead of talking over (or replacing) it.
const tabAudio = new Map(); // port -> { platform, state: "idle" | "playing" | "paused", since }

function meta(port) {
  let m = tabAudio.get(port);
  if (!m) { m = { platform: "chat", state: "idle", since: Date.now() }; tabAudio.set(port, m); }
  return m;
}

function send(port, message) {
  try { port.postMessage(message); return true; } catch (_) { return false; }
}

// Every tab's modal shows what plays elsewhere and what is queued.
function broadcastChatAudio() {
  const next = chatAudioQueue.map((job) => ({ platform: job.platform, ready: !!job.ready }));
  for (const port of tabAudio.keys()) {
    const others = [];
    for (const [p, m] of tabAudio) {
      if (p !== port && m.state !== "idle") others.push({ platform: m.platform, state: m.state });
    }
    send(port, { type: "YAP_QUEUE", others, next });
  }
}

// The tab that gets the floor pauses every other tab that is sounding.
function pauseOthers(except) {
  for (const [port, m] of tabAudio) {
    if (port === except || m.state !== "playing") continue;
    m.state = "paused";
    m.since = Date.now();
    send(port, { type: "YAP_PAUSE_NOW" });
  }
}

// Is anything holding the floor against the head job's tab? A tab's own paused
// reading never blocks its own new reply (it is replaced, as before).
function floorBlocked(headPort) {
  const now = Date.now();
  let expiry = Infinity;
  let blocked = false;
  for (const [port, m] of tabAudio) {
    if (m.state === "playing") { if (now - m.since < PLAYING_STALE_MS) blocked = true; } // a stuck "playing" must not block forever
    else if (m.state === "paused" && port !== headPort) {
      if (now - m.since < PAUSED_HOLD_MS) { blocked = true; expiry = Math.min(expiry, m.since + PAUSED_HOLD_MS); }
    }
  }
  if (blocked && expiry !== Infinity) {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holdTimer = null; pumpChatAudioQueue(); }, Math.max(1000, expiry - now + 50));
    if (holdTimer && typeof holdTimer.unref === "function") holdTimer.unref(); // Node test runs only
  }
  return blocked;
}

function removeChatAudioJob(port, jobId) {
  const index = chatAudioQueue.findIndex((job) => job.port === port && (!jobId || job.id === jobId));
  if (index >= 0) chatAudioQueue.splice(index, 1);
  if (activeChatAudio && activeChatAudio.port === port && (!jobId || activeChatAudio.id === jobId)) {
    activeChatAudio = null;
  }
}

function grantChatAudioHead() {
  if (activeChatAudio || !chatAudioQueue.length || !chatAudioQueue[0].ready) return;
  activeChatAudio = chatAudioQueue.shift();
  pauseOthers(activeChatAudio.port);
  if (!send(activeChatAudio.port, { type: "YAP_AUDIO_GRANTED", jobId: activeChatAudio.id })) {
    activeChatAudio = null;
    pumpChatAudioQueue();
    return;
  }
  broadcastChatAudio();
}

function pumpChatAudioQueue() {
  if (activeChatAudio || !chatAudioQueue.length || !chatAudioQueue[0].ready || checkingAudibleTabs) return;
  const head = chatAudioQueue[0];

  // The user asked for this one ("play next" in a modal): take the floor now.
  if (head.force) { grantChatAudioHead(); return; }

  // Something is playing (or paused mid-way) in another tab: the head waits its
  // turn. Re-evaluated on every playback report, so it starts when that ends.
  if (floorBlocked(head.port)) return;

  // This is a recovery guard, not the ordering mechanism: after a service
  // worker restart Chrome may still have site/native TTS playing. Wait for that
  // known chat audio to become quiet before granting the deterministic FIFO.
  if (!chrome.tabs || typeof chrome.tabs.query !== "function") {
    grantChatAudioHead();
    return;
  }
  checkingAudibleTabs = true;
  chrome.tabs.query({ url: CHAT_AUDIO_URLS, audible: true }, (tabs) => {
    checkingAudibleTabs = false;
    const failed = !!(chrome.runtime && chrome.runtime.lastError);
    if (!failed && Array.isArray(tabs) && tabs.length) {
      if (audibleRetry) clearTimeout(audibleRetry);
      audibleRetry = setTimeout(() => {
        audibleRetry = null;
        pumpChatAudioQueue();
      }, 500);
      return;
    }
    grantChatAudioHead();
  });
}

if (chrome.runtime.onConnect && typeof chrome.runtime.onConnect.addListener === "function") {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== "yappable-chat-audio") return;
    meta(port);

    port.onMessage.addListener((message) => {
      if (!message || !message.jobId) return;
      const m = meta(port);
      if (message.platform) m.platform = message.platform;
      if (message.type === "YAP_HELLO") {
        // A (re)connected tab describes what it is doing; the worker may have restarted.
        if (message.state === "playing" || message.state === "paused" || message.state === "idle") {
          if (m.state !== message.state) { m.state = message.state; m.since = Date.now(); }
          if (m.state === "playing") pauseOthers(port);
        }
        broadcastChatAudio();
        pumpChatAudioQueue();
      } else if (message.type === "YAP_PLAYBACK") {
        if (message.state !== "playing" && message.state !== "paused" && message.state !== "idle") return;
        if (m.state !== message.state) { m.state = message.state; m.since = Date.now(); }
        if (m.state === "playing") pauseOthers(port); // override: last to start wins, others pause
        broadcastChatAudio();
        pumpChatAudioQueue();
      } else if (message.type === "YAP_AUDIO_PLAY_NEXT") {
        if (activeChatAudio) {
          // The current reading is paused somewhere: "play" continues the queue from it.
          pauseOthers(activeChatAudio.port);
          send(activeChatAudio.port, { type: "YAP_RESUME_NOW" });
        } else if (chatAudioQueue.length) {
          chatAudioQueue[0].force = true;
          pumpChatAudioQueue();
        }
      } else if (message.type === "YAP_AUDIO_ENQUEUE") {
        if (chatAudioQueue.some((job) => job.id === message.jobId) ||
            (activeChatAudio && activeChatAudio.id === message.jobId)) return;
        chatAudioQueue.push({
          id: message.jobId,
          platform: message.platform || "chat",
          port,
          ready: false,
          enqueuedAt: Date.now()
        });
        broadcastChatAudio();
      } else if (message.type === "YAP_AUDIO_READY") {
        const job = chatAudioQueue.find((entry) => entry.port === port && entry.id === message.jobId);
        if (job) job.ready = true;
        broadcastChatAudio();
        pumpChatAudioQueue();
      } else if (message.type === "YAP_AUDIO_DONE" || message.type === "YAP_AUDIO_CANCEL") {
        removeChatAudioJob(port, message.jobId);
        broadcastChatAudio();
        pumpChatAudioQueue();
      }
    });

    port.onDisconnect.addListener(() => {
      for (let i = chatAudioQueue.length - 1; i >= 0; i--) {
        if (chatAudioQueue[i].port === port) chatAudioQueue.splice(i, 1);
      }
      if (activeChatAudio && activeChatAudio.port === port) activeChatAudio = null;
      tabAudio.delete(port);
      broadcastChatAudio();
      pumpChatAudioQueue();
    });
  });
}

// ============================================================================
// Message router
// ============================================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  // Phase 1: log sink — entries forwarded from content / popup contexts
  if (msg.__yapLog) {
    const log = globalThis.YapLog;
    if (log && typeof log.receive === "function") {
      log.receive(msg.entry, !!msg.bcumb);
    }
    return false;
  }

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
