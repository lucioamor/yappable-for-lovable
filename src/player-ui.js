// ============================================================================
// player-ui.js — floating player modal + keyboard shortcuts, source-agnostic.
//
// Any audio source registers with globalThis.YapPlayer:
//   { id, state() -> { active, paused, t, dur, rate }, toggle(), seek(sec),
//     setRate(r), stop() }
// Built-in source "site": the page's own TTS, controlled through media-hook.js
// (MAIN world) over window.postMessage. chat-narrator.js registers "own"
// (ElevenLabs / Web Speech).
//
// Shortcuts (e.code, layout-independent; Alt avoids the always-focused composer):
//   Alt+K play/pause   Alt+J −15 s   Alt+L +15 s
//   Alt+,  slower      Alt+. faster  Alt+0 1×      Esc stop (while playing)
// The speed is remembered (storage.local "playerRate") and applies to every source.
// ============================================================================
(() => {
  "use strict";

  const SEEK_S = 15;
  const RATE_STEP = 0.25;
  const RATE_MIN = 0.5;
  const RATE_MAX = 3;

  const sources = new Map();
  let current = null; // id of the source the modal controls
  let rate = 1;
  let onModeChange = null;
  let mode = "yappable";
  let dismissed = false;

  const clampRate = (r) => Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, r)) * 100) / 100;

  // ---- site source via MAIN-world bridge ------------------------------------
  let siteState = { active: false };
  const sendSite = (cmd, value) => window.postMessage({ "yap-ctl": true, cmd, value }, location.origin);
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data["yap-media"] !== true) return;
    const was = siteState.active;
    siteState = e.data.state || { active: false };
    if (siteState.active && !was) activate("site");
    render();
  });
  register({
    id: "site",
    state: () => siteState,
    toggle: () => sendSite("toggle"),
    seek: (s) => sendSite("seek", s),
    setRate: (r) => sendSite("rate", r),
    stop: () => sendSite("stop")
  });

  // ---- registry ---------------------------------------------------------------
  function register(src) { sources.set(src.id, src); }

  // A source that starts playing takes over; the others are stopped so voices
  // never overlap.
  function activate(id) {
    for (const [k, s] of sources) if (k !== id && s.state().active) s.stop();
    current = id;
    dismissed = false;
    const s = sources.get(id);
    if (s && s.state().rate !== rate) s.setRate(rate);
    render();
  }

  const cur = () => (current && sources.get(current)) || null;
  const curState = () => { const s = cur(); return s ? s.state() : { active: false }; };

  function setRate(r) {
    rate = clampRate(r);
    try { chrome.storage.local.set({ playerRate: rate }); } catch (_) {}
    sendSite("config", rate);
    const s = cur();
    if (s && s.state().active) s.setRate(rate);
    render();
  }

  try {
    chrome.storage.local.get({ playerRate: 1 }, (st) => {
      rate = clampRate(Number(st.playerRate) || 1);
      sendSite("config", rate);
      render();
    });
  } catch (_) {}

  const act = {
    toggle: () => { const s = cur(); if (s && s.state().active) s.toggle(); },
    back: () => { const s = cur(); if (s && s.state().active) s.seek(-SEEK_S); },
    fwd: () => { const s = cur(); if (s && s.state().active) s.seek(SEEK_S); },
    slower: () => setRate(rate - RATE_STEP),
    faster: () => setRate(rate + RATE_STEP),
    normal: () => setRate(1),
    stop: () => { const s = cur(); if (s) s.stop(); }
  };

  // ---- keyboard ---------------------------------------------------------------
  const KEYS = { KeyK: "toggle", KeyJ: "back", KeyL: "fwd", Comma: "slower", Period: "faster", Digit0: "normal" };
  window.addEventListener("keydown", (e) => {
    let a = null;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) a = KEYS[e.code];
    else if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const st = curState();
      if (st.active && !st.paused) a = "stop";
    }
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    act[a]();
  }, true);

  // ---- modal ------------------------------------------------------------------
  let host = null;
  let ui = null;

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const CSS = `
    :host { all: initial; }
    .card { --bg:#ffffff; --fg:#1f1f1f; --mut:#6b6b6b; --line:#e3e3e3; --acc:#e0457b; --btn:#f3f3f3;
      position: fixed; right: 16px; bottom: 96px; z-index: 2147483646; width: 272px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 10px 12px; box-sizing: border-box; }
    @media (prefers-color-scheme: dark) {
      .card { --bg:#1e1e1e; --fg:#ececec; --mut:#9a9a9a; --line:#333; --btn:#2a2a2a; }
    }
    .row { display: flex; align-items: center; gap: 6px; }
    .top { justify-content: space-between; margin-bottom: 8px; }
    .title { font-weight: 600; font-size: 12px; letter-spacing: .02em; }
    .seg { display: inline-flex; background: var(--btn); border-radius: 8px; padding: 2px; }
    .seg button { border: 0; background: transparent; color: var(--mut); font: inherit; font-size: 11px;
      padding: 3px 8px; border-radius: 6px; cursor: pointer; }
    .seg button[aria-pressed="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.15); }
    .x { border: 0; background: transparent; color: var(--mut); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; }
    .ctrl { justify-content: center; gap: 8px; }
    .ctrl button { border: 0; background: var(--btn); color: var(--fg); font: inherit; border-radius: 10px;
      height: 34px; min-width: 44px; cursor: pointer; font-size: 12px; }
    .ctrl button.main { background: var(--acc); color: #fff; min-width: 52px; font-size: 16px; }
    .ctrl button:disabled { opacity: .4; cursor: default; }
    .bot { justify-content: space-between; margin-top: 8px; color: var(--mut); font-size: 12px; }
    .spd { display: inline-flex; align-items: center; gap: 4px; }
    .spd button { border: 0; background: var(--btn); color: var(--fg); width: 24px; height: 22px; border-radius: 6px; cursor: pointer; }
    .spd b { color: var(--fg); min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
    .time { font-variant-numeric: tabular-nums; }
    .bar { height: 3px; background: var(--line); border-radius: 2px; margin-top: 8px; overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: var(--acc); }
    .idle { color: var(--mut); font-size: 12px; text-align: center; padding: 6px 0 2px; }
    .fab { position: fixed; right: 16px; bottom: 96px; z-index: 2147483646; width: 36px; height: 36px;
      border-radius: 50%; border: 0; background: #e0457b; color: #fff; cursor: pointer; font-size: 16px;
      box-shadow: 0 4px 14px rgba(0,0,0,.2); }
  `;

  function build() {
    host = document.createElement("div");
    host.id = "yappable-player";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <button class="fab" part="fab" title="Yappable" hidden>🔊</button>
      <div class="card" role="region" aria-label="Yappable player">
        <div class="row top">
          <span class="title">Yappable</span>
          <span class="seg" role="group" aria-label="Voice">
            <button data-mode="site" title="Use the site's own read-aloud voice">Site</button>
            <button data-mode="yappable" title="Yappable interpretation + your voice (ElevenLabs or system)">Yappable</button>
          </span>
          <button class="x" title="Hide">×</button>
        </div>
        <div class="live">
          <div class="row ctrl">
            <button data-a="back" title="Back 15 s (Alt+J)">−15</button>
            <button data-a="toggle" class="main" title="Play / pause (Alt+K)">⏸</button>
            <button data-a="fwd" title="Forward 15 s (Alt+L)">+15</button>
            <button data-a="stop" title="Stop (Esc)">■</button>
          </div>
          <div class="bar"><i></i></div>
          <div class="row bot">
            <span class="time">0:00 / 0:00</span>
            <span class="spd">
              <button data-a="slower" title="Slower (Alt+,)">−</button>
              <b title="Alt+0 resets">1.00×</b>
              <button data-a="faster" title="Faster (Alt+.)">+</button>
            </span>
          </div>
        </div>
        <div class="idle">Waiting for the next reply…</div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = {
      card: $(".card"), fab: $(".fab"), live: $(".live"), idle: $(".idle"),
      main: $('[data-a="toggle"]'), time: $(".time"), rate: $(".spd b"), bar: $(".bar i"),
      seek: [$('[data-a="back"]'), $('[data-a="fwd"]')],
      modes: [...root.querySelectorAll("[data-mode]")]
    };
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a) act[b.dataset.a]();
      else if (b.dataset.mode) { mode = b.dataset.mode; if (onModeChange) onModeChange(mode); render(); }
      else if (b.classList.contains("x")) { dismissed = true; render(); }
      else if (b.classList.contains("fab")) { dismissed = false; render(); }
    });
    (document.body || document.documentElement).appendChild(host);
  }

  function render() {
    if (!document.body) return;
    if (!host || !host.isConnected) build();
    const st = curState();
    const s = cur();
    ui.card.hidden = dismissed;
    ui.fab.hidden = !dismissed;
    ui.live.hidden = !st.active;
    ui.idle.hidden = !!st.active;
    ui.main.textContent = st.paused ? "▶" : "⏸";
    const seekable = !!(s && st.seekable !== false && st.dur);
    ui.seek.forEach((b) => { b.disabled = !seekable; });
    ui.time.textContent = `${fmt(st.t)} / ${fmt(st.dur)}`;
    ui.bar.style.width = st.dur ? `${Math.min(100, (st.t / st.dur) * 100)}%` : "0";
    ui.rate.textContent = `${rate.toFixed(2)}×`;
    ui.modes.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  }

  // Own sources don't push events; poll while something plays.
  setInterval(() => { if (curState().active || (host && !ui.live.hidden)) render(); }, 250);

  globalThis.YapPlayer = {
    register,
    activate,
    rate: () => rate,
    setMode: (m) => { mode = m; render(); },
    onModeChange: (fn) => { onModeChange = fn; },
    render
  };
})();
