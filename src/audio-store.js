// ============================================================================
// audio-store.js — persistent ElevenLabs audio cache + narration history.
//
// Lives in the extension origin (IndexedDB in the service worker / popup), so
// every site shares one cache. Content scripts reach it through messages handled
// in background.js. One record per generated clip:
//   { key, text, voiceId, model, format, platform, pageUrl, at, lastUsed,
//     bytes, history, audio: Blob|null }
// `audio` and the record (history) are removable independently.
// ============================================================================
((root) => {
  "use strict";

  const DB_NAME = "yappable-audio";
  const STORE = "entries";
  const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

  // Everything that changes the generated audio must be part of the key.
  async function keyFor(p) {
    const parts = [
      p.text, p.voiceId, p.model, p.format,
      p.stability, p.similarity, p.style, p.speed, p.useSpeakerBoost ? 1 : 0,
      p.normalization, p.seed == null ? "" : p.seed, p.lang || ""
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Which entries lose their audio (and, if unlisted, the whole record) to fit maxBytes.
  // Oldest lastUsed first. Returns an array of keys.
  function pickEvictions(entries, maxBytes) {
    const withAudio = entries.filter((e) => e.audio || e.bytes > 0);
    let total = withAudio.reduce((n, e) => n + (e.bytes || 0), 0);
    const out = [];
    for (const e of withAudio.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))) {
      if (total <= maxBytes) break;
      out.push(e.key);
      total -= e.bytes || 0;
    }
    return out;
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }
  const wrap = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function store(mode) {
    const db = await open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }
  const allRaw = async () => wrap((await store("readonly")).getAll());

  async function get(key) {
    const e = await wrap((await store("readonly")).get(key));
    if (!e || !e.audio) return null;
    e.lastUsed = Date.now();
    await wrap((await store("readwrite")).put(e));
    return e;
  }

  // meta: { key, text, voiceId, model, format, platform, pageUrl, history }
  async function put(meta, blob, maxBytes) {
    const now = Date.now();
    const prev = await wrap((await store("readonly")).get(meta.key));
    const rec = {
      key: meta.key,
      text: meta.history ? meta.text : "",
      voiceId: meta.voiceId, model: meta.model, format: meta.format,
      platform: meta.platform || "",
      pageUrl: meta.history ? (meta.pageUrl || "") : "",
      at: prev && prev.at && prev.history ? prev.at : now,
      lastUsed: now,
      bytes: blob.size,
      history: !!(meta.history || (prev && prev.history)),
      audio: blob
    };
    await wrap((await store("readwrite")).put(rec));
    await prune(maxBytes || DEFAULT_MAX_BYTES);
    return rec;
  }

  async function prune(maxBytes) {
    const entries = await allRaw();
    for (const key of pickEvictions(entries, maxBytes)) await deleteAudio(key);
  }

  async function deleteAudio(key) {
    const e = await wrap((await store("readonly")).get(key));
    if (!e) return;
    if (!e.history) { await wrap((await store("readwrite")).delete(key)); return; }
    e.audio = null; e.bytes = 0;
    await wrap((await store("readwrite")).put(e));
  }

  async function deleteRecord(key) {
    const e = await wrap((await store("readonly")).get(key));
    if (!e) return;
    if (!e.audio) { await wrap((await store("readwrite")).delete(key)); return; }
    e.history = false; e.text = ""; e.pageUrl = ""; // keep the cached audio, drop the record
    await wrap((await store("readwrite")).put(e));
  }

  // History view: records only, newest first.
  async function list() {
    return (await allRaw())
      .filter((e) => e.history)
      .sort((a, b) => b.at - a.at)
      .map(({ audio, ...rest }) => ({ ...rest, hasAudio: !!audio }));
  }

  async function getAudio(key) {
    const e = await wrap((await store("readonly")).get(key));
    return e && e.audio || null;
  }

  async function clear() { await wrap((await store("readwrite")).clear()); }
  async function clearHistory() {
    for (const e of await allRaw()) if (e.history) await deleteRecord(e.key);
  }
  async function clearAudio() {
    for (const e of await allRaw()) if (e.audio) await deleteAudio(e.key);
  }
  async function usage() {
    const entries = await allRaw();
    return { bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0), clips: entries.filter((e) => e.audio).length };
  }

  root.YapAudioStore = {
    DEFAULT_MAX_BYTES, keyFor, pickEvictions, bufToB64, b64ToBuf,
    get, put, prune, deleteAudio, deleteRecord, list, getAudio, clear, clearAudio, clearHistory, usage
  };
})(typeof self !== "undefined" ? self : globalThis);
