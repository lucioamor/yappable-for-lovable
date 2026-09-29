"use strict";

// ============================================================================
// onboarding.js v2 — Phase 6: rebuilt on top of the auth model (Phase 5)
// and TtsProvider utilities (Phase 4).
//
// Writes to storage.local.auth instead of bare elevenKey + engine fields.
// Verification reuses YapTts.verify() (from tts-provider.js loaded below).
// Quota is fetched from GET /v1/user and shown before the user clicks away.
// "Skip" sets auth.activeEngine = "native" and marks elevenlabs as unconfigured.
// ============================================================================
const $ = (id) => document.getElementById(id);
const VOICE_CACHE_KEY = "elevenVoicesCache";
const REQUEST_TIMEOUT_MS = 15000;
const AUTH_V = 1;

const keyEl = $("key");
const activateEl = $("activate");
const msg = (t, ok) => {
  const m = $("msg");
  m.textContent = t || "";
  m.style.color = ok ? "var(--ok-strong)" : "var(--accent)";
};

function setStatus(state, text) {
  const wrap = $("status"), dot = $("dot");
  wrap.hidden = !text;
  dot.className = "dot" + (state ? " " + state : "");
  $("statusTxt").textContent = text || "";
}

function setQuota(account) {
  const el = $("quotaLine");
  if (!el) return;
  if (!account || account.charLimit == null) { el.hidden = true; return; }
  const used = account.charsUsed || 0;
  const limit = account.charLimit;
  const pct = Math.round(used / limit * 100);
  el.textContent = `Quota: ${used.toLocaleString()} / ${limit.toLocaleString()} characters used (${pct}%)`;
  el.hidden = false;
}

keyEl.addEventListener("input", () => {
  const has = keyEl.value.trim().length > 0;
  activateEl.disabled = !has;
  setStatus("", "");
  msg("");
});

$("reveal").addEventListener("click", () => {
  keyEl.type = keyEl.type === "password" ? "text" : "password";
});

function finish() {
  chrome.storage.local.set({ onboardingDone: true }, () => {
    if (chrome.runtime.lastError) {
      msg("Could not save setup: " + chrome.runtime.lastError.message);
      activateEl.disabled = false;
      return;
    }
    chrome.tabs?.getCurrent?.((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id);
      else msg("All set — you can close this tab.", true);
    });
  });
}

// Phase 6: write auth object (Phase 5) using TtsProvider.verify() (Phase 4).
$("activate").addEventListener("click", async () => {
  const key = keyEl.value.trim();
  if (!key) return;
  activateEl.disabled = true;
  setStatus("", "Verifying key…");
  msg("");

  // Phase 4: use YapTts.verify() if available; fall back to inline fetch
  let verifyFn;
  if (typeof self !== "undefined" && self.YapTts && self.YapTts.verify) {
    verifyFn = (k) => self.YapTts.verify(k);
  } else {
    // Inline fallback (tts-provider.js not loaded in this page context)
    verifyFn = async (k) => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch("https://api.elevenlabs.io/v1/voices", {
          headers: { "xi-api-key": k },
          signal: ctrl.signal
        });
        if (res.status === 401) return { valid: false, reason: "invalid_key", status: 401 };
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const voices = (data.voices || []).map((v) => ({
          id: v.voice_id, name: v.name, lang: (v.labels && (v.labels.language || v.labels.accent)) || ""
        }));
        return { valid: true, voices };
      } catch (e) {
        const reason = ctrl.signal.aborted ? "timeout" : "network_error";
        return { valid: false, reason, err: String(e && e.message || e) };
      } finally {
        clearTimeout(timeout);
      }
    };
  }

  try {
    const result = await verifyFn(key);
    if (!result.valid) {
      const reasons = { invalid_key: "Invalid API key — check and try again.", timeout: "Request timed out.", network_error: "Could not reach ElevenLabs.", api_error: `API error (${result.status}).` };
      setStatus("bad", reasons[result.reason] || "Verification failed.");
      activateEl.disabled = false;
      return;
    }

    const voices = result.voices || [];
    setStatus("ok", `Key verified — ${voices.length} voices available.`);

    // Phase 6: fetch quota to show in UI and store in auth
    let account = null;
    try {
      const quotaFn = (typeof self !== "undefined" && self.YapTts && self.YapTts.quota)
        ? (k) => self.YapTts.quota(k)
        : async (k) => {
          const res2 = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": k } });
          if (!res2.ok) return null;
          const d = await res2.json();
          const sub = d.subscription || {};
          return { tier: sub.tier || null, charLimit: sub.character_limit || null, charsUsed: sub.character_count || null, resetAt: sub.next_character_count_reset_unix || null };
        };
      account = await quotaFn(key);
      setQuota(account);
    } catch (_) {}

    // Phase 5: write auth object
    const auth = {
      v: 1,
      activeEngine: "elevenlabs",
      providers: {
        elevenlabs: {
          credential: { type: "apiKey", value: key, addedAt: Date.now(), lastVerifiedAt: Date.now() },
          status: "valid",
          account,
          voices,
          voicesAt: Date.now()
        }
      }
    };

    chrome.storage.local.set({
      elevenKey: key, // keep legacy field for backward compat
      auth,
      [VOICE_CACHE_KEY]: { key, at: Date.now(), voices }
    }, () => {
      if (chrome.runtime.lastError) {
        setStatus("bad", "Could not save the API key: " + chrome.runtime.lastError.message);
        activateEl.disabled = false;
        return;
      }
      chrome.storage.sync.set({ engine: "elevenlabs" }, () => {
        if (chrome.runtime.lastError) {
          setStatus("bad", "Could not activate ElevenLabs: " + chrome.runtime.lastError.message);
          activateEl.disabled = false;
          return;
        }
        msg("ElevenLabs activated. Opening Lovable…", true);
        setTimeout(finish, 700);
      });
    });
  } catch (e) {
    setStatus("bad", "Could not reach ElevenLabs: " + (e && e.message || String(e)));
    activateEl.disabled = false;
  }
});

// Phase 6: "Use native voice" — sets auth.activeEngine = "native".
$("skip").addEventListener("click", () => {
  const auth = {
    v: AUTH_V,
    activeEngine: "native",
    providers: {
      elevenlabs: {
        credential: null,
        status: "unconfigured",
        account: null,
        voices: [],
        voicesAt: null
      }
    }
  };
  chrome.storage.local.set({ auth }, () => {
    if (chrome.runtime.lastError) {
      msg("Could not save setup: " + chrome.runtime.lastError.message);
      return;
    }
    chrome.storage.sync.set({ engine: "native" }, () => {
      if (chrome.runtime.lastError) {
        msg("Could not save setup: " + chrome.runtime.lastError.message);
        return;
      }
      finish();
    });
  });
});
