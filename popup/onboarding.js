"use strict";

// ============================================================================
// onboarding.js — first-run, full-screen setup. Único objetivo: capturar a
// chave da ElevenLabs (ou deixar o usuário seguir na voz nativa) antes do
// primeiro uso. Marca `onboardingDone` em storage.local pra não reabrir.
// ============================================================================
const $ = (id) => document.getElementById(id);
const VOICE_CACHE_KEY = "elevenVoicesCache";
const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io/*";

const keyEl = $("key");
const activateEl = $("activate");
const msg = (t, ok) => { const m = $("msg"); m.textContent = t || ""; m.style.color = ok ? "var(--ok-strong)" : "var(--accent)"; };

function setStatus(state, text) {
  const wrap = $("status"), dot = $("dot");
  wrap.hidden = !text;
  dot.className = "dot" + (state ? " " + state : "");
  $("statusTxt").textContent = text || "";
}

function requestElevenLabsAccess() {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [ELEVENLABS_ORIGIN] }, (granted) => {
      resolve(!chrome.runtime.lastError && !!granted);
    });
  });
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
    // fecha a aba do onboarding; se não der, mostra confirmação.
    chrome.tabs?.getCurrent?.((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id);
      else msg("All set — you can close this tab.", true);
    });
  });
}

// Valida a chave de fato (GET /v1/voices). Sucesso -> guarda chave em local,
// ativa o motor ElevenLabs e cacheia as vozes pro popup já abrir populado.
$("activate").addEventListener("click", async () => {
  const key = keyEl.value.trim();
  if (!key) return;
  activateEl.disabled = true;
  setStatus("", "Verifying key…");
  msg("");
  try {
    if (!(await requestElevenLabsAccess())) {
      setStatus("bad", "ElevenLabs access is required to verify the key.");
      activateEl.disabled = false;
      return;
    }
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (res.status === 401) { setStatus("bad", "Invalid API key — check and try again."); activateEl.disabled = false; return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const voices = (data.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      lang: v.labels?.language || v.labels?.accent || ""
    }));
    setStatus("ok", `Key verified — ${voices.length} voices available.`);
    chrome.storage.local.set({
      elevenKey: key,
      [VOICE_CACHE_KEY]: { key, at: Date.now(), voices }
    });
    chrome.storage.sync.set({ engine: "elevenlabs" });
    msg("ElevenLabs activated. Opening Lovable…", true);
    setTimeout(finish, 700);
  } catch (e) {
    setStatus("bad", "Could not reach ElevenLabs: " + e.message);
    activateEl.disabled = false;
  }
});

// Segue na voz nativa: garante motor nativo e encerra.
$("skip").addEventListener("click", () => {
  chrome.storage.sync.set({ engine: "native" });
  finish();
});
