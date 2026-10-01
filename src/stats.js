// Local-only narration counters, bucketed by calendar day.
(() => {
  "use strict";
  const KEY = "yappableStatsV1";
  const WPM = 150;
  const dayKey = (at = new Date()) => {
    const y = at.getFullYear();
    const m = String(at.getMonth() + 1).padStart(2, "0");
    const d = String(at.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  const wordsOf = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;

  function record(text, platform, seconds) {
    const words = wordsOf(text);
    if (!words) return;
    const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : words / WPM * 60;
    chrome.storage.local.get({ [KEY]: { v: 1, days: {} } }, (st) => {
      const stats = st[KEY] && st[KEY].v === 1 ? st[KEY] : { v: 1, days: {} };
      const key = dayKey();
      const day = stats.days[key] || { words: 0, seconds: 0, narrations: 0, platforms: {} };
      const id = platform || "unknown";
      const p = day.platforms[id] || { words: 0, seconds: 0, narrations: 0 };
      day.words += words;
      day.seconds += duration;
      day.narrations += 1;
      p.words += words;
      p.seconds += duration;
      p.narrations += 1;
      day.platforms[id] = p;
      stats.days[key] = day;
      chrome.storage.local.set({ [KEY]: stats });
    });
  }

  globalThis.YapStats = { KEY, dayKey, wordsOf, record };
})();
