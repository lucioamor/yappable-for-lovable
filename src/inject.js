// Roda no MAIN world (mundo JS da página), em document_start.
// Objetivo: silenciar o som de conclusão do Lovable e emitir um sinal preciso
// no exato momento em que o som tocaria (= confirmação de tarefa concluída).
(() => {
  "use strict";
  const MARK = "generation-complete.mp3";

  function notify() {
    try {
      window.postMessage({ __yappable: true, type: "completion" }, window.location.origin);
    } catch (_) {}
  }

  // WAV mudo válido (~1ms). Decodifica sem erro => silêncio limpo, sem ruído no console.
  function silentBlob() {
    const sampleRate = 8000;
    const samples = 8;
    const dataSize = samples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const w = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    w(0, "RIFF");
    v.setUint32(4, 36 + dataSize, true);
    w(8, "WAVE");
    w(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, "data");
    v.setUint32(40, dataSize, true); // samples já são zero = silêncio
    return new Blob([buf], { type: "audio/wav" });
  }

  // --- 1. Patch de fetch: detecta + silencia (curto-circuito, sem rede) ---
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      let url = "";
      try {
        url = typeof input === "string" ? input : (input && input.url) || "";
      } catch (_) {}
      if (url && url.includes(MARK)) {
        notify();
        // devolve WAV mudo válido => sem som, sem erro de decode
        return Promise.resolve(
          new Response(silentBlob(), {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "audio/wav" }
          })
        );
      }
      return origFetch.apply(this, arguments);
    };
  }

  // --- 2. Fallback: patch de play() para mutar áudio com essa URL ---
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        const src = this.currentSrc || this.src || "";
        if (src.includes(MARK)) {
          notify();
          this.muted = true;
          this.volume = 0;
          this.pause();
        }
      } catch (_) {}
      return origPlay.apply(this, arguments);
    };
  } catch (_) {}
})();
