// ============================================================================
// speech-shaping.js — Showcase ElevenLabs (prosódia expressiva) [sem LLM]
//
// ÚLTIMO passo antes do POST /v1/text-to-speech. Recebe texto JÁ normalizado
// por cleanForNarration/normalizeSpeechTokens do content.js e injeta marcação
// expressiva por último — se entrasse antes, nossa normalização (que troca
// "—" -> " - ", "→" -> " para ") destruiria a marcação.
//
// Decisões ancoradas na doc oficial do ElevenLabs (confirmadas 2026-06):
//
//  • A sintaxe de pausa/ênfase é MUTUAMENTE EXCLUSIVA por família de modelo:
//      - "ssml"   (multilingual_v2, turbo_v2_5, flash_v2_5):
//                 pausa = <break time="x.xs"/>  (MÁX 3s; usar com parcimônia —
//                 excesso faz a fala acelerar / criar artefatos). Sem tag de
//                 ênfase real → ênfase via pontuação. NÃO usar CAPS (vira sigla).
//      - "v3tags" (eleven_v3): NÃO aceita <break>. Pausa = [pause]/[short pause]/
//                 [long pause]; ênfase via CAPS e audio tags.
//    => O shaper NÃO detecta o modelo em runtime. Cada perfil declara sua
//       família (derivada do modelo no build do perfil), e o shaper só executa
//       o branch certo. Trocar o modelo no popup troca a família junto.
//
//  • apply_text_normalization = "off" quando o shaping está ativo: o texto já
//    foi normalizado por nós (números por extenso). Deixar "on"/"auto" faria o
//    ElevenLabs re-tocar resíduos e poderia brigar com a marcação.
//
//  • Fallback Web Speech: faz STRIP de toda marcação ElevenLabs e aproxima a
//    intenção via rate/pitch nativos por lente.
//
// Carregado como content script ANTES de content.js (mesmo isolated world).
// Exporta self.LovableSpeech + module.exports (Node) para o harness de teste.
// ============================================================================
(function (root) {
  "use strict";

  // modelo -> família de sintaxe. Único ponto que conhece nomes de modelo.
  const MODEL_FAMILY = {
    eleven_v3: "v3tags"
    // qualquer outro (multilingual_v2, turbo_v2_5, flash_v2_5...) => "ssml"
  };
  const familyOf = (model) => MODEL_FAMILY[model] || "ssml";

  // ---------------------------------------------------------------------------
  // Perfis de voz por LENTE. Configuráveis (expostos na API). Cada perfil traz:
  //   voice:  override de voice_settings do ElevenLabs (stability/style/speed)
  //   native: MULTIPLICADORES sobre rate/pitch do usuário (fallback Web Speech)
  // similarity_boost e use_speaker_boost ficam com a config do usuário.
  // ---------------------------------------------------------------------------
  const LENS_PROFILES = {
    // rápido e seco: voz estável, sem exagero, levemente acelerada
    status: { voice: { stability: 0.6, style: 0.0, speed: 1.1 }, native: { rate: 1.08, pitch: 1.0 } },
    // entusiasmado: menos estável (mais range), mais estilo, ritmo vivo
    impact: { voice: { stability: 0.35, style: 0.45, speed: 1.05 }, native: { rate: 1.04, pitch: 1.06 } },
    // lento e ponderado: estável, sem exagero, desacelerado
    risk: { voice: { stability: 0.65, style: 0.0, speed: 0.9 }, native: { rate: 0.86, pitch: 0.98 } },
    // neutro/claro
    technical: { voice: { stability: 0.6, style: 0.1, speed: 1.0 }, native: { rate: 1.0, pitch: 1.0 } }
  };
  const profileOf = (lens) => LENS_PROFILES[lens] || LENS_PROFILES.status;

  // pausa antes da nota de risco, por severidade. Pausa MAIOR = mais peso.
  // ssml em segundos (≤3); v3 em audio tag. Só ANTES da spokenNote — nunca
  // antes do veredito (o veredito já cria a expectativa; pausa dupla soa solene
  // demais e o modelo acelera depois pra compensar — caveat da doc).
  const PAUSE_SSML = { high: '<break time="1.2s"/> ', medium: '<break time="0.7s"/> ', low: '<break time="0.5s"/> ' };
  const PAUSE_V3 = { high: "[long pause] ", medium: "[pause] ", low: "[short pause] " };

  // escapa regex pra localizar a spokenNote literal no texto final
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // injeta a pausa imediatamente ANTES de cada spokenNote (1ª ocorrência).
  function injectRiskPauses(text, riskFlags, pauseMap) {
    let out = text;
    for (const f of riskFlags || []) {
      if (!f || !f.spokenNote) continue;
      const note = f.spokenNote;
      const re = new RegExp(escapeRe(note));
      const pause = pauseMap[f.severity] || pauseMap.medium;
      out = out.replace(re, pause + note);
    }
    return out;
  }

  // remove qualquer marcação ElevenLabs (break tags + audio tags) p/ Web Speech
  function stripMarkup(text) {
    return String(text || "")
      .replace(/<break\b[^>]*\/?>/gi, " ") // <break time="x"/>
      .replace(/\[[^\]]*\]/g, " ") // [pause], [long pause], [whispers]...
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // --- branches por família ---------------------------------------------------

  function shapeSSML(clean, lens, riskFlags) {
    if (lens === "risk" && riskFlags && riskFlags.length) {
      return injectRiskPauses(clean, riskFlags, PAUSE_SSML);
    }
    // demais lentes: a expressividade vem do perfil (voice_settings), não de
    // tags — evita o artefato de "excesso de break" descrito na doc.
    return clean;
  }

  function shapeV3(clean, lens, riskFlags) {
    let out = clean;
    if (lens === "risk" && riskFlags && riskFlags.length) {
      out = injectRiskPauses(out, riskFlags, PAUSE_V3);
    }
    // v3 aceita CAPS como ênfase: realça a 1ª palavra do veredito ("Concluído").
    // Só no v3 — em ssml CAPS vira leitura de sigla.
    out = out.replace(/^(\s*)(Conclu[ií]do)\b/, (_m, sp, w) => sp + w.toUpperCase());
    return out;
  }

  // ---------------------------------------------------------------------------
  // API principal. clean = texto já normalizado p/ fala. ctx = { lens, model,
  // riskFlags }. Devolve payloads prontos para os dois motores.
  // ---------------------------------------------------------------------------
  function shape(clean, ctx) {
    const lens = (ctx && ctx.lens) || "status";
    const family = familyOf(ctx && ctx.model);
    const profile = profileOf(lens);
    const riskFlags = (ctx && ctx.riskFlags) || [];

    const shapedText = family === "v3tags"
      ? shapeV3(clean, lens, riskFlags)
      : shapeSSML(clean, lens, riskFlags);

    return {
      family,
      lens,
      eleven: {
        text: shapedText,
        voiceSettings: { ...profile.voice }, // override de stability/style/speed
        applyTextNormalization: "off" // texto já normalizado por nós
      },
      native: {
        // deriva do CLEAN, não do shapedText: evita herdar CAPS do v3 (Web Speech
        // leria "C-O-N-C-L-U-Í-D-O"). stripMarkup é defensivo (clean já é limpo).
        text: stripMarkup(clean),
        rate: profile.native.rate, // MULTIPLICADOR sobre cfg.rate
        pitch: profile.native.pitch // MULTIPLICADOR sobre cfg.pitch
      }
    };
  }

  const api = { shape, stripMarkup, familyOf, profileOf, LENS_PROFILES, MODEL_FAMILY };
  root.LovableSpeech = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
