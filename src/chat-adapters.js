// ============================================================================
// chat-adapters.js — detect completed assistant replies on claude.ai / chatgpt.com /
// gemini.google.com / grok.com.
//
// DOM findings (live probes 2026-09-28, see docs/CHAT-SITES-DOM.md):
//   claude.ai   row: div[data-is-streaming]; flips "true" -> "false" at end.
//               text: .standard-markdown (blocks appended while streaming).
//               code: <pre> inside a wrapper div that also holds the lang label.
//   chatgpt.com msg: div[data-markdown-text-style="assistant-message"], id in
//               data-chatgpt-selection-message-id. Code: div[class*=CodeBlock].
//               While generating (incl. web search, where no message exists yet
//               for ~10s) the composer shows a stop button; data-markdown-animated
//               is present only while tokens render. The message id attribute
//               is assigned only AFTER streaming ends. Citations are
//               a[data-testid=chatgpt-citation] chips inside the paragraph.
//
// API (globalThis.YapChat):
//   detect()                        -> adapter | null for current host
//   watch({ onComplete(text, id, el) }) -> stop()
//     Fires once per generation cycle this watcher saw start (busy -> idle),
//     reading the last reply. History — on load or after switching
//     conversations in the SPA — is never read.
//   extractText(el)                 -> speakable text (exported for tests)
// ============================================================================
((root) => {
  "use strict";

  const SETTLE_MS = 1200;
  const SCAN_MS = 300;

  const LEAF_BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th";

  function extractText(el) {
    const clone = el.cloneNode(true);
    // Known wrappers first (code blocks, citation chips, Gemini disclaimers and
    // source lists). Must run before the <pre> climb below, which would
    // otherwise delete an ancestor that also holds the reply text.
    clone.querySelectorAll(
      "code-block, [class*=CodeBlock], [class*=chat-code-block], [data-testid=chatgpt-citation], " +
      "[data-search-result-target], a.no-copy, " +
      "span[data-not-prose]:has(a[target=_blank]), sources-list, message-actions, " +
      "[class*=disclaimer], button, [aria-hidden=true], sup"
    ).forEach((n) => n.remove());
    // Any <pre> left (claude.ai): drop the whole top-level block holding it,
    // because the language label ("js") sits in a sibling outside the <pre>.
    clone.querySelectorAll("pre").forEach((pre) => {
      let blk = pre;
      while (blk.parentElement && blk.parentElement !== clone) blk = blk.parentElement;
      blk.remove();
    });
    // A detached clone has no layout, so innerText glues list items together
    // ("Green teaBlack tea"). Join leaf blocks explicitly.
    const blocks = [...clone.querySelectorAll(LEAF_BLOCKS)]
      .filter((n) => !n.querySelector(LEAF_BLOCKS))
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    // U+2060 (word joiner) prefixes Grok's citation chips; drop stray ones.
    return (blocks.length ? blocks.join("\n") : (clone.textContent || "")).replace(/⁠/g, "").trim();
  }

  const claudeIds = new WeakMap();
  let claudeSeq = 0;

  const CHATGPT_STOP = '[data-testid="stop-button"], button[aria-label*="Parar"], button[aria-label*="Stop"]';

  const last = (list) => list[list.length - 1] || null;
  const READ_ALOUD_LABEL =
    /^(read aloud|ler em voz alta|leer en voz alta|lire à voix haute|vorlesen|leggi ad alta voce|voorlezen)$/i;

  const GEMINI_LISTEN = /^(ouvir|listen|escuchar|écouter|anhören|ascolta|luisteren)$/i;
  const GEMINI_MORE = /^(mostrar mais opções|show more options|mostrar más opciones|afficher plus d'options|weitere optionen anzeigen)$/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const geminiLoadedAt = Date.now();

  // The generation stop button is labelled "Parar a resposta do modelo" at first and a bare
  // "Parar"/"Stop" at other moments (the bare one is also up while audio plays; harmless,
  // because a reply that was already read is never read again).
  const GROK_STOP = /^(parar|stop|detener|arrêter|stopp)$|(parar a resposta|stop (the )?(model )?response|detener la respuesta|arrêter la réponse|antwort stoppen)/i;
  const GROK_MORE = /^(more actions|mais ações|más acciones|plus d'actions|weitere aktionen)$/i;
  const GROK_LISTEN = /^(ler em voz alta|read aloud|leer en voz alta|lire à voix haute|vorlesen|leggi ad alta voce)$/i;
  const GROK_BUSY_TAIL_MS = 90000; // how long after the stop button an empty reply still counts as "generating"
  let grokLastStopAt = 0;
  const grokAssistant = () => last(document.querySelectorAll('[data-testid="assistant-message"]'));
  const grokBody = (el) => el.querySelector(".response-content-markdown");
  // Radix menus open on pointerdown, not on click(); a bare .click() does nothing.
  const pressLikeMouse = (n) => {
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const C = t.startsWith("pointer") ? PointerEvent : MouseEvent;
      n.dispatchEvent(new C(t, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true }));
    }
    n.click();
  };

  const ADAPTERS = [
    {
      id: "claude",
      name: "Claude",
      rewritable: true, // media-hook.js can change the text the site sends to TTS
      match: (h) => h === "claude.ai",
      // Assistant rows only: user messages have no data-is-streaming.
      lastReply: () => last(document.querySelectorAll("[data-is-streaming]")),
      isBusy: () => !!document.querySelector('[data-is-streaming="true"]'),
      textOf: (el) => {
        const md = el.querySelectorAll(".standard-markdown");
        return [...md].map(extractText).filter(Boolean).join("\n");
      },
      keyOf: (el) => {
        if (!claudeIds.has(el)) claudeIds.set(el, "c" + ++claudeSeq);
        return claudeIds.get(el);
      },
      readAloudButton: (el) => el.querySelector("[data-testid=action-bar-read-aloud]"),
      // Claude's flag is authoritative; no settle wait needed.
      settleMs: 0
    },
    {
      id: "gemini",
      name: "Gemini",
      rewritable: true,
      match: (h) => h === "gemini.google.com",
      lastReply: () => last(document.querySelectorAll("model-response")),
      // The stop button only lasts a few seconds and the web-search phase after
      // it has no indicator, so also count "no message-actions yet" as busy —
      // but not right after load, when a finished reply may still be rendering.
      isBusy: () => {
        if (document.querySelector('button[aria-label="Parar resposta"], button[aria-label="Stop response"]')) return true;
        if (Date.now() - geminiLoadedAt < 6000) return false;
        const mr = last(document.querySelectorAll("model-response"));
        return !!mr && !mr.querySelector("message-actions");
      },
      textOf: (el) => {
        const mc = el.querySelector("message-content");
        return mc ? extractText(mc) : "";
      },
      keyOf: (el) => {
        const mc = el.querySelector("message-content");
        return (mc && mc.id) || null;
      },
      // "Ouvir" lives in the reply's "⋯" menu (a Material overlay), not the visible bar.
      readAloud: async (el) => {
        const more = [...el.querySelectorAll("message-actions button[aria-label]")]
          .find((b) => GEMINI_MORE.test(b.getAttribute("aria-label")));
        if (!more) return false;
        more.click();
        for (let i = 0; i < 15; i++) {
          await sleep(100);
          const item = [...document.querySelectorAll('[role="menuitem"], .mat-mdc-menu-item')]
            .find((n) => GEMINI_LISTEN.test((n.textContent || "").trim()));
          if (item) { item.click(); return true; }
        }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // close the menu
        return false;
      },
      settleMs: 500
    },
    {
      id: "grok",
      name: "Grok",
      rewritable: false, // read-response-audio-file/<id> sends only the response id
      match: (h) => h === "grok.com",
      // The user's prompt also uses .response-content-markdown; only assistant-message is the reply.
      lastReply: grokAssistant,
      // Grok's stop button disappears BEFORE the answer starts (search / thinking
      // phase), and the action bar is already there while the text is still empty.
      // So: stop button = busy, and an empty last reply stays busy for a while
      // after the stop button was seen; watch() then waits for the text to settle.
      isBusy: () => {
        const stop = [...document.querySelectorAll("button[aria-label]")]
          .some((b) => GROK_STOP.test(b.getAttribute("aria-label")));
        if (stop) { grokLastStopAt = Date.now(); return true; }
        const a = grokAssistant();
        return !!a && Date.now() - grokLastStopAt < GROK_BUSY_TAIL_MS && !grokBody(a)?.innerText.trim();
      },
      textOf: (el) => {
        const md = grokBody(el);
        return md ? extractText(md) : "";
      },
      keyOf: (el) => {
        const r = el.closest('[id^="response-"]');
        return (r && r.id) || null;
      },
      // ⋯ ("More actions", not localized) -> "Ler em voz alta" (localized). While
      // it reads, the same item says "Parar de ler", so only the idle label matches.
      readAloud: async (el) => {
        const resp = el.closest('[id^="response-"]') || el;
        const more = [...resp.querySelectorAll("button[aria-label]")]
          .find((b) => GROK_MORE.test(b.getAttribute("aria-label")));
        if (!more) return false;
        pressLikeMouse(more);
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          const item = [...document.querySelectorAll('[role="menuitem"]')]
            .find((n) => GROK_LISTEN.test((n.textContent || "").trim()));
          if (item) { item.click(); return true; }
        }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // close the menu
        return false;
      },
      // Text streams after the stop button is gone; wait for it to go quiet.
      settleMs: 2000
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      rewritable: false, // /synthesize sends only the message id, no text
      match: (h) => h === "chatgpt.com" || h === "chat.openai.com",
      lastReply: () => last(document.querySelectorAll('[data-markdown-text-style="assistant-message"]')),
      // Stop button spans the whole generation, including the web-search phase
      // where no reply element exists yet.
      isBusy: () => !!document.querySelector(CHATGPT_STOP + ", [data-markdown-animated]"),
      textOf: extractText,
      // Message id is only assigned AFTER streaming ends; fine, we key at the end.
      keyOf: (el) => {
        const holder = el.closest("[data-chatgpt-selection-message-id]");
        return (holder && holder.getAttribute("data-chatgpt-selection-message-id")) || null;
      },
      // No test id on this button: match its aria-label (localized). Walk up from
      // the reply but never past an ancestor holding another reply.
      readAloudButton: (el) => {
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if (a.querySelectorAll('[data-markdown-text-style="assistant-message"]').length > 1) return null;
          const b = [...a.querySelectorAll("button[aria-label]")]
            .find((x) => READ_ALOUD_LABEL.test(x.getAttribute("aria-label")));
          if (b) return b;
        }
        return null;
      },
      // Guards against the stop button disappearing a beat before final text.
      settleMs: SETTLE_MS
    }
  ];

  function detect(host = location.hostname) {
    return ADAPTERS.find((a) => a.match(host)) || null;
  }

  function watch({ onComplete }, adapter = detect()) {
    if (!adapter) return () => {};
    // Generation cycle: idle -> busy (seen) -> idle + settled -> read LAST reply.
    // Only a busy phase observed by this watcher arms a read, so history and
    // re-rendered old replies are never spoken.
    let armed = false;
    let lastText = "";
    let changedAt = 0;
    const spoken = new Set();
    let timer = null;

    const scan = () => {
      timer = null;
      const now = Date.now();
      const el = adapter.lastReply();
      const text = el ? adapter.textOf(el) : "";
      if (text !== lastText) { lastText = text; changedAt = now; }
      if (adapter.isBusy()) { armed = true; return; }
      if (!armed || !el || !text) return;
      if (now - changedAt < adapter.settleMs) return;
      armed = false;
      const key = adapter.keyOf(el) || text;
      if (spoken.has(key)) return;
      spoken.add(key);
      try { onComplete(text, key, el); } catch (_) {}
    };

    const schedule = () => { if (!timer) timer = setTimeout(scan, SCAN_MS); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    // Settle check needs a tick even when DOM goes quiet.
    const iv = setInterval(scan, SETTLE_MS / 2);
    scan();
    return () => { mo.disconnect(); clearInterval(iv); clearTimeout(timer); };
  }

  root.YapChat = { detect, watch, extractText };
})(typeof self !== "undefined" ? self : globalThis);
