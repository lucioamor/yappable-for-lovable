# Yappable — Prompt de Estratégia: Diagnóstico + Credencial (redesenho)

> **Como usar:** este arquivo é um prompt de execução. Entregue-o a um agente (ou
> use como roteiro) para reconstruir o sistema de diagnóstico (YapLog) e de
> credencial/onboarding da extensão, **em ordem**, sem big-bang. Cada fase é
> independente, testável e mergeável sozinha. Não avance de fase sem o critério
> de aceite verde.

---

## Papel e missão

Você é um engenheiro de extensões Chrome MV3 trabalhando no Yappable for Lovable.
O pipeline de fala degrada **em silêncio** (ElevenLabs → nativo → verbatim;
tradução → original; waveform real → simulada) e o estado de credencial é
implícito. Sua missão é tornar **estado implícito em estado explícito** em dois
eixos — diagnóstico e credencial — para que o dado gerado diga sempre *qual elo
cedeu, por quê, e sobre qual dado*.

Ordem obrigatória: começa no YapLog (Fases 1–3), passa pela abstração de
provedor (Fase 4) e termina no onboarding/credencial (Fases 5–6).

## Princípios globais (valem em todas as fases)

1. **Zero regressão de comportamento.** Com debug OFF e chave válida, a narração
   funciona idêntica ao build atual. Toda fase preserva o caminho feliz.
2. **Segredo nunca vaza.** A chave ElevenLabs jamais entra em `detail`, log,
   export ou mensagem. Mantenha a redação por regex como rede de segurança, não
   como primeira linha.
3. **Custo zero quando desligado.** Tracing completo é opt-in; inerte quando off
   (exceto o breadcrumb de erro da Fase 3, que é mínimo e sempre-ligado).
4. **Migração incremental.** Cada fase lê dados antigos e escreve no formato
   novo; nunca quebra um perfil já instalado. Inclua leitura de chaves legadas.
5. **Gate de QA por fase.** `npm run qa` (node --check + node --test) verde antes
   de mergear. Adicione testes novos junto com cada fase.
6. **Versione o schema.** Todo objeto persistido novo carrega um campo `v`.

---

## FASE 1 — YapLog: background-as-sink + modelo de trace

**Objetivo:** eliminar a corrida de persistência (read-modify-write em `yapLogs`
por 3 contextos, doc §8.1), o dedupe frágil (`ctx|seq|iso`) e o drop por morte do
service worker — e tornar cada ciclo de narração reconstruível.

**Mudanças:**
- **Dono único do buffer = background.** `content.js` e `popup.js` deixam de
  escrever em `storage.local.yapLogs`. Em vez disso, emitem cada evento por
  `chrome.runtime.sendMessage({ __yapLog: true, entry })`. O service worker é o
  único que mantém o ring e persiste. Isso mata corrida, dedupe e SW-drop de uma
  vez (efeito de segunda ordem: centraliza onde métricas e breadcrumb nascem).
- **Trace por ciclo.** Cada passada do pipeline ganha um `runId` (uuid v4 curto).
  Todo evento daquele ciclo carrega `runId`; sub-passos carregam `parentId`.
  Adote um subconjunto da semântica OpenTelemetry (`trace_id`/`span_id`/
  `parentId`) **sem a dependência**.
- **Ring por run, não por evento.** Guarde os últimos N runs *completos* (sugestão
  N=40), nunca cortando no meio de um trace.
- **Schema versionado.** Toda entrada ganha `v: 2`.

**Contrato de dado (entrada de log v2):**
```jsonc
{
  "v": 2,
  "runId": "a1b2c3d4",        // null para eventos fora de ciclo (install, tabs)
  "parentId": null,
  "seq": 12,
  "t": 1750000000000,
  "iso": "2026-06-25T12:00:00.000Z",
  "ctx": "proj:ab12cd34",
  "stage": "playback",        // taxonomia atual mantida
  "hook": "_wfStartEleven",
  "action": "…",
  "outcome": "ok|info|fallback|fail",
  "detail": { /* redatado */ },
  "ms": 134
}
```

