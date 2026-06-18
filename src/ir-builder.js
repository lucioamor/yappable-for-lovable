// ============================================================================
// ir-builder.js - Intermediate Representation (IR) per Lovable output.
//
// Produces ONE IR per output. renderer.js renders (lens x detail) on demand from
// it, without precomputing a variants matrix.
//
// Input: result = { id, taskTitle, body, structure }
//   structure = { intro, sections:[{title, items[]}], expected }
//
// Output: {
//   id, at, taskTitle, domains,
//   slots: { changed, impact, risk, next },
//   metrics: [{ from, to, certainty, raw }],
//   _taskTitle, _intro, _sections, _expected, _body, _hasStructure
// }
//
// Fields prefixed with "_" are Phase 0 compatibility fields. Later phases can
// move rendering fully to slots and retire them.
// ============================================================================
(function (root) {
  "use strict";

  function extractMetrics(text) {
    if (!text) return [];
    const metrics = [];
    const s = String(text);

    const unit = "(ms|s(?:\\b|ecs?)|segundos?|seconds?|KB|MB|GB|TB|%)";
    const number = "(\\d+(?:[.,]\\d+)?)";
    const numberOrRange = "(\\d+(?:[.,]\\d+)?(?:\\s*[-–a]\\s*\\d+(?:[.,]\\d+)?)?)";
    const approx = "(?:cerca\\s+de\\s+|aproximadamente\\s+|~\\s*)?";
    const patterns = [
      // "de 20s para 3-4s" / "from 20s to 3s"
      new RegExp(`(?:de|from)\\s+${approx}${number}\\s*${unit}\\s*(?:para|to|→|->)\\s*${approx}${numberOrRange}\\s*${unit}`, "gi"),
      // "20s -> 3s" / "20s → 3s"
      new RegExp(`${number}\\s*${unit}\\s*(?:→|->)\\s*${approx}${numberOrRange}\\s*${unit}`, "gi")
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(s)) !== null) {
        metrics.push({
          from: { value: m[1], unit: m[2] },
          to: { value: m[3], unit: m[4] || m[2] },
          certainty: "needs_validation",
          raw: m[0]
        });
      }
    }

    return metrics;
  }

  function detectDomains(st, body) {
    const hay = [
      st.intro || "",
      (st.sections || []).map((s) => [s.title, ...(s.items || [])].join(" ")).join(" "),
      st.expected || "",
      body || ""
    ].join(" ");

    const domains = [];
    if (/\b(LCP|FCP|TTI|CLS|TTFB|INP|performance|desempenho|preload|carregament|lighthouse|web\s*vitals?|bundle|chunk)\b/i.test(hay))
      domains.push("performance");
    if (/\b(auth|autent|login|logout|sess[aã]o|session|token|senha|password|acesso)\b/i.test(hay))
      domains.push("auth");
    if (/\b(banco|database|sql|schema|migration|migra[cç]|prisma|supabase|drizzle)\b/i.test(hay))
      domains.push("database");
    if (/\b(api|endpoint|rota\b|route|fetch|request|response)\b/i.test(hay))
      domains.push("api");
    if (/\b(layout|css|responsiv|mobile|desktop|viewport|grid|flexbox)\b/i.test(hay))
      domains.push("layout");
    if (/\b(seo|meta\s*tags?|headings?|canonical|sitemap)\b/i.test(hay))
      domains.push("seo");
    return domains;
  }

  // Popula ir.slots.risk a partir de LovableRisk.detectRisks() (risk-detector.js).
  // risk-detector NÃO gera mais texto; gera flags. O renderer lê os slots.
  // Retorna [] se LovableRisk não estiver carregado (test/Node sem mock).
  function detectRiskSlots(st, body, lang) {
    if (!root.LovableRisk) return [];
    try {
      const { riskFlags } = root.LovableRisk.detectRisks({
        intro: st.intro, sections: st.sections, expected: st.expected, body: body || ""
      }, lang);
      // certainty sempre "needs_validation": detectado via regex, não medido.
      // Ordem: já está por severidade (detectRisks ordena).
      return riskFlags.map((f) => ({
        text: f.spokenNote,
        certainty: "needs_validation",
        source: f.type,
        severity: f.severity
      }));
    } catch (_) {
      return [];
    }
  }

  // Regex: items that look code-centric (file extensions, paths, JS keywords).
  // Used to separate technical items from UX/product-level descriptions.
  const RE_CODE_TERM = /\b(\.tsx?|\.jsx?|\.css|\.html|\.json|\.md\b|src\/|components\/|pages\/|hooks\/|lib\/|utils\/|import\b|export\b|function\b|const\b|let\b|var\b|async\b|await\b|useState|useEffect|useRef|interface\b)\b/i;

  function buildImpactSlots(changedSlots) {
    // UX/product perspective: high-level text only, no file-level detail.
    const uxSlots = changedSlots.filter(
      (s) => s.source === "intro" ||
             (s.source === "section_title" && !RE_CODE_TERM.test(s.text)) ||
             (s.source === "task_title")
    );
    // Fallback: if everything looks code-centric, keep it all (better than silence).
    return uxSlots.length ? uxSlots : changedSlots.slice(0, 2);
  }

  function buildChangedSlots(st, taskTitle) {
    const changed = [];

    if (st.intro)
      changed.push({ text: st.intro, certainty: "observed", source: "intro" });

    for (const section of st.sections || []) {
      if (section.title)
        changed.push({ text: section.title, certainty: "observed", source: "section_title" });
      for (const item of section.items || [])
        changed.push({ text: item, certainty: "inferred", source: "section_item" });
    }

    if (!changed.length && taskTitle)
      changed.push({ text: taskTitle, certainty: "observed", source: "task_title" });

    return changed;
  }

  // opts: { lang } — BCP-47 da config do usuário; passado a detectRiskSlots
  // para que as spoken notes de risco saiam no idioma correto.
  function buildIR(result, opts) {
    const lang = (opts && opts.lang) || "pt-BR";
    const st = result.structure || { intro: "", sections: [], expected: "" };
    const domains = detectDomains(st, result.body);
    const changed = buildChangedSlots(st, result.taskTitle);

    return {
      id: result.id || "",
      at: Date.now(),
      taskTitle: result.taskTitle || "",
      domains,
      slots: {
        changed,
        impact: buildImpactSlots(changed),
        risk: detectRiskSlots(st, result.body, lang),
        next: []
      },
      metrics: extractMetrics(st.expected || ""),

      _taskTitle: result.taskTitle || "",
      _intro: st.intro || "",
      _sections: st.sections || [],
      _expected: st.expected || "",
      _body: result.body || "",
      _hasStructure:
        (st.sections || []).some((s) => s.title || (s.items && s.items.length)) ||
        !!st.expected
    };
  }

  const api = { buildIR, extractMetrics, detectDomains };
  root.LovableIR = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
