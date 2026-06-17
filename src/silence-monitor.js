// ============================================================================
// silence-monitor.js — telemetria do silêncio
//
// CONSTRAINTS:
//   1. Fala pela FILA ÚNICA do content.js (self.LovableNarrator) — respeita o
//      motor escolhido (nativa/ElevenLabs) e a serialização 1-áudio-por-vez.
//      Nunca fala por conta própria: voz dupla simultânea é bug, não feature.
//   2. Narre timing + rótulo observado como citação. Nunca afirme verdade
//      interna do agente ("corrigiu", "concluiu") sem confirmação no DOM.
//   3. Só fala quando o estado persiste >= DEBOUNCE_MS (1.8s).
//
// Integração com content.js:
//   content.js chama self.LovableSilence.reset() em commitNarrate()
//   para sinalizar que a conclusão foi detectada e narrada.
// ============================================================================
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constantes de timing
  // ---------------------------------------------------------------------------
  const DEBOUNCE_MS       = 1800;  // min persistência antes de falar
  const TICK_MS           = 1000;  // cadência do loop de estado
  const SHORT_SILENCE_MS  = 8000;  // shimmer sumiu, sem conclusão → short_silence
  const LONG_SILENCE_MS   = 35000; // sem mudança → long_silence
  const STALL_MS          = 70000; // sem mudança → possible_stall
  const REPEAT_MS         = 20000; // re-anuncia nos estados long/stall

  // ---------------------------------------------------------------------------
  // Estado da máquina
  // ---------------------------------------------------------------------------
  let inWork         = false;
  let inSilence      = false;
  let workStartedAt  = 0;
  let silenceStartAt = 0;
  let lastSpokenAt   = 0;
  let lastDomMutationAt = 0;
  let workAnnounced  = false; // evita re-anunciar "está trabalhando" em loop
  let trackingId     = null;  // data-message-id da mensagem em andamento
  let taskTitle      = "";    // meaningful task label (non-noise)
  let taskStatus     = "";    // state word: "thinking", "working", etc.
  let started        = false;

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function cleanStr(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  function detectShimmer() {
    // "trabalho ativo" no DOM: o shimmer antigo OU o spinner do widget novo de
    // background task (SVG com animation task-status-spin).
    return !!document.querySelector(".animate-shimmer-gradient, [style*='task-status-spin']");
  }

  // Widget novo de background task (barra flutuante acima do chat-input). Mesma
  // âncora estável do content.js: o status sr-only "N background task(s)".
  // Devolve { title, desc } ou null.
  function readTaskWidget() {
    const status = [...document.querySelectorAll('[role="status"][aria-live]')]
      .find((s) => /background task/i.test(s.textContent || ""));
    if (!status) return null;
    const scope = status.parentElement || status;
    const btn = [...scope.querySelectorAll("li button")].pop();
    if (!btn) return null;
    const muted = btn.querySelector("span.text-muted-foreground");
    const desc = muted ? cleanStr(muted.textContent).replace(/^[\s:]+/, "") : "";
    const wrap = muted ? muted.parentElement : btn.querySelector("span.truncate");
    let title = "";
    if (wrap) {
      const c = wrap.cloneNode(true);
      c.querySelectorAll("span.text-muted-foreground").forEach((n) => n.remove());
      title = cleanStr(c.textContent);
    }
    return (title || desc) ? { title, desc } : null;
  }

  function topOf(el) {
    let n = el;
    while (n && n !== document.body) {
      const t = n.style && n.style.top;
      if (t) {
        const v = parseFloat(t);
        if (!Number.isNaN(v)) return v;
      }
      n = n.parentElement;
    }
    return -1;
  }

  function agentMessages() {
    return [...document.querySelectorAll('[data-message-id*="#ast:"]')]
      .map((el, i) => ({ el, top: topOf(el), i }))
      .sort((a, b) => (a.top - b.top) || (a.i - b.i))
      .map((x) => x.el);
  }

  function latestIncompleteMessage() {
    const msgs = agentMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i].querySelector('button[aria-label="Copy message"]')) return msgs[i];
      break; // a mais recente já está completa — não há trabalho em andamento
    }
    return null;
  }

  // Generic status words — informative but don't identify the task.
  // STATE words are spoken directly as the live action; a single gerund (any
  // "...ing" word, e.g. "Transcribing") counts too — that's the real on-screen
  // status, not the canned "working". TOOL words (read, edited) are dropped.
  const RE_TITLE_STATE = /^([a-zà-ú]+ing|thinking|thought.*|working|loading|trabalhando|pensando|carregando|gerando|escrevendo|lendo|analisando)\.{0,3}$/i;
  const RE_TITLE_NOISE = /^(read|edited?|typecheck)\.{0,3}$/i;

  function detectTaskTitle() {
    const scope = latestIncompleteMessage() || document;
    const el = scope.querySelector('[aria-label^="Open background task"]');
    let t = el ? cleanStr(el.getAttribute("title") || el.textContent) : "";
    // DOM novo: a task vive no widget flutuante (sem o aria-label antigo). Lê o
    // título (rótulo) — ou, se só houver a linha de ação curta, ela vira status.
    if (!t) {
      const w = readTaskWidget();
      if (w) t = w.title || w.desc;
    }
    if (!t) { taskStatus = ""; return ""; }
    if (RE_TITLE_STATE.test(t)) {
      taskStatus = t.toLowerCase().replace(/\.+$/, "");
      return "";
    }
    if (RE_TITLE_NOISE.test(t)) return "";
    taskStatus = "";
    return t;
  }

  // Devolve o ID da mensagem mais recente do agente que NÃO tem o botão de
  // cópia (= mensagem em andamento). null se não há nenhuma.
  function latestIncompleteId() {
    return latestIncompleteMessage()?.getAttribute("data-message-id") || null;
  }

  // Retorna true se a mensagem que estávamos rastreando agora tem o botão de
  // cópia (= conclusão confirmada no DOM).
  function isTrackedComplete() {
    if (!trackingId) return false;
    const el = document.querySelector(`[data-message-id="${CSS.escape(trackingId)}"]`);
    return el ? !!el.querySelector('button[aria-label="Copy message"]') : false;
  }

  // ---------------------------------------------------------------------------
  // Fala via fila única do content.js (motor configurado + serialização).
  // Se a fila estiver ocupada com a narração principal, o item entra como
  // transiente e espera a vez — nunca toca por cima.
  // ---------------------------------------------------------------------------
  function say(text) {
    if (!text || !root.LovableNarrator) return;
    try {
      root.LovableNarrator.say(text);
      lastSpokenAt = Date.now();
    } catch (_) {}
  }

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    return s === 1 ? "1 second" : s + " seconds";
  }

  function taskLabel() {
    if (taskTitle) return `labeled '${taskTitle}'`;
    if (taskStatus) return taskStatus; // "thinking", "working", etc.
    return "in progress";
  }

  // Full spoken phrase for the work announcement. Prefers the REAL on-screen
  // status (the live action word, e.g. "transcribing") over a generic label.
  // Returns "" when nothing is readable — we don't invent a hardcoded "working";
  // the content script's verbose path reads the actual task line, and silence/
  // stall announcements cover timing separately.
  function workPhrase() {
    if (taskStatus) return `Lovable is ${taskStatus}.`;
    if (taskTitle) return `Lovable is working on a task labeled '${taskTitle}'.`;
    return "";
  }

  // Fala se o debounce permitir.
  function trySpeak(text) {
    if (Date.now() - lastSpokenAt < DEBOUNCE_MS) return;
    say(text);
  }

  // ---------------------------------------------------------------------------
  // Entrar no estado de trabalho
  // ---------------------------------------------------------------------------
  function enterWork() {
    inWork        = true;
    inSilence     = false;
    workAnnounced = false;
    workStartedAt = Date.now();
    lastDomMutationAt = workStartedAt;
    taskStatus    = "";
    taskTitle     = detectTaskTitle();
    trackingId    = latestIncompleteId();
  }

  // ---------------------------------------------------------------------------
  // Reset (chamado por content.js em commitNarrate ou pelo tick ao detectar
  // conclusão no DOM)
  // ---------------------------------------------------------------------------
  function reset() {
    inWork        = false;
    inSilence     = false;
    workAnnounced = false;
    taskTitle     = "";
    taskStatus    = "";
    trackingId    = null;
    lastDomMutationAt = 0;
  }

  // ---------------------------------------------------------------------------
  // Loop de estado (1s)
  // ---------------------------------------------------------------------------
  function tick() {
    const n = Date.now();

    // Update title and status in real time
    const title = detectTaskTitle(); // also sets taskStatus as side effect
    if (title) taskTitle = title;

    // Detecção de conclusão via DOM (backup: content.js também chama reset())
    if (inWork && isTrackedComplete()) {
      reset();
      return;
    }

    const shimmer = detectShimmer();
    const incompleteId = latestIncompleteId();
    const hasWork = shimmer || !!incompleteId;

    // Conclusão robusta: nada em progresso no DOM (sem shimmer E a mensagem mais
    // recente do agente já tem botão de cópia → latestIncompleteId() == null) =
    // tarefa encerrou. Backstop pro caso do data-message-id mudar no fim do
    // stream, que faz isTrackedComplete() falhar e travaria o "há X segundos".
    if (inWork && !hasWork) {
      reset();
      return;
    }

    // Transição idle → work
    if (!inWork && hasWork) {
      enterWork();
      if (incompleteId) trackingId = incompleteId;
    }

    if (!inWork) return;

    // Transição shimmer ativo → silêncio
    if (!shimmer && !inSilence) {
      inSilence     = true;
      silenceStartAt = Math.max(lastDomMutationAt || n, n);
    } else if (shimmer && inSilence) {
      inSilence = false; // shimmer voltou
    }

    const elapsed = n - workStartedAt;
    const silenceAnchor = Math.max(silenceStartAt, lastDomMutationAt || 0);
    const silence = inSilence ? n - silenceAnchor : 0;

    // Anúncio de "trabalhando" (uma vez, após DEBOUNCE_MS com shimmer ativo).
    // Só fala se houver status/rótulo real legível — sem frase genérica inventada.
    if (!workAnnounced && shimmer && elapsed >= DEBOUNCE_MS) {
      const phrase = workPhrase();
      if (phrase) {
        workAnnounced = true;
        trySpeak(phrase);
        return;
      }
    }

    if (!inSilence) return;

    // --- Anúncios baseados em silêncio ---

    if (silence >= STALL_MS) {
      // possible_stall: re-anuncia a cada REPEAT_MS
      if (n - lastSpokenAt >= REPEAT_MS) {
        trySpeak(
          `Possible stall. Lovable has been running a task ${taskLabel()} for ${formatDuration(elapsed)} ` +
          `with no visible DOM changes.`
        );
      }
    } else if (silence >= LONG_SILENCE_MS) {
      if (n - lastSpokenAt >= REPEAT_MS) {
        trySpeak(
          `Lovable has been running a task ${taskLabel()} for ${formatDuration(elapsed)} ` +
          `with no visible changes in that time.`
        );
      }
    } else if (silence >= SHORT_SILENCE_MS) {
      if (n - lastSpokenAt > SHORT_SILENCE_MS) {
        trySpeak(
          `Lovable has been running a task ${taskLabel()} for ${formatDuration(elapsed)} ` +
          `with no new visible changes.`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver: detecção imediata (não espera o tick de 1s)
  // ---------------------------------------------------------------------------
  const mon = new MutationObserver(() => {
    lastDomMutationAt = Date.now();
    const incompleteId = latestIncompleteId();
    if (!inWork && (detectShimmer() || incompleteId)) {
      enterWork();
      if (incompleteId) trackingId = incompleteId;
    }
    if (inWork) {
      const t = detectTaskTitle(); // also sets taskStatus as side effect
      if (t) taskTitle = t;
    }
  });

  // ---------------------------------------------------------------------------
  // Start (mesmo delay do baseline do content.js)
  // ---------------------------------------------------------------------------
  function start() {
    if (started) return;
    started = true;
    mon.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-label", "title"]
    });
    setInterval(tick, TICK_MS);
  }

  setTimeout(start, 2500);

  // API pública: content.js chama reset() em commitNarrate
  root.LovableSilence = { reset };
  if (typeof module !== "undefined" && module.exports) module.exports = { reset };
})(typeof self !== "undefined" ? self : globalThis);
