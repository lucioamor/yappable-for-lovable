// ============================================================================
// eleven-stream.js — play ElevenLabs /stream MP3 while it downloads.
//
// open(res) starts reading the response body right away and keeps every chunk.
// mediaUrl() returns an object URL for an <audio> element: a MediaSource fed
// with the chunks received so far and the ones still coming, or a plain Blob
// URL when the download already finished. `done` resolves with the complete
// MP3 (for the cache) and rejects if the stream breaks or stalls.
// ============================================================================
((root) => {
  "use strict";

  const MIME = "audio/mpeg";
  const DEFAULT_STALL_MS = 15000;

  // MediaSource can only take MP3 here; PCM/Opus/μ-law formats use the full download.
  function supported(format) {
    try {
      return /^mp3_/.test(String(format || "")) &&
        typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(MIME);
    } catch (_) { return false; }
  }

  function join(chunks, bytes) {
    const out = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    return out.buffer;
  }

  // opts: { stallMs, onStall } — onStall runs when no chunk arrives for stallMs
  // (callers abort their fetch there, which makes `done` reject).
  function open(res, opts = {}) {
    const chunks = [];
    const listeners = new Set();
    const notify = () => { for (const fn of [...listeners]) fn(); };
    const stallMs = opts.stallMs || DEFAULT_STALL_MS;
    let bytes = 0, finished = false, failed = null, stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { try { opts.onStall && opts.onStall(); } catch (_) {} }, stallMs);
    };

    const reader = res.body.getReader();
    const done = (async () => {
      armStall();
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (value && value.byteLength) { chunks.push(value); bytes += value.byteLength; }
          armStall();
          notify();
        }
        if (!bytes) throw new Error("ElevenLabs stream returned no audio");
        finished = true;
        notify();
        return join(chunks, bytes);
      } catch (err) {
        failed = err || new Error("ElevenLabs stream failed");
        notify();
        throw failed;
      } finally {
        clearTimeout(stallTimer);
      }
    })();
    done.catch(() => {}); // callers that only play still get errors via the <audio> element

    function mediaUrl() {
      if (finished) return URL.createObjectURL(new Blob(chunks, { type: MIME }));
      const ms = new MediaSource();
      const url = URL.createObjectURL(ms);
      ms.addEventListener("sourceopen", () => {
        let sb;
        try { sb = ms.addSourceBuffer(MIME); } catch (_) { try { ms.endOfStream("decode"); } catch (_e) {} return; }
        let next = 0;
        const end = (reason) => {
          listeners.delete(pump);
          try { if (ms.readyState === "open") reason ? ms.endOfStream(reason) : ms.endOfStream(); } catch (_) {}
        };
        function pump() {
          if (ms.readyState !== "open" || sb.updating) return;
          if (next < chunks.length) {
            try { sb.appendBuffer(chunks[next++]); } catch (_) { end("decode"); }
            return;
          }
          if (failed) return end("network");
          if (finished) return end();
        }
        sb.addEventListener("updateend", pump);
        listeners.add(pump);
        pump();
      }, { once: true });
      return url;
    }

    return {
      done,
      mediaUrl,
      cancel() { try { reader.cancel(); } catch (_) {} },
      get finished() { return finished; },
      get failed() { return failed; },
      get bytes() { return bytes; }
    };
  }

  root.YapElevenStream = { supported, open, join };
})(typeof self !== "undefined" ? self : globalThis);
