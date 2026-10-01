// ============================================================================
// tts-provider.js — Phase 4: TTS provider abstraction.
//
// Defines shared utilities consumed by both content.js (provider chain in
// drain()) and onboarding.js (key verification + quota display).
//
// Provider interface (implemented as closures in content.js):
//   { id: string, synthesize(text, epoch): Promise<void> }
//
// Shared utilities exposed via globalThis.YapTts:
//   verify(apiKey)  — verifies an ElevenLabs key via GET /v1/voices
//   quota(apiKey)   — fetches subscription info via GET /v1/user
// ============================================================================
((root) => {
  "use strict";

  const REQUEST_TIMEOUT_MS = 15000;
  const ELEVEN_ORIGINS = ["https://api.elevenlabs.io/*"];

  // api.elevenlabs.io is an optional host permission: it is requested only when
  // the user turns ElevenLabs on, so installs that stay on the native voice never
  // show the warning.
  function hasAccess() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.contains) return resolve(true);
        chrome.permissions.contains({ origins: ELEVEN_ORIGINS }, (ok) => resolve(!chrome.runtime.lastError && !!ok));
      } catch (_) { resolve(false); }
    });
  }

  // Must be called synchronously from a user gesture (click handler), before any await.
  function requestAccess() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.request) return resolve(true);
        chrome.permissions.request({ origins: ELEVEN_ORIGINS }, (ok) => resolve(!chrome.runtime.lastError && !!ok));
      } catch (_) { resolve(false); }
    });
  }

  // Verify an ElevenLabs API key. Returns { valid, voices?, reason?, status? }.
  async function verify(apiKey) {
    if (!apiKey) return { valid: false, reason: "no_key" };
    if (!(await hasAccess())) return { valid: false, reason: "no_permission" };
    const ctrl = new AbortController();
    const timeout = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
        headers: { "xi-api-key": apiKey },
        signal: ctrl.signal
      });
      if (res.status === 401) return { valid: false, reason: "invalid_key", status: 401 };
      if (res.status === 403) return { valid: false, reason: "forbidden", status: 403 };
      if (!res.ok) return { valid: false, reason: "api_error", status: res.status };
      const data = await res.json();
      const voices = (data.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        lang: (v.labels && (v.labels.language || v.labels.accent)) || ""
      }));
      return { valid: true, voices };
    } catch (err) {
      const reason = ctrl.signal.aborted ? "timeout" : "network_error";
      return { valid: false, reason, err: String(err && err.message || err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fetch ElevenLabs subscription quota via GET /v1/user.
  // Returns { tier, charLimit, charsUsed, resetAt } or null on failure.
  async function quota(apiKey) {
    if (!apiKey || !(await hasAccess())) return null;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": apiKey },
        signal: ctrl.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      const sub = data.subscription || {};
      return {
        tier: sub.tier || null,
        charLimit: sub.character_limit || null,
        charsUsed: sub.character_count || null,
        resetAt: sub.next_character_count_reset_unix || null
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  root.YapTts = { verify, quota, hasAccess, requestAccess };
})(typeof self !== "undefined" ? self : globalThis);