**Critérios de aceite:**
- Com debug ON, narrar em DUAS abas Lovable simultâneas e baixar não perde
  nenhuma entrada (a corrida §8.1 some).
- Todo evento de uma narração compartilha o mesmo `runId`; filtrar por ele
  reconstrói a passada inteira (DOM → interpret → translate → engine → playback).
- `npm run qa` verde; novo teste cobre "merge concorrente não perde entradas".

---

## FASE 2 — Export estruturado + métricas derivadas + unificação da IR

**Objetivo:** o dado gerado deixa de ser só um stream de texto e passa a ser
analisável por ferramenta e auto-descritivo.

**Mudanças:**
- **Dois formatos de export.** Mantém o `.txt` legível (colar em issue) e
  adiciona `.jsonl` (uma entrada por linha) — greppável, diffável, carregável em
  notebook.
- **Cabeçalho auto-descritivo** no export: `v` do schema, versão da extensão,
  UA/browser, snapshot redatado do estado de credencial (Fase 5), legenda dos
  campos. Um log vira auditável sozinho.
- **Camada de métricas derivadas**, computada no momento do download a partir do
  stream: taxa de fallback por estágio, p50/p95 de `speakEleven` e `localizeLine`,
  contagem do caso "waveform anima mas mudo" (`_wfStartEleven routed:false`),
  total de runs e de falhas por run.
- **Unifica a IR ao trace.** Hoje `LAST_OUTPUT_KEY` (IR + `readText`) vive
  separado dos logs. Anexe a IR ao `runId` do ciclo, para que um diagnóstico
  baixado contenha *o que o pipeline fez* (eventos) **e** *sobre que dado operou*
  (IR + texto lido) num pacote só.

**Contrato (bloco de métricas no export):**
```jsonc
{
  "runs": 12, "failedRuns": 1,
  "fallbackRateByStage": { "engine": 0.25, "translate": 0.08 },
  "latencyMs": { "speakEleven": { "p50": 420, "p95": 1300 },
                 "localizeLine": { "p50": 90, "p95": 600 } },
  "mutedButAnimating": 2
}
```

**Critérios de aceite:**
- Download oferece `.txt` e `.jsonl`; o JSONL parseia 100% com `JSON.parse` linha
  a linha.
- O bloco de métricas bate com a contagem manual num cenário controlado.
- Cada run no export tem sua IR anexada quando houve narração.

---

## FASE 3 — Breadcrumb de erro sempre-ligado

**Objetivo:** ter rastro mesmo quando o usuário nunca ligou o debug — o reporte de
bug deixa de chegar vazio.

**Mudanças:**
- Ring mínimo (sugestão 50 entradas) que captura **apenas `outcome: "fail"`**,
  sempre, independente do toggle. Volume desprezível, sem `detail` pesado.
- O toggle de debug passa a significar "tracing completo (todos os outcomes)",
  não "ligar/desligar captura".
- O export inclui os breadcrumbs mesmo se o tracing completo nunca foi ligado,
  marcados como origem `breadcrumb`.

**Critérios de aceite:**
- Com debug OFF, forçar uma falha (ex.: timeout de tradução) e baixar produz ≥1
  entrada `fail`.
- Com debug OFF e tudo normal, overhead permanece desprezível (só grava em falha).
- `npm run qa` verde.

---

## FASE 4 — Abstração de provedor de TTS

**Objetivo:** tirar a ElevenLabs hardcoded dos call sites; seleção de engine vira
dado, não `if cfg.engine === ...` repetido. Prepara o terreno da credencial.

**Mudanças:**
- Interface única `TtsProvider { id, verify(cred), synthesize(text, opts),
  quota(cred) }` com implementações `elevenlabs` e `native`. Futuro (OpenAI,
  Azure) entra sem tocar `content.js`.
- `drain`/`speakEleven`/`speakNative` passam a chamar o provedor ativo via a
  interface; o fallback nativo vira "próximo provedor na cadeia", não um branch.
- Cada chamada de provedor emite eventos no estágio `engine`/`playback` com
  `runId` (já existente da Fase 1).

