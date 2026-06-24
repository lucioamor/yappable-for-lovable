// ============================================================================
// renderer.js - Renders IR -> speakable text (DETERMINISTIC fallback; the LLM
// path lives in content.js). Modes:
//
//   "fast"     - renderFast: isolate the pending question/action, else "clear".
//   "beginner" - short briefing: lead (intro/headings) + expected + top caveat.
//   "advanced" - same deterministic briefing as beginner (LLM differentiates).
//   "completo" - full read: intro, every section title/item, expected, all
//                risk caveats. No truncation anywhere.
//
// Legacy values (resumo/announce/lens) are mapped to these modes for backward
// compat (render() normalizes opts).
//
// _renderLang closure: render(ir, { lang }) sets it before sub-renderers run.
// ============================================================================
(function (root) {
  "use strict";

  // Legacy -> new mode mapping (old configs may still send these values).
  const MODES = ["fast", "beginner", "advanced", "completo"];
  const LEGACY_TO_MODE = {
    raw: "completo", full: "completo", technical: "completo",
    resumo: "beginner", summary: "beginner", title: "beginner",
    concise: "beginner", briefing: "beginner", body: "beginner"
  };
  function normalizeMode(m) {
    if (MODES.includes(m)) return m;
    return LEGACY_TO_MODE[m] || "beginner";
  }

  // Set by render() before calling sub-renderers — avoids threading lang through
  // every helper. "pt-BR" by default for backward compat.
  let _renderLang = "pt-BR";
  const _isEn = () => _renderLang.startsWith("en");

  function normTokens(s, style) {
    if (!s) return "";
    const en = _isEn();
    let out = String(s);

    if (en) {
      out = out
        .replace(/\s*→\s*/g, " to ")
        .replace(/\s*—\s*/g, " - ")
        .replace(/~\s*/g, "approximately ")
        .replace(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*s\b/gi, "$1 to $2 seconds")
        .replace(/(\d+(?:[.,]\d+)?)\s*s\b/gi, "$1 seconds");
    } else {
      out = out
        .replace(/\s*→\s*/g, " para ")
        .replace(/\s*—\s*/g, " - ")
        .replace(/~\s*/g, "aproximadamente ")
        .replace(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*s\b/gi, "$1 a $2 segundos")
        .replace(/(\d+(?:[.,]\d+)?)\s*s\b/gi, "$1 segundos");
    }

    if (style === "natural") {
      out = en
        ? out
            .replace(/(\d+(?:[.,]\d+)?)\s*MB\b/gi, "$1 megabytes")
            .replace(/(\d+(?:[.,]\d+)?)\s*KB\b/gi, "$1 kilobytes")
        : out
            .replace(/(\d+(?:[.,]\d+)?)\s*MB\b/gi, "$1 megabytes")
            .replace(/(\d+(?:[.,]\d+)?)\s*KB\b/gi, "$1 quilobytes");
    } else {
      out = en
        ? out
            .replace(/(\d+(?:[.,]\d+)?)\s*MB\b/gi, "$1 megs")
            .replace(/(\d+(?:[.,]\d+)?)\s*KB\b/gi, "$1 k")
        : out
            .replace(/(\d+(?:[.,]\d+)?)\s*MB\b/gi, "$1 megas")
            .replace(/(\d+(?:[.,]\d+)?)\s*KB\b/gi, "$1 ká")
            .replace(/(\d+[.,]\d+)\s+megas\b/gi, "$1 mega")
            .replace(/\b1\s+megas\b/gi, "1 mega");
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function numWord(n) {
    if (_isEn()) {
      const w = ["zero", "one", "two", "three", "four", "five", "six"];
      return w[n] || String(n);
    }
    const w = ["zero", "uma", "duas", "três", "quatro", "cinco", "seis"];
    return w[n] || String(n);
  }

  function clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function join(parts, sep) {
    sep = sep || ". ";
    const cleaned = parts.map(clean).filter(Boolean);
    if (sep === ". ") {
      return cleaned
        .map((part, index) => index < cleaned.length - 1 ? part.replace(/[.!?]+$/g, "") : part)
        .join(sep);
    }
    return cleaned.join(sep);
  }

  function taskTitleOf(ir) {
    return clean(ir._taskTitle || "");
  }

  function introOf(ir) {
    return clean(ir._intro || "");
  }

  function sectionHeadings(ir) {
    return (ir._sections || []).map((s) => clean(s.title)).filter(Boolean).join(", ");
  }

  function bodyFallback(ir) {
    const body = ir._body || "";
    const fallback = _isEn() ? "Generation complete" : "Geração concluída";
    return clean(body.split(/[.\n]/).find(Boolean) || fallback);
  }

  const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

  function riskNotes(ir, opts) {
    const mode = normalizeMode(opts && (opts.mode || opts.detail));
    if (mode === "fast") return [];
    const slots = ((ir && ir.slots && ir.slots.risk) || [])
      .filter((slot) => clean(slot && slot.text))
      .slice()
      .sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0));
    const selected = mode === "completo" ? slots : slots.slice(0, 1);
    return selected.map((slot) => clean(slot.text));
  }

  function appendRiskNotes(text, ir, opts) {
    const base = clean(text);
    const normalizedBase = base.toLowerCase();
    const missing = riskNotes(ir, opts)
      .filter((note) => !normalizedBase.includes(note.toLowerCase()));
    return join([base, ...missing]);
  }

  // RESUMO: lead curto (seções ou intro) + o "Esperado:". A principal ressalva
  // de risco é anexada por render(), depois que o texto-base estiver pronto.
  function renderResumo(ir) {
    const headings = sectionHeadings(ir);
    const intro = introOf(ir);
    // Prefere a linha de abertura (intro) à lista crua de títulos de seção: um
    // "Olhei o histórico e o estado atual" fala melhor que "Urgente, Estratégico,
    // Escala". Títulos entram só quando não há intro.
    const lead = intro || headings || taskTitleOf(ir) || bodyFallback(ir);
    const exp = normTokens(ir._expected || "", "natural");
    return join([lead, exp]);
  }

  // COMPLETO: lê a resposta inteira — intro, cada seção (título + itens),
  // "Esperado:" e TODAS as ressalvas. Nenhum corte em lugar nenhum.
  function renderCompleto(ir) {
    const parts = [];
    const taskTitle = taskTitleOf(ir);
    if (taskTitle) parts.push(normTokens(taskTitle, "compact"));
    const intro = introOf(ir);
    if (intro) parts.push(normTokens(intro, "compact"));
    for (const section of ir._sections || []) {
      if (section.title) parts.push(clean(section.title));
      for (const item of section.items || []) parts.push(clean(item));
    }
    const exp = normTokens(ir._expected || "", "compact");
    if (exp) parts.push(exp);
    return join(parts) || normTokens(ir._body || ir._taskTitle, "compact");
  }

  // FAST (fallback determinístico): isola a próxima ação/decisão do usuário.
  // Procura, de trás pra frente, a última frase que é pergunta ("?") ou pedido
  // explícito. Sem nada pendente -> diz que pode seguir (localizado).
  const RE_PENDING =
    /(quer que eu|posso\b|gostaria que|precis[oa] de|confirme|escolh[ae]|qual\s+(você\s+)?(prefere|priorizar|prioriza)|do you want me to|should i\b|would you like|which (one )?(do you|should)|please confirm|let me know)/i;

  function renderFast(ir) {
    const body = clean(ir._body || "");
    const en = _isEn();
    const canned = en
      ? "You're clear to continue, nothing depends on you right now."
      : (_renderLang.startsWith("pt")
          ? "Pode seguir, nada depende de você por enquanto."
          : "You're clear to continue, nothing depends on you right now.");
    if (!body) return canned;
    const sentences = body.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (/\?\s*$/.test(sentences[i]) || RE_PENDING.test(sentences[i])) {
        return normTokens(sentences[i], "natural");
      }
    }
    return canned;
  }

  // opts: { mode: "fast"|"beginner"|"advanced"|"completo", lang }. Aceita valores
  // legados (resumo, announce/detail) via normalizeMode.
  function render(ir, opts) {
    if (!ir) return "";
    // Set closure lang BEFORE any sub-renderer runs.
    _renderLang = (opts && opts.lang) || "en-US";
    const mode = normalizeMode(opts && (opts.mode || opts.detail));
    if (mode === "completo") return appendRiskNotes(renderCompleto(ir), ir, { mode });
    if (mode === "fast") return renderFast(ir);
    // beginner/advanced compartilham o fallback determinístico (a diferença real
    // vive no system prompt do Prompt API; sem LLM, ambos dão o briefing curto).
    return appendRiskNotes(renderResumo(ir), ir, { mode });
  }

  function renderWithMeta(ir, opts) {
    const text = render(ir, opts);
    const riskSlots = (ir && ir.slots && ir.slots.risk) || [];
    return { text, riskFlags: riskSlots };
  }

  const api = { render, renderWithMeta, normalizeMode, riskNotes, appendRiskNotes };
  root.LovableRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
