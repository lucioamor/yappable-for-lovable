"use strict";

const DB_NAME = "yappable-audio-cache";
const DB_VERSION = 1;
const STORE = "audio";
const HISTORY_KEY = "yappableAudioHistory";
const FAILED_KEY = "yappableFailedAudioRequests";
const HISTORY_LIMIT = 250;
const player = document.getElementById("player");

let current = null;
const failedRequests = new Map();

async function rememberFailed(id, value) {
  failedRequests.set(id, value);
  try {
    const stored = await chrome.storage.session.get({ [FAILED_KEY]: {} });
    const failed = { ...stored[FAILED_KEY], [id]: value };
    const ids = Object.keys(failed);
    while (ids.length > 10) delete failed[ids.shift()];
    await chrome.storage.session.set({ [FAILED_KEY]: failed });
  } catch (_) {}
}

async function getFailed(id) {
  if (failedRequests.has(id)) return failedRequests.get(id);
  try {
    const stored = await chrome.storage.session.get({ [FAILED_KEY]: {} });
    return stored[FAILED_KEY][id] || null;
  } catch (_) { return null; }
}

async function forgetFailed(id) {
  failedRequests.delete(id);
  try {
    const stored = await chrome.storage.session.get({ [FAILED_KEY]: {} });
    const failed = { ...stored[FAILED_KEY] };
    delete failed[id];
    await chrome.storage.session.set({ [FAILED_KEY]: failed });
  } catch (_) {}
}

function emit(requestId, state, extra = {}) {
  chrome.runtime.sendMessage({
    __yappable: true,
    source: "offscreen",
    type: "audio.event",
    requestId,
    state,
    ...extra
  }).catch(() => {});
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "hash" });
        store.createIndex("lastAccess", "lastAccess");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try { result = operation(store); } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAudio(hash) {
  const row = await withStore("readonly", (store) => idbRequest(store.get(hash)));
  if (row) {
    row.lastAccess = Date.now();
    await withStore("readwrite", (store) => store.put(row));
  }
  return row || null;
}

async function putAudio(row, maxMb) {
  await withStore("readwrite", (store) => store.put(row));
  await enforceCacheLimit(maxMb);
}

async function deleteAudio(hash) {
  await withStore("readwrite", (store) => store.delete(hash));
}

async function allAudio() {
  return withStore("readonly", (store) => idbRequest(store.getAll()));
}

async function enforceCacheLimit(maxMb) {
  const limit = Math.max(1, Number(maxMb) || 100) * 1024 * 1024;
  const rows = await allAudio();
  let total = rows.reduce((sum, row) => sum + (row.size || row.blob?.size || 0), 0);
  let itemCount = rows.length;
  rows.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
  for (const row of rows) {
    if (total <= limit) break;
    await deleteAudio(row.hash);
    total -= row.size || row.blob?.size || 0;
    itemCount--;
    await updateHistory(row.hash, { audio_storage_ref: null });
  }
  await chrome.storage.local.set({
    yappableAudioCacheStats: { bytes: Math.max(0, total), items: itemCount, updatedAt: Date.now() }
  });
}

