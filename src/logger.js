// ============================================================================
// logger.js v2 — structured diagnostics (YapLog).
//
// Phase 1: background-as-sink. Content/popup relay log entries to the service
//   worker via sendMessage({ __yapLog: true, entry, bcumb }). Background owns
//   the run ring and persists to storage.local.yapLogs. Kills the 3-context
//   read-modify-write race (§8.1).
//
// Phase 3: always-on breadcrumb ring. Captures fail events regardless of the
//   debug toggle — bug reports never arrive empty. Persisted to yapBreadcrumbs.
//
// Context detection: IS_BG = typeof importScripts === "function" (SW only).
// All other contexts (content script, popup page) run in relay mode.
// ============================================================================
((root) => {
  "use strict";

  // True only inside the service worker (importScripts is not defined in
  // content scripts or popup pages).
  const IS_BG = typeof importScripts === "function";

  const TAG = "[Yappable]";
  const STORE_KEY = "yapLogs";
  const BCUMB_KEY = "yapBreadcrumbs";    // Phase 3: always-on fail ring
  const BCUMB_MAX = 50;                  // max breadcrumb entries
  const RING_MAX_RUNS = 40;              // BG: max complete runs kept
  const BG_FLUSH_DELAY = 700;            // debounce for storage persist (ms)
  const LOCAL_RING_MAX = 2000;           // relay: in-memory buffer cap

  const SECRET_RE = /key|token|secret|authorization|xi-api|password|cookie/i;

  let enabled = false;   // mirrors storage.local.debug
  let seq = 0;           // monotonic ordinal per context
  let currentRunId = null; // set via setRunId()

  // --- Shared helpers ---

  function here() {
    try {
      const p = location.pathname.match(/\/projects\/([^/]+)/);
      return p ? `proj:${p[1].slice(0, 8)}` : location.pathname.slice(0, 24);
    } catch (_) { return ""; }
  }

  function redact(val, depth) {
    depth = depth || 0;
    if (val == null) return val;
    const t = typeof val;
    if (t === "string") return val.length > 600 ? val.slice(0, 600) + `…(+${val.length - 600})` : val;
    if (t === "number" || t === "boolean") return val;
    if (val instanceof Error) return { error: val.name || "Error", message: String(val.message || val) };
    if (typeof DOMException !== "undefined" && val instanceof DOMException) {
      return { error: val.name || "DOMException", message: String(val.message || val) };
    }
    if (t === "object" && (val.name || val.message) && Object.keys(val).length === 0) {
      return { error: String(val.name || "Error"), message: String(val.message || val) };
    }
    if (depth >= 4) return "…";
    if (Array.isArray(val)) {
      const out = val.slice(0, 30).map((v) => redact(v, depth + 1));
      if (val.length > 30) out.push(`…(+${val.length - 30})`);
      return out;
    }
    if (t === "object") {
      const out = {};
      for (const k of Object.keys(val)) {
        out[k] = SECRET_RE.test(k)
          ? (val[k] ? `‹redacted:${String(val[k]).length}›` : "")
          : redact(val[k], depth + 1);
      }
      return out;
    }
    return String(val);
  }

  function consoleMirror(e) {
    const head = `${TAG} ${e.stage}/${e.hook} \xb7 ${e.action} → ${String(e.outcome).toUpperCase()}` +
      (e.ms != null ? ` (${e.ms}ms)` : "") +
      (e.runId ? ` [run:${e.runId}]` : "");
    const fn = e.outcome === "fail" ? console.error
      : e.outcome === "fallback" ? (console.info || console.log)
      : console.log;
    if (e.detail && Object.keys(e.detail).length) {
      try { fn(`${head} ${JSON.stringify(e.detail)}`); } catch (_) { fn(head); }
    } else {
      fn(head);
    }
  }

  function genRunId() {
    try {
      const arr = new Uint8Array(4);
      const c = (typeof crypto !== "undefined" ? crypto : (typeof self !== "undefined" ? self.crypto : null));
      if (c && c.getRandomValues) c.getRandomValues(arr);
      else for (let i = 0; i < 4; i++) arr[i] = Math.floor(Math.random() * 256);
      return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    }
  }

  function perf() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  function buildEntry(stage, hook, action, outcome, detail, ms) {
    const e = {
      v: 2,
      runId: currentRunId,
      parentId: null,
      seq: ++seq,
      t: Date.now(),
      iso: new Date().toISOString(),
      ctx: here(),
      stage: stage || "misc",
      hook: hook || "",
      action: action || "",
      outcome: outcome || "info",
      detail: detail ? redact(detail) : undefined
    };
    if (ms != null) e.ms = Math.round(ms);
    return e;
  }

  // =========================================================================
  // BACKGROUND MODE (service worker — IS_BG = true)
  // Owns the run ring and persists. Receives relayed entries from content/popup
  // via chrome.runtime.onMessage({ __yapLog: true }).
  // =========================================================================
  if (IS_BG) {
    const _runs = [];      // [{ runId, entries[], closed }] — oldest first
    let _openRun = null;   // currently open run (not yet superseded)
    const _sysEntries = []; // events with no runId (install, tabs, config)
    let _bgFlushTimer = null;
    const breadcrumbs = []; // Phase 3: always-on fail ring

    function _pruneRuns() {
      let closedCount = _runs.filter((r) => r.closed).length;
      while (closedCount > RING_MAX_RUNS) {
        const idx = _runs.findIndex((r) => r.closed);
        if (idx < 0) break;
        _runs.splice(idx, 1);
        closedCount--;
      }
    }

    function _bgAddToRing(entry) {
      if (entry.runId) {
        if (!_openRun || _openRun.runId !== entry.runId) {
          if (_openRun) { _openRun.closed = true; }
          _openRun = { runId: entry.runId, entries: [], closed: false };
          _runs.push(_openRun);
          _pruneRuns();
        }
        _openRun.entries.push(entry);
      } else {
        _sysEntries.push(entry);
        if (_sysEntries.length > 200) _sysEntries.splice(0, 1);
      }
    }

    function _bgScheduleFlush() {
      if (_bgFlushTimer) return;
      _bgFlushTimer = setTimeout(_bgFlushNow, BG_FLUSH_DELAY);
    }

    function _bgFlushNow() {
      _bgFlushTimer = null;
      const all = [
        ..._sysEntries,
        ..._runs.flatMap((r) => r.entries)
      ].sort((a, b) => a.t - b.t);
      try { chrome.storage.local.set({ [STORE_KEY]: all }); } catch (_) {}
      if (breadcrumbs.length) {
        const bc = breadcrumbs.slice();
        try { chrome.storage.local.set({ [BCUMB_KEY]: bc }); } catch (_) {}
      }
    }

    function _addBreadcrumb(entry) {
      breadcrumbs.push(Object.assign({}, entry, { source: "breadcrumb" }));
      if (breadcrumbs.length > BCUMB_MAX) breadcrumbs.splice(0, 1);
    }

    // Called by the __yapLog message handler in background.js.
    // isBcumbOnly = true means the sender had debug OFF; only capture in crumb ring.
    function _bgReceive(entry, isBcumbOnly) {
      if (!entry || typeof entry !== "object") return;
      // Phase 3: always capture fail outcomes in breadcrumb ring
      if (entry.outcome === "fail") _addBreadcrumb(entry);
      if (!isBcumbOnly) {
        _bgAddToRing(entry);
        if (enabled) { try { consoleMirror(entry); } catch (_) {} }
      }
      _bgScheduleFlush();
    }

    function _bgRecord(entry) {
      // Phase 3: always capture fail outcomes
      if (entry.outcome === "fail") _addBreadcrumb(entry);
      if (enabled) {
        _bgAddToRing(entry);
        try { consoleMirror(entry); } catch (_) {}
      }
      _bgScheduleFlush();
    }

    // Explicitly close the open run (called when run ID is cleared).
    function _closeRun(runId) {
      if (_openRun && (!runId || _openRun.runId === runId)) {
        _openRun.closed = true;
        _openRun = null;
        _bgScheduleFlush();
      }
    }

    function record(stage, hook, action, outcome, detail, ms) {
      _bgRecord(buildEntry(stage, hook, action, outcome, detail, ms));
    }

    function init() {
      try {
        chrome.storage.local.get({ debug: false }, (st) => {
          enabled = !!(st && st.debug);
          if (enabled) console.log(`${TAG} debug logging ON (background) — captura iniciada`);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes.debug) return;
          const next = !!changes.debug.newValue;
          if (next && !enabled) console.log(`${TAG} debug logging ON (background) — captura iniciada`);
          enabled = next;
        });
      } catch (_) {}
    }
    init();

    root.YapLog = {
      ok(stage, hook, action, detail) { record(stage, hook, action, "ok", detail); },
      info(stage, hook, action, detail) { record(stage, hook, action, "info", detail); },
      fallback(stage, hook, action, detail) { record(stage, hook, action, "fallback", detail); },
      fail(stage, hook, action, detail) { record(stage, hook, action, "fail", detail); },
      start(stage, hook, action, detail) {
        const t0 = perf();
        const base = detail || {};
        return (outcome, extra) => {
          record(stage, hook, action, outcome || "ok", { ...base, ...(extra || {}) }, perf() - t0);
        };
      },
      isOn() { return enabled; },
      // Background has no per-tab buffer; popup reads from storage.local.yapLogs.
      dump() { return []; },
      clear() {
        _runs.length = 0;
        _sysEntries.length = 0;
        _openRun = null;
        breadcrumbs.length = 0;
        if (_bgFlushTimer) { clearTimeout(_bgFlushTimer); _bgFlushTimer = null; }
        try { chrome.storage.local.remove([STORE_KEY, BCUMB_KEY]); } catch (_) {}
      },
      setRunId(id) { currentRunId = id || null; },
      genRunId,
      receive: _bgReceive,
      closeRun: _closeRun
    };
    return;
  }

  // =========================================================================
  // RELAY MODE (content script / popup page — IS_BG = false)
  // Sends entries to the background service worker via sendMessage. Maintains
  // a local mirror buffer so dump() returns fresh events for the popup's
  // LN_GET_LOGS path (which merges with persisted storage from background).
  // =========================================================================
  const buffer = []; // local mirror — populated only when debug is enabled

  function _relaySend(entry, isBcumbOnly) {
    try {
      chrome.runtime.sendMessage({ __yapLog: true, entry, bcumb: !!isBcumbOnly });
    } catch (_) {
      // SW sleeping or context invalidated — event stays in local buffer only.
    }
  }

  function record(stage, hook, action, outcome, detail, ms) {
    const entry = buildEntry(stage, hook, action, outcome, detail, ms);
    if (enabled) {
      buffer.push(entry);
      if (buffer.length > LOCAL_RING_MAX) buffer.splice(0, buffer.length - LOCAL_RING_MAX);
      try { consoleMirror(entry); } catch (_) {}
      _relaySend(entry, false);
    } else if (outcome === "fail") {
      // Phase 3: always relay fail events even when debug is off (breadcrumb ring)
      _relaySend(entry, true);
    }
  }

  function init() {
    try {
      chrome.storage.local.get({ debug: false }, (st) => {
        enabled = !!(st && st.debug);
        if (enabled) console.log(`${TAG} debug logging ON — captura iniciada`);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.debug) return;
        const next = !!changes.debug.newValue;
        if (next && !enabled) console.log(`${TAG} debug logging ON — captura iniciada`);
        enabled = next;
      });
    } catch (_) {}
  }
  init();

  root.YapLog = {
    ok(stage, hook, action, detail) { record(stage, hook, action, "ok", detail); },
    info(stage, hook, action, detail) { record(stage, hook, action, "info", detail); },
    fallback(stage, hook, action, detail) { record(stage, hook, action, "fallback", detail); },
    fail(stage, hook, action, detail) { record(stage, hook, action, "fail", detail); },
    start(stage, hook, action, detail) {
      const t0 = perf();
      const base = detail || {};
      return (outcome, extra) => {
        record(stage, hook, action, outcome || "ok", { ...base, ...(extra || {}) }, perf() - t0);
      };
    },
    isOn() { return enabled; },
    dump() { return buffer.slice(); },
    clear() { buffer.length = 0; },
    setRunId(id) { currentRunId = id || null; },
    genRunId
  };
})(typeof self !== "undefined" ? self : globalThis);
