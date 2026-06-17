// ============================================================================
// background.js — service worker mínimo (MV3).
//
// Único papel: contar quantas abas do lovable.dev estão abertas, para o content
// script decidir se a fala precisa identificar de qual projeto se trata. Com uma
// só aba não há ambiguidade e nenhum rótulo é dito.
//
// NÃO requer a permissão "tabs": o host_permission de https://lovable.dev/*
// já concede visibilidade da URL dessas abas em chrome.tabs.query (a query é
// filtrada pelo próprio padrão de host permitido).
// ============================================================================
"use strict";

// ============================================================================
// Idioma padrão = idioma do navegador, escolhido já na instalação (sem precisar
// abrir o popup). Só grava se o usuário ainda não tem idioma salvo — nunca
// sobrescreve uma escolha existente. Mantém em sync com a lista de LANGS do popup.
// ============================================================================
const SUPPORTED_LANGS = [
  "pt-BR", "pt-PT", "en-US", "en-GB", "es-ES", "es-MX", "fr-FR", "de-DE",
  "it-IT", "nl-NL", "pl-PL", "ru-RU", "tr-TR", "ar-SA", "hi-IN", "ja-JP",
  "ko-KR", "zh-CN"
];

function pickLang(ui) {
  if (!ui) return "en-US";
  const norm = ui.replace("_", "-").toLowerCase();
  const exact = SUPPORTED_LANGS.find((c) => c.toLowerCase() === norm);
  if (exact) return exact;
  const prefix = norm.split("-")[0];
  return SUPPORTED_LANGS.find((c) => c.split("-")[0].toLowerCase() === prefix) || "en-US";
}

// Seed gravado já na instalação, pra UI começar pré-selecionada (narração on,
// verboso off, modo beginner, cue + alerta de erro on). Só grava chaves AUSENTES
// — nunca sobrescreve escolha do usuário num update.
const INSTALL_SEED = {
  enabled: true,
  verboseEnabled: false,
  mode: "beginner",
  cueEnabled: true,
  errorAlertEnabled: true
};

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get({ lang: "" }, (st) => {
    if (st.lang) return; // já configurado: respeita a escolha do usuário
    let ui = "";
    try { ui = chrome.i18n.getUILanguage(); } catch (_) {}
    chrome.storage.sync.set({ lang: pickLang(ui) });
  });

  chrome.storage.sync.get(Object.keys(INSTALL_SEED), (st) => {
    const patch = {};
    for (const k in INSTALL_SEED) if (st[k] === undefined) patch[k] = INSTALL_SEED[k];
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });

  // Primeira instalação: abre o onboarding em tela cheia (chave da ElevenLabs).
  // Só na instalação real, e só se ainda não concluído.
  if (details && details.reason === "install") {
    chrome.storage.local.get({ onboardingDone: false }, (st) => {
      if (st.onboardingDone) return;
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL("popup/onboarding.html") });
      } catch (_) {}
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__yappable !== true || msg.type !== "countLovableTabs") return;
  try {
    chrome.tabs.query({ url: "https://lovable.dev/projects/*" }, (tabs) => {
      sendResponse({ count: Array.isArray(tabs) ? tabs.length : 1 });
    });
  } catch (_) {
    sendResponse({ count: 1 });
  }
  return true; // mantém o canal aberto para a resposta assíncrona
});