async function clearCache() {
  await withStore("readwrite", (store) => store.clear());
  const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
  const history = stored[HISTORY_KEY].map((item) => ({ ...item, audio_storage_ref: null }));
  await chrome.storage.local.set({
    [HISTORY_KEY]: history,
    yappableAudioCacheStats: { bytes: 0, items: 0, updatedAt: Date.now() }
  });
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[`*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stableObject(value[key]);
      return out;
    }, {});
  }
  return value;
}

async function requestHash(request, normalizedText) {
  const input = stableObject({
    normalized_text: normalizedText,
    voice_id: request.voiceId,
    model_id: request.modelId,
    output_format: request.outputFormat,
    voice_settings: request.voiceSettings,
    seed: request.seed,
    language_code: request.languageCode,
    apply_text_normalization: request.applyTextNormalization
  });
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getHistory() {
  const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
  return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

async function saveHistoryItem(item) {
  const history = await getHistory();
  const index = history.findIndex((entry) => entry.id === item.id);
  if (index >= 0) history[index] = { ...history[index], ...item };
  else history.unshift(item);
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, HISTORY_LIMIT) });
}

async function safeSaveHistory(item) {
  try { await saveHistoryItem(item); }
  catch (error) { item.history_error = error.message || String(error); }
}

async function updateHistory(hash, patch) {
  const history = await getHistory();
  let changed = false;
  for (let i = 0; i < history.length; i++) {
    if (history[i].request_hash === hash) {
      history[i] = { ...history[i], ...patch };
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

function makeHistoryItem(request, hash, normalizedText) {
  const now = Date.now();
  return {
    id: request.requestId,
    request_hash: hash,
    created_at: now,
    played_at: now,
    source_url: request.sourceUrl || "",
    source_title: request.sourceTitle || "",
    project_label: request.projectLabel || "",
    text_preview: normalizedText.slice(0, 180),
    text: request.saveFullText ? normalizedText : undefined,
    text_length: String(request.text || "").length,
    normalized_text_length: normalizedText.length,
    voice_id: request.voiceId,
    model_id: request.modelId,
    output_format: request.outputFormat,
    duration_seconds: null,
    status: "checking_cache",
    audio_storage_ref: null,
    reuse_count: 0,
    time_to_first_audio_ms: null,
    total_generation_time_ms: null,
    audio_size_bytes: null
  };
}

function requestBody(request, normalizedText) {
  const body = {
    text: normalizedText,
    model_id: request.modelId,
    voice_settings: request.voiceSettings,
    apply_text_normalization: request.applyTextNormalization || "on"
  };
  if (request.languageCode) body.language_code = request.languageCode;
  if (request.seed != null) body.seed = request.seed;
  return body;
}

function endpoint(request, stream) {
  const mode = stream ? "/stream" : "";
  return `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voiceId)}${mode}?output_format=${encodeURIComponent(request.outputFormat)}`;
}

function waitForEvent(target, success, failure) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`Audio ${failure || "error"}`)); };
    const cleanup = () => {
      target.removeEventListener(success, ok);
      if (failure) target.removeEventListener(failure, bad);
    };
    target.addEventListener(success, ok, { once: true });
    if (failure) target.addEventListener(failure, bad, { once: true });
  });
}

async function appendBuffer(sourceBuffer, chunk) {
  if (sourceBuffer.updating) await waitForEvent(sourceBuffer, "updateend", "error");
  sourceBuffer.appendBuffer(chunk);
  await waitForEvent(sourceBuffer, "updateend", "error");
}

async function stopCurrent(reason = "cancelled") {
  if (!current) return;
  const active = current;
  current = null;
  active.cancelled = true;
  try { active.controller?.abort(); } catch (_) {}
  try { player.pause(); player.removeAttribute("src"); player.load(); } catch (_) {}
  if (active.objectUrl) URL.revokeObjectURL(active.objectUrl);
  if (reason === "cancelled") {
    await safeSaveHistory({ ...active.history, status: "cancelled", played_at: Date.now() });
    emit(active.request.requestId, "cancelled");
  }
}

async function playBlob(blob, requestId, volume, state = "playing") {
  const objectUrl = URL.createObjectURL(blob);
  if (current) current.objectUrl = objectUrl;
  player.src = objectUrl;
  const level = Number(volume);
  player.volume = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 1;
  emit(requestId, state);
  await player.play();
  await waitForEvent(player, "ended", "error");
  const duration = Number.isFinite(player.duration) ? player.duration : null;
  URL.revokeObjectURL(objectUrl);
  if (current) current.objectUrl = "";
  return duration;
}

async function playStream(response, active) {
  if (!response.body) throw new Error("Streaming response has no body.");
  if (!window.MediaSource || !MediaSource.isTypeSupported("audio/mpeg")) {
    throw new Error("Progressive MP3 playback is not supported by this Chrome version.");
  }
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  active.objectUrl = objectUrl;
  player.src = objectUrl;
  const level = Number(active.request.volume);
  player.volume = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 1;
  await waitForEvent(mediaSource, "sourceopen", "error");
  const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let playbackStarted = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (active.cancelled) throw new DOMException("Cancelled", "AbortError");
    if (!value?.byteLength) continue;
    const copy = value.slice();
    chunks.push(copy);
    received += copy.byteLength;
    await appendBuffer(sourceBuffer, copy);
    if (!playbackStarted) {
      await player.play();
      playbackStarted = true;
      active.firstAudioAt = Date.now();
      emit(active.request.requestId, "playing", {
        timeToFirstAudioMs: active.firstAudioAt - active.startedAt
      });
    }
  }
  if (sourceBuffer.updating) await waitForEvent(sourceBuffer, "updateend", "error");
  if (mediaSource.readyState === "open") mediaSource.endOfStream();
  active.objectUrl = "";
  const blob = new Blob(chunks, { type: "audio/mpeg" });
  if (playbackStarted && !player.ended) await waitForEvent(player, "ended", "error");
  URL.revokeObjectURL(objectUrl);
  return {
    blob,
    received,
    duration: Number.isFinite(player.duration) ? player.duration : null
  };
}

async function fetchSpeech(request, normalizedText, stream, controller) {
  const response = await fetch(endpoint(request, stream), {
    method: "POST",
    headers: {
      "xi-api-key": request.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify(requestBody(request, normalizedText)),
    signal: controller.signal
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json())?.detail?.message || ""; } catch (_) {}
    throw new Error(`ElevenLabs ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