**Critérios de aceite:**
- Trocar engine no popup não muda nenhum call site — só o provedor resolvido.
- Caminho ElevenLabs e caminho nativo idênticos em comportamento ao build atual.
- Adicionar um provedor fake nos testes não exige editar `content.js`.

---

## FASE 5 — Credencial normalizada + máquina de estados

**Objetivo:** substituir o booleano implícito `hasElevenKey` por estado explícito,
e surfacear *por que* o ElevenLabs não está tocando.

**Mudanças:**
- **Modelo de credencial único e versionado** (substitui chaves soltas; migra
  `storage.local.elevenKey` e legados):
```jsonc
auth: {
  v: 1,
  activeEngine: "elevenlabs",
  providers: {
    elevenlabs: {
      credential: { type: "apiKey", value: "<cru ou cifrado>", addedAt, lastVerifiedAt },
      status: "unverified|valid|invalid|quota_exceeded|network_error",
      account: { tier, charLimit, charsUsed, resetAt },  // de GET /v1/user
      voices: [...], voicesAt
    }
  }
}
```
- **Máquina de estados** `UNCONFIGURED → VERIFYING → VALID →
  {INVALID | QUOTA_EXCEEDED | NETWORK_ERROR}`. Cada transição é logada (estágio
  `config`) e exposta na UI.
- **Verificação como ciclo de vida:** re-verifica na primeira narração de cada
  sessão e após N falhas seguidas; puxa cota via `GET /v1/user` e mostra
  "restam X mil caracteres".
- **Credencial em repouso (opcional, decisão do dono):** ofuscar com WebCrypto +
  chave derivada por-instalação. Deixe explícito no código que isso só eleva a
  barra — proteção real exigiria backend guardando a chave. Não logar a chave
  continua sendo a defesa principal.

**Critérios de aceite:**
- Perfil com `elevenKey` antigo migra para `auth` sem perder a chave nem reabrir
  onboarding.
- Chave revogada → status `invalid` visível no popup, não fallback silencioso.
- Cota estourada → status `quota_exceeded` e aviso antes de a fala cortar.

---

## FASE 6 — Onboarding reconstruído sobre o novo modelo

**Objetivo:** o onboarding deixa de ser "capturar uma chave uma vez" e passa a ser
a porta de entrada da máquina de estados da Fase 5.

**Mudanças:**
- `onboarding.js` escreve no objeto `auth` (Fase 5), não em `elevenKey`/`engine`
  soltos. A validação inicial reusa `TtsProvider.verify()` (Fase 4), não um
  `fetch` próprio duplicado.
- Mostra a cota já no onboarding (`GET /v1/user`) — "chave válida, X mil
  caracteres disponíveis", em vez de só contar vozes.
- Estados de erro do onboarding (inválida/timeout/rede) usam os mesmos nomes da
  máquina de estados, para a UI ser consistente entre onboarding e popup.
- "Seguir no nativo" define `activeEngine: "native"` e deixa o provedor
  ElevenLabs em `unconfigured`, reconfigurável depois sem reonboarding.

**Critérios de aceite:**
- Onboarding e popup mostram o mesmo vocabulário de estado para o mesmo erro.
- Concluir o onboarding com chave válida deixa `auth.providers.elevenlabs.status
  = "valid"` e cota preenchida.
- Pular o onboarding e configurar a chave depois pelo popup chega ao mesmo estado
  final, sem caminho legado.

---

## Gate de verificação final (após a Fase 6)

1. `npm run qa` verde em todas as fases acumuladas.
2. Rodar as matrizes T1–T10 do `docs/DEBUG_LOGGING_AUDIT.md` adaptadas ao schema
   v2 (trace por `runId`, export `.jsonl`, breadcrumb sempre-ligado).
3. Auditoria de segredo: `grep` no `.txt` e no `.jsonl` baixados não revela a
   chave em nenhuma forma.
4. Teste de migração: carregar um perfil "antigo" (com `elevenKey` em local e em
   sync legado) e confirmar zero perda e zero reonboarding.
5. Confirmar caminho feliz idêntico ao build 0.2.0 com debug OFF.
