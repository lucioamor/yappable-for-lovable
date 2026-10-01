// ============================================================================
// history.js — ElevenLabs cache usage + narration history in the settings modal.
// Reads IndexedDB directly (popup runs in the extension origin, same as the
// service worker that writes it).
// ============================================================================
"use strict";
(() => {
  const Store = globalThis.YapAudioStore;
  const listEl = document.getElementById("historyList");
  const usageEl = document.getElementById("cacheUsage");
  if (!Store || !listEl) return;

  let player = null;
  const stopPlayer = () => {
    if (!player) return;
    try { player.pause(); URL.revokeObjectURL(player.src); } catch (_) {}
    player = null;
  };

  const fmtMb = (b) => (b / 1048576).toFixed(1) + " MB";

  function button(label, title, onClick) {
    const b = document.createElement("button");
    b.className = "ghost mini";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await onClick(); } finally { b.disabled = false; }
    });
    return b;
  }

  async function render() {
    let entries = [], usage = { bytes: 0, clips: 0 };
    try { [entries, usage] = await Promise.all([Store.list(), Store.usage()]); } catch (_) {}
    usageEl.textContent = usage.clips
      ? `Cache: ${usage.clips} clip${usage.clips === 1 ? "" : "s"}, ${fmtMb(usage.bytes)} of ${fmtMb(Store.DEFAULT_MAX_BYTES)}`
      : "Cache: empty";
    listEl.replaceChildren();
    if (!entries.length) {
      const li = document.createElement("li");
      li.textContent = "No narrations yet.";
      listEl.appendChild(li);
      return;
    }
    for (const e of entries.slice(0, 100)) {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.className = "h-text";
      text.textContent = e.text || "(no text)";
      text.title = e.text || "";
      const meta = document.createElement("span");
      meta.className = "h-meta";
      meta.textContent = `${new Date(e.at).toLocaleString()} · ${e.platform || "chat"}${e.hasAudio ? " · " + fmtMb(e.bytes) : " · audio removed"}`;
      const actions = document.createElement("div");
      actions.className = "h-actions";
      if (e.hasAudio) {
        actions.appendChild(button("▶ Play", "Replay from the local cache (no API call)", async () => {
          const blob = await Store.getAudio(e.key);
          if (!blob) return render();
          stopPlayer();
          player = new Audio(URL.createObjectURL(blob));
          player.onended = stopPlayer;
          await player.play().catch(() => {});
        }));
        actions.appendChild(button("⬇ MP3", "Download the audio", async () => {
          const blob = await Store.getAudio(e.key);
          if (!blob) return render();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `yappable-${new Date(e.at).toISOString().slice(0, 10)}-${e.key.slice(0, 6)}.mp3`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }));
      }
      if (e.text) actions.appendChild(button("⧉ Copy", "Copy the text", () => navigator.clipboard.writeText(e.text).catch(() => {})));
      if (e.pageUrl) actions.appendChild(button("↗ Open", "Open the page it came from", async () => { chrome.tabs.create({ url: e.pageUrl }); }));
      if (e.hasAudio) actions.appendChild(button("🗑 Audio", "Delete the audio, keep the record", async () => { stopPlayer(); await Store.deleteAudio(e.key); render(); }));
      actions.appendChild(button("✕ Record", "Delete the record, keep the cached audio", async () => { await Store.deleteRecord(e.key); render(); }));
      li.append(text, meta, actions);
      listEl.appendChild(li);
    }
  }

  document.getElementById("clearAudioCache").addEventListener("click", async () => {
    stopPlayer(); await Store.clearAudio(); render();
  });
  document.getElementById("clearHistory").addEventListener("click", async () => {
    if (!confirm("Delete all narration records? Cached audio is kept.")) return;
    await Store.clearHistory(); render();
  });
  document.getElementById("openSettings").addEventListener("click", render);
  document.getElementById("elevenHistory").addEventListener("change", render);
})();