async function startRequest(request) {
  await stopCurrent("replaced");
  if (!request.outputFormat) throw new Error("No ElevenLabs audio quality is selected.");
  const local = await chrome.storage.local.get({ elevenKey: "" });
  if (!local.elevenKey) throw new Error("ElevenLabs API key is not configured.");
  request = { ...request, apiKey: local.elevenKey };
  const normalizedText = request.applyTextNormalization === "off"
    ? String(request.text || "").trim()
    : normalizeText(request.text);
  if (!normalizedText) throw new Error("Nothing to narrate.");
  const hash = await requestHash(request, normalizedText);
  const history = makeHistoryItem(request, hash, normalizedText);
  const active = {
    request, hash, history, normalizedText,
    controller: new AbortController(),
    startedAt: Date.now(),
    firstAudioAt: null,
    cancelled: false,
    objectUrl: ""
  };
  current = active;
  if (request.historyEnabled) await safeSaveHistory(history);
  emit(request.requestId, "checking_cache", { hash });

  try {
    if (request.cacheEnabled) {
      let cached = null;
      try { cached = await getAudio(hash); }
      catch (error) { history.cache_error = error.message || String(error); }
      if (cached?.blob) {
        history.status = "cached";
        history.audio_storage_ref = hash;
        history.reuse_count = (cached.reuseCount || 0) + 1;
        history.duration_seconds = cached.duration || null;
        cached.reuseCount = history.reuse_count;
        cached.lastAccess = Date.now();
        await withStore("readwrite", (store) => store.put(cached));
        if (request.historyEnabled) await safeSaveHistory(history);
        emit(request.requestId, "cache_hit", { hash });
        await playBlob(cached.blob, request.requestId, request.volume, "playing");
        emit(request.requestId, "completed", { status: "cached", hash });
        current = null;
        return;
      }
    }

    emit(request.requestId, request.streamingEnabled ? "streaming" : "generating");
    const response = await fetchSpeech(request, normalizedText, request.streamingEnabled, active.controller);
    let blob;
    let duration = null;
    if (request.streamingEnabled) {
      ({ blob, duration } = await playStream(response, active));
    } else {
      blob = await response.blob();
      active.firstAudioAt = Date.now();
      duration = await playBlob(blob, request.requestId, request.volume);
    }
    if (active.cancelled) return;

    history.status = request.streamingEnabled ? "streamed" : "fallback";
    history.time_to_first_audio_ms = active.firstAudioAt ? active.firstAudioAt - active.startedAt : null;
    history.total_generation_time_ms = Date.now() - active.startedAt;
    history.audio_size_bytes = blob.size;
    history.duration_seconds = duration;
    if (request.cacheEnabled) {
      emit(request.requestId, "saving_audio");
      try {
        await putAudio({ hash, blob, size: blob.size, duration, createdAt: Date.now(), lastAccess: Date.now(), reuseCount: 0 }, request.maxCacheSizeMb);
        history.audio_storage_ref = hash;
      } catch (error) {
        history.cache_error = error.message || String(error);
      }
    }
    if (request.historyEnabled) await safeSaveHistory(history);
    emit(request.requestId, "completed", { status: history.status, hash });
    current = null;
  } catch (error) {
    if (active.cancelled || error?.name === "AbortError") return;
    try { active.controller.abort(); } catch (_) {}
    try { player.pause(); player.removeAttribute("src"); player.load(); } catch (_) {}
    if (active.objectUrl) {
      try { URL.revokeObjectURL(active.objectUrl); } catch (_) {}
      active.objectUrl = "";
    }
    const partial = !!active.firstAudioAt;
    history.status = partial ? "partial" : "failed";
    history.error = error.message || String(error);
    history.total_generation_time_ms = Date.now() - active.startedAt;
    if (request.historyEnabled) await safeSaveHistory(history);
    const { apiKey: _apiKey, ...safeRequest } = request;
    await rememberFailed(request.requestId, { request: safeRequest, normalizedText, hash, history });
    emit(request.requestId, partial ? "partial" : "fallback_available", {
      error: history.error,
      fallbackAvailable: true,
      hash
    });
    current = null;
  }
}

