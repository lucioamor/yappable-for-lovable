// ============================================================================
// risk-detector.js — Modo Risco (QA auditivo) [100% determinístico]
//
// Eixo ORTOGONAL à verbosidade (announce). A "lente" Risco lê o `structure`
// já extraído pelo content.js e procura, por dicionário de regex (PT + EN,
// porque o Lovable responde nos dois), padrões em que o output diz "feito"
// mas esconde algo que ainda precisa de validação humana.
//
// Entrada:  structure = { intro, sections:[{title, items[]}], expected, body }
// Saída:    { riskFlags: [{ type, severity, spokenNote }], hasRisk: boolean }
//
// `spokenNote` JÁ vem normalizado para fala em PT-BR (pronto pro TTS).
// `severity` (high|medium|low) é usado depois (Fase 2) para prosódia.
//
// Carregado como content script ANTES de content.js (mesmo isolated world,
// mesmo `self`), então expõe via `self.LovableRisk`. Também exporta como
// módulo Node para o harness de teste — sem dependência de DOM.
// ============================================================================
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Dicionário de risco. Cada entrada é uma regra determinística.
  //   match(hay):      a regra dispara? (recebe o texto agregado normalizado)
  //   severity:        high | medium | low
  //   spokenNote:      frase curta, normalizada para fala PT-BR, pronta pro TTS
  // A ordem aqui não importa: a narração ordena por severidade depois.
  // ---------------------------------------------------------------------------

  // métrica de performance citada (LCP, bundle, load time, etc.)
  const RE_METRIC =
    /\b(LCP|FCP|TTI|CLS|TTFB|INP|bundle|chunk|load\s*time|tempo\s+de\s+carregament|carregament|performance|desempenho|first\s+contentful|largest\s+contentful|lighthouse|web\s*vitals?)\b/i;
  // linguagem de estimativa (não medição): número é projetado, não aferido
  const RE_ESTIMATE =
    /(\bEsperad[oa]\b|\bespera-se\b|\bdeve\s+(cair|reduzir|baixar|melhorar|subir|aumentar)\b|\bdever[áa]\b|aproximadamente|cerca\s+de|por\s+volta\s+de|~\s*\d|\bestimat|\bestimad|\bshould\b|\bexpected\b|\bexpect\b|\baround\b|\broughly\b|\bapprox)/i;

  // mudança visual / responsividade
  const RE_VISUAL =
    /\b(layout|responsiv|breakpoint|grid|spacing|espaçament|viewport|mobile|desktop|tela|coluna|colunas|flexbox|posicionament|alinhament|overflow|modal|margin|padding|z-index|css)\b/i;
  // sinal de que validou visualmente (suprime o flag visual)
  const RE_VALIDATED =
    /\b(validad|validei|testad|testei|verificad|verifiquei|conferid|conferi|revisad|revisei|tested|verified|checked|validated|reviewed)\b/i;
  // negação explícita de mudança visual ("nenhuma mudança de layout", "estrutura
  // visual mantida", "no layout changes") — também suprime o flag visual: se nada
  // mudou, não há regressão a validar.
  const RE_VISUAL_SAFE =
    /(sem\s+(mudanças?|alterar|mudar|mexer\s+(n[oa])?|tocar\s+(n[oa])?)\s+(o\s+|a\s+|no\s+|na\s+)?(layout|responsiv|estrutura\s+visual|grid|css)|nenhuma?\s+(mudança|alteração|alterações)\s+(de\s+|no\s+|na\s+)?(layout|estrutura|grid|visual)|estrutura\s+visual\s+(atual\s+)?(mantid|preservad)|mantid[oa]\s+a\s+estrutura\s+visual|layout\s+(mantid|preservad|inalterad|unchanged|intact)|no\s+layout\s+changes?|without\s+(changing|altering)\s+(the\s+)?layout)/i;

  // tocou em texto/copy/conteúdo
  const RE_COPY =
    /\b(copy|textos?|conteúdos?|conteudos?|content|wording|microcopy|headline|título|titulo|t[íi]tulos|label|labels|placeholder|mensagens?|legenda|caption)\b/i;
  // disse explicitamente que NÃO mexeu na copy (suprime o flag)
  const RE_COPY_SAFE =
    /(sem\s+(alterar|mudar|mexer\s+(n[oa])?|tocar\s+(n[oa])?)\s+(a\s+|o\s+)?(copy|texto|conteúdo|conteudo)|copy\s+(mantid|preservad|intact|inalterad|unchanged|untouched)|texto\s+(mantid|preservad|inalterad)|without\s+(changing|altering|touching)\s+(the\s+)?(copy|text|content)|kept\s+(the\s+)?(copy|text)\s+(intact|unchanged))/i;

  // build / deploy / dependências / banco
  const RE_BUILD =
    /\b(env\s*vars?|vari[áa]veis?\s+de\s+ambiente|environment\s+variables?|\.env\b|build\b|deploy|depend[êe]ncias?|dependenc|migration|migraç|migrac|schema|esquema\s+do\s+banco|banco\s+de\s+dados|database|prisma|drizzle|supabase|\bsql\b|npm\s+install|yarn\s+add|package\.json|lockfile)\b/i;

  // SEO
  const RE_SEO =
    /\b(meta\s*tags?|meta\s+description|meta\s+title|headings?|cabeçalh|\bh1\b|sitemap|robots(\.txt)?|canonical|open\s*graph|og:|seo|indexaç|reindex|crawl|rich\s+snippet|structured\s+data|schema\.org)\b/i;

  const LANG_RE = {
    pt: {
      metric: /\b(LCP|FCP|TTI|CLS|TTFB|INP|bundle|chunk|tempo\s+de\s+carregament|carregament|performance|desempenho|lighthouse|web\s*vitals?)\b/i,
      estimate: /(\bEsperad[oa]\b|\bespera-se\b|\bdeve\s+(cair|reduzir|baixar|melhorar|subir|aumentar)\b|\bdever[áa]\b|aproximadamente|cerca\s+de|por\s+volta\s+de|~\s*\d|\bestimat|\bestimad)/i,
      visual: /\b(layout|responsiv|breakpoint|grid|spacing|espaçament|viewport|mobile|desktop|tela|coluna|colunas|flexbox|posicionament|alinhament|overflow|modal|margin|padding|z-index|css)\b/i,
      validated: /\b(validad|validei|testad|testei|verificad|verifiquei|conferid|conferi|revisad|revisei)\b/i,
      visualSafe: /(sem\s+(mudanças?|alterar|mudar|mexer\s+(n[oa])?|tocar\s+(n[oa])?)\s+(o\s+|a\s+|no\s+|na\s+)?(layout|responsiv|estrutura\s+visual|grid|css)|nenhuma?\s+(mudança|alteração|alterações)\s+(de\s+|no\s+|na\s+)?(layout|estrutura|grid|visual)|estrutura\s+visual\s+(atual\s+)?(mantid|preservad)|mantid[oa]\s+a\s+estrutura\s+visual|layout\s+(mantid|preservad|inalterad))/i,
      copy: /\b(copy|textos?|conteúdos?|conteudos?|wording|microcopy|headline|título|titulo|t[íi]tulos|label|labels|placeholder|mensagens?|legenda|caption)\b/i,
      copySafe: /(sem\s+(alterar|mudar|mexer\s+(n[oa])?|tocar\s+(n[oa])?)\s+(a\s+|o\s+)?(copy|texto|conteúdo|conteudo)|copy\s+(mantid|preservad|inalterad)|texto\s+(mantid|preservad|inalterad))/i,
      build: /\b(vari[áa]veis?\s+de\s+ambiente|\.env\b|build\b|deploy|depend[êe]ncias?|migration|migraç|migrac|schema|esquema\s+do\s+banco|banco\s+de\s+dados|database|prisma|drizzle|supabase|\bsql\b|npm\s+install|yarn\s+add|package\.json|lockfile)\b/i,
      seo: /\b(meta\s*tags?|meta\s+description|meta\s+title|headings?|cabeçalh|\bh1\b|sitemap|robots(\.txt)?|canonical|open\s*graph|og:|seo|indexaç|reindex|crawl|rich\s+snippet|structured\s+data|schema\.org)\b/i
    },
    en: {
      metric: /\b(LCP|FCP|TTI|CLS|TTFB|INP|bundle|chunk|load\s*time|performance|first\s+contentful|largest\s+contentful|lighthouse|web\s*vitals?)\b/i,
      estimate: /(\bshould\b|\bexpected\b|\bexpect\b|\baround\b|\broughly\b|\bapprox(?:imately)?\b|~\s*\d|\bestimat(?:e|ed|ion))\b/i,
      visual: /\b(layout|responsive|responsiveness|breakpoint|grid|spacing|viewport|mobile|desktop|screen|column|columns|flexbox|positioning|alignment|overflow|modal|margin|padding|z-index|css)\b/i,
      validated: /\b(tested|verified|checked|validated|reviewed)\b/i,
      visualSafe: /(layout\s+(unchanged|intact|preserved)|no\s+layout\s+changes?|without\s+(changing|altering)\s+(the\s+)?layout|kept\s+(the\s+)?(visual\s+)?structure\s+(intact|unchanged|preserved))/i,
      copy: /\b(copy|text|content|wording|microcopy|headline|title|titles|label|labels|placeholder|message|messages|caption)\b/i,
      copySafe: /(copy\s+(intact|unchanged|untouched|preserved)|text\s+(intact|unchanged|preserved)|without\s+(changing|altering|touching)\s+(the\s+)?(copy|text|content)|kept\s+(the\s+)?(copy|text)\s+(intact|unchanged))/i,
      build: /\b(env\s*vars?|environment\s+variables?|\.env\b|build\b|deploy|dependencies?|migration|schema|database|prisma|drizzle|supabase|\bsql\b|npm\s+install|yarn\s+add|package\.json|lockfile)\b/i,
      seo: /\b(meta\s*tags?|meta\s+description|meta\s+title|headings?|\bh1\b|sitemap|robots(\.txt)?|canonical|open\s*graph|og:|seo|index|reindex|crawl|rich\s+snippet|structured\s+data|schema\.org)\b/i
    }
  };

  const RULES = [
    {
      type: "metric_unvalidated",
      severity: "high",
      test: (hay, dict) => dict.metric.test(hay) && dict.estimate.test(hay),
      spokenNote:
        "Atenção: o ganho de performance citado é estimado, não medido. " +
        "Vale rodar um teste real, de preferência no mobile, antes de confiar no número.",
      spokenNote_en:
        "Heads up: the performance gain mentioned is estimated, not measured. " +
        "Run a real test, ideally on mobile, before trusting the number."
    },
    {
      type: "visual_regression",
      severity: "medium",
      test: () => false,
      spokenNote: "",
      spokenNote_en: ""
    },
    {
      type: "copy_touched",
      severity: "low",
      test: (hay, dict) => dict.copy.test(hay) && !dict.copySafe.test(hay),
      spokenNote:
        "Pode ter alterado texto visível. Revise a copy para garantir que a mensagem continua correta.",
      spokenNote_en:
        "Visible text may have changed. Review the copy to ensure the message is still correct."
    },
    {
      type: "build_risk",
      severity: "high",
      test: (hay, dict) => dict.build.test(hay),
      spokenNote:
        "Tocou em build, dependências ou banco de dados. " +
        "Rode o build e valide o ambiente antes de subir para produção.",
      spokenNote_en:
        "Touched build, dependencies, or database. " +
        "Run the build and validate the environment before deploying."
    },
    {
      type: "seo_risk",
      severity: "medium",
      test: (hay, dict) => dict.seo.test(hay),
      spokenNote:
        "Alterou elementos de SEO, como meta tags ou headings. " +
        "Verifique título, descrição e estrutura de headings para não perder ranqueamento.",
      spokenNote_en:
        "SEO elements like meta tags or headings were changed. " +
        "Check title, description, and heading structure to avoid ranking loss."
    }
  ];

  // O QA auditivo só faz sentido quando o output AFIRMA ter FEITO algo ("feito",
  // "corrigi", "implementei"…). Numa análise, proposta ou pergunta — em que nada
  // foi alterado ainda — os avisos "valide X" são falso positivo. Ex.: o texto
  // citar "salvar o conteúdo bruto" disparava "revise a copy" sem nada ter mudado.
  // Verbos de ação no passado (PT) + particípios + equivalentes em EN.
  const RE_CLAIMS_DONE =
    /\b(feito|fiz|fizemos|conclu[íi]|finaliz|pront[oa]|implementei|implementad|corrigi|corrigid|ajustei|ajustad|criei|criad|gerei|gerad|adicionei|adicionad|atualizei|atualizad|configurei|configurad|instalei|instalad|refatorei|refatorad|reescrevi|removi|removid|deletei|apaguei|movi|troquei|rodei|mexi|apliquei|aplicad|deploy(?:ei|ado|amos)?|done|fixed|implemented|completed|added|updated|created|configured|installed|refactored|removed|deleted|moved|applied|shipped|ran)\b/i;

  const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

  // junta tudo que o agente escreveu num único texto pra rodar os regex.
  function haystackOf(structure) {
    const s = structure || {};
    const parts = [s.intro, s.expected, s.body];
    for (const sec of s.sections || []) {
      if (sec.title) parts.push(sec.title);
      for (const it of sec.items || []) parts.push(it);
    }
    // colapsa espaço; mantém acentos (os regex contam com eles)
    return parts.filter(Boolean).join("  ").replace(/\s+/g, " ");
  }

  // detecta flags. SEM efeito colateral, puro.
  // lang: BCP-47 da configuração do usuário (ex.: "pt-BR", "en-US"). Determina
  // qual spokenNote usar. Padrão PT-BR quando ausente.
  function detectRisks(structure, lang) {
    const isEn = String(lang || "").toLowerCase().startsWith("en");
    const dict = isEn ? LANG_RE.en : LANG_RE.pt;
    const hay = haystackOf(structure);
    const riskFlags = [];
    // Sem alegação de conclusão, não há nada a validar -> zero flags.
    if (hay && RE_CLAIMS_DONE.test(hay)) {
      for (const rule of RULES) {
        if (rule.test(hay, dict)) {
          const note = (isEn && rule.spokenNote_en) ? rule.spokenNote_en : rule.spokenNote;
          riskFlags.push({ type: rule.type, severity: rule.severity, spokenNote: note });
        }
      }
    }
    riskFlags.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
    return { riskFlags, hasRisk: riskFlags.length > 0 };
  }

  // narrate() REMOVIDA na Fase 1: risk-detector agora só detecta flags.
  // O renderer.js lê ir.slots.risk (populado pelo ir-builder) e gera o texto.
  // numWord() movida para renderer.js.

  const api = { detectRisks, haystackOf };

  // expõe no isolated world (content.js consome via self.LovableRisk)
  root.LovableRisk = api;
  // e como módulo Node, para o harness de teste rodar sem DOM
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