async function playFallback(id, outputFormat) {
  const failed = await getFailed(id);
  if (!failed) throw new Error("The failed request is no longer available. Narrate it again first.");
  const request = {
    ...failed.request,
    outputFormat: outputFormat || failed.request.outputFormat,
    streamingEnabled: false
  };
  request.requestId = `${id}-fallback-${Date.now()}`;
  await forgetFailed(id);
  await startRequest(request);
}

async function handleAction(action) {
  if (action.name === "play") {
    const cached = await getAudio(action.hash);
    if (!cached?.blob) throw new Error("Saved audio was not found.");
    await stopCurrent("replaced");
    current = { request: { requestId: `cache-${Date.now()}` }, history: {}, cancelled: false, objectUrl: "" };
    await playBlob(cached.blob, current.request.requestId, 1);
    await updateHistory(action.hash, { played_at: Date.now(), status: "cached" });
    current = null;
    return;
  }
  if (action.name === "download") {
    const cached = await getAudio(action.hash);
    if (!cached?.blob) throw new Error("Saved audio was not found.");
    const url = URL.createObjectURL(cached.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = action.filename || `yappable-${action.hash.slice(0, 8)}.mp3`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (action.name === "deleteAudio") {
    await deleteAudio(action.hash);
    await updateHistory(action.hash, { audio_storage_ref: null });
    return;
  }
  if (action.name === "deleteRecord") {
    const history = (await getHistory()).filter((item) => item.id !== action.id);
    await forgetFailed(action.id);
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
    return;
  }
  if (action.name === "retryFallback") return playFallback(action.id, action.outputFormat);
  if (action.name === "clearCache") return clearCache();
  if (action.name === "clearHistory") {
    failedRequests.clear();
    await chrome.storage.session.remove(FAILED_KEY);
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
    return;
  }
  throw new Error("Unknown audio action.");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message?.__yappable !== true) return;
  if (message.type === "audio.play") {
    startRequest(message.request).catch((error) => {
      emit(message.request?.requestId, "failed", { error: error.message || String(error) });
    });
    sendResponse({ ok: true, requestId: message.request.requestId });
    return false;
  }
  if (message.type === "audio.stop") {
    stopCurrent("cancelled").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "audio.action") {
    handleAction(message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});
