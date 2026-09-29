# Plano de melhorias — sinalização cross-tab (inspirado no Lovable Buddy)

Status: proposta · Alvo: Yappable for Lovable `0.2.0+` · Escopo: 4 melhorias de maior valor

## Objetivo

Hoje o Yappable avisa **só por áudio**. Se o volume está baixo, o usuário está numa
call, sem fone, ou com a aba muda, não há fallback. Este plano adiciona uma camada de
sinalização **visual e cross-tab** — sem abrir mão da filosofia do projeto
(permissão mínima, 100% local, só `lovable.dev`).

Quatro entregas, em ordem de dependência:

1. **Sinais de rede no `inject.js`** — emite `taskstart` e `taskfail` além do `completion` que já existe. É a fundação das outras três.
2. **Badge no ícone da extensão** — ⏳ enquanto roda, ✓ ao concluir, ! em erro. Zero permissão nova.
3. **Notificação do sistema operacional** — card nativo ao concluir/falhar, mesmo em outra aba. Custa só a permissão `notifications`.
4. **Clique na notificação → foca a aba/janela de origem** — traz de volta o build que terminou.

### Princípios que NÃO mudam

- **Nada de `<all_urls>` nem `webRequest`.** O Lovable Buddy usa ambos; nós obtemos o
  mesmo sinal interceptando `fetch` no MAIN world (`inject.js`), que já está restrito a
  `lovable.dev`. A única permissão nova é `notifications`.
- **Continua só em `lovable.dev`.** Sem novos `host_permissions`.
- **A fila única de áudio e a narração permanecem intocadas.** Esta camada é puramente
  visual/SO e roda no background; não toca no pipeline de fala.

---

## Arquitetura do fluxo

```
api.lovable.dev/.../chat (POST)        generation-complete.mp3 (fetch)
        │                                          │
        ▼  inject.js (MAIN world)                  ▼  inject.js (MAIN world)
  postMessage "taskstart"  ──┐         postMessage "completion" ──┐
  postMessage "taskfail"   ──┤                                    │
                             ▼                                    ▼
                       content.js  ── reportTaskState(running|complete|error) ──►
                             │
   (DOM "Try to fix" → onErrorDetected também chama reportTaskState("error"))
                             │
                             ▼  chrome.runtime.sendMessage  (sender.tab dá tabId/windowId)
                       background.js
                             ├── badge por aba (chrome.action.setBadgeText{tabId})
                             ├── notificação (chrome.notifications, respeitando settings)
                             └── clique → chrome.windows.update + chrome.tabs.update
```

Por que essa divisão: o `inject.js` é o único contexto que vê a rede do Lovable; o
`content.js` é o único que sabe o nome do projeto e fala com o background; o
`background.js` é o único que pode setar badge, criar notificação e focar abas. Cada
sinal nasce onde é barato e sobe por mensagem.

---

## Fase 1 — Sinais de rede no `inject.js`

**Arquivo:** `src/inject.js` (MAIN world, `document_start`).
**Permissão nova:** nenhuma.

O `inject.js` já intercepta `window.fetch` para silenciar o som de conclusão. Vamos
estender o mesmo wrapper para (a) sinalizar o **início** da tarefa no POST de chat e
(b) sinalizar **falha** quando esse POST resolve com `status >= 400` ou rejeita.

```js
// Adicionar perto do topo do IIFE, junto de MARK:
const CHAT_RE = /\/\/api\.lovable\.dev\/projects\/[^/]+\/chat\b/;

function signal(type, extra) {
  try {
    window.postMessage(
      Object.assign({ __yappable: true, type }, extra || {}),
      window.location.origin
    );
  } catch (_) {}
}
// (a função notify() atual vira: signal("completion"))
```

Wrapper de `fetch` revisado (mantém o curto-circuito do som; acrescenta o ramo de chat):

```js
window.fetch = function (input, init) {
  let url = "";
  try {
    url = typeof input === "string" ? input : (input && input.url) || "";
  } catch (_) {}

  // 1) Som de conclusão: silencia e sinaliza "completion" (comportamento atual)
  if (url && url.includes(MARK)) {
    signal("completion");
    return Promise.resolve(
      new Response(silentBlob(), {
        status: 200, statusText: "OK",
        headers: { "Content-Type": "audio/wav" }
      })
    );
  }

  // 2) POST de chat: marca início e observa falha de rede (não altera a resposta)
  let method = "GET";
  try {
    method = ((init && init.method) ||
      (typeof input === "object" && input && input.method) || "GET").toUpperCase();
  } catch (_) {}
  if (url && CHAT_RE.test(url) && method === "POST") {
    signal("taskstart");
    return origFetch.apply(this, arguments).then(
      (resp) => {
        if (resp && !resp.ok) signal("taskfail", { status: resp.status });
        return resp;
      },
      (err) => { signal("taskfail", { status: 0 }); throw err; }
    );
  }

  return origFetch.apply(this, arguments);
};
```

**Caveat (documentar no PR):** se o Lovable algum dia trocar o POST de chat para
`XMLHttpRequest`, o `taskstart`/`taskfail` de rede não dispara. Não é regressão: a
detecção de **conclusão** continua via som (independente), e o erro de DOM
(`onErrorDetected`, "Try to fix") continua cobrindo a falha visível. Se quisermos
robustez extra, dá para adicionar um shim curto de `XMLHttpRequest.prototype.open/send`
no mesmo arquivo — fora do escopo desta primeira entrega.

**Teste:** `tests/core.test.js:121` já valida que o interceptor silencia o som e
preserva outros `fetch`. Estender esse teste com dois casos: um POST para
`/projects/x/chat` que resolve 200 (espera `taskstart`, sem `taskfail`) e um que
resolve 500 (espera `taskstart` **e** `taskfail{status:500}`).

---

## Fase 2 — Badge no ícone (sem permissão nova)

**Arquivos:** `src/content.js`, `src/background.js`.
**Permissão nova:** nenhuma (`chrome.action.setBadgeText` não exige permissão).

### 2.1 `content.js` — relay de estado para o background

Adicionar um helper e estender o listener de `message` que já trata `completion`
(hoje em ~`src/content.js:2208`):

```js
// Relay de estado de tarefa p/ o background (badge + notificação + foco de aba).
function reportTaskState(state, extra) {
  try {
    chrome.runtime.sendMessage(
      Object.assign(
        { __yappable: true, type: "taskState", state, project: getProjectName() },
        extra || {}
      ),
      () => void chrome.runtime.lastError
    );
  } catch (_) {}
}
```

Listener unificado (substitui o listener de `completion` atual):

```js
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.origin !== window.location.origin) return;
  const d = e.data;
  if (!d || d.__yappable !== true) return;
  if (d.type === "completion") { requestNarration(true); reportTaskState("complete"); }
  else if (d.type === "taskstart") { reportTaskState("running"); }
  else if (d.type === "taskfail") { reportTaskState("error", { status: d.status }); }
});
```

E em `onErrorDetected(toast)` (~`src/content.js:2103`), além do chime existente,
relatar o erro de DOM para o badge/notificação:

```js
reportTaskState("error");
```

> `getProjectName()` já existe (~`src/content.js:1388`) e tira o nome do título da
> aba — estável entre deploys. Reutilizamos sem custo.

### 2.2 `background.js` — máquina de estado → badge

O roteador de mensagens já existe. **Inserir o handler de `taskState` ANTES** da linha
`if (!msg.__yappable || msg.type !== "countLovableTabs") return;`, senão esse guard
descarta a mensagem.

Helper puro (testável, sem API do Chrome) — recomendado para QA:

```js
// Mapa estado → aparência do badge. Pure function: fácil de unit-testar.
function taskBadge(state) {
  switch (state) {
    case "running":  return { text: "⏳", color: "#cba6f7" }; // lilás
    case "complete": return { text: "✓",  color: "#a6e3a1" }; // verde
    case "error":    return { text: "!",  color: "#f38ba8" }; // vermelho
    default:         return { text: "",   color: null };       // idle
  }
}

function setBadge(tabId, state) {
  if (tabId == null) return;
  const { text, color } = taskBadge(state);
  try {
    chrome.action.setBadgeText({ tabId, text });
    if (text && color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {}
}

function getSettings(cb) {
  const dft = { enabled: true, osNotifyEnabled: true, badgeEnabled: true };
  chrome.storage.sync.get(dft, (s) => cb(chrome.runtime.lastError ? dft : s));
}

// Último tab que concluiu/errou — alvo do clique na notificação (Fase 4).
const lastTaskTab = { tabId: null, windowId: null };
```

Handler no roteador:

```js
if (msg.__yappable && msg.type === "taskState") {
  const tab = sender && sender.tab;
  const tabId = tab && tab.id;
  if (tabId == null) return false;
  getSettings((s) => {
    if (s.badgeEnabled) setBadge(tabId, msg.state);
    if (msg.state === "complete" || msg.state === "error") {
      lastTaskTab.tabId = tabId;
      lastTaskTab.windowId = tab.windowId;
      if (s.enabled && s.osNotifyEnabled) notifyTask(msg.state, msg.project, tab); // Fase 3
    }
  });
  return false;
}
```

> **Nota:** o callback atual usa `(msg, _sender, sendResponse)` — renomear `_sender`
> para `sender` para ter acesso ao `sender.tab.id` / `sender.tab.windowId`.

Limpar o badge "concluído" quando o usuário volta para a aba (mesma UX do Lovable
Buddy):

```js
chrome.tabs.onActivated.addListener(({ tabId }) => {
  try {
    chrome.action.getBadgeText({ tabId }, (t) => {
      if (chrome.runtime.lastError) return;
      if (t === "✓" || t === "!") setBadge(tabId, "idle");
    });
  } catch (_) {}
});
```

> Badge é **por aba** (`{tabId}`), então cada projeto aberto tem seu próprio estado —
> sem interferência entre abas.

---

## Fase 3 — Notificação do sistema operacional

**Arquivos:** `manifest.json`, `src/background.js`.
**Permissão nova:** `notifications`.

### 3.1 `manifest.json`

```json
"permissions": ["storage", "declarativeNetRequest", "notifications"],
```

> Atualização que adiciona permissão dispara um aviso de re-permissão na Chrome Web
> Store; alguns usuários precisam reativar. Por isso recomendamos **lançar a Fase 3+4
> num release separado** da Fase 2 (ver Rollout).

### 3.2 `background.js` — criar a notificação

```js
const NOTIF_PREFIX = "yap-task-";

function notifyTask(state, project, tab) {
  const isError = state === "error";
  const title = isError ? "🚨 Lovable parou num erro" : "✨ Lovable terminou";
  const body = isError
    ? (project ? `${project}: clique em Try to fix para continuar.` : "Clique em Try to fix para continuar.")
    : (project ? `${project}: o build está pronto.` : "O build está pronto para você.");
  // id por aba: recriar substitui a notificação anterior daquela aba (sem spam).
  const id = NOTIF_PREFIX + (tab && tab.id != null ? tab.id : Date.now());
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: body,
      priority: isError ? 2 : 1,
      requireInteraction: false
    });
  } catch (_) {}
}
```

Observações de design:
- **Respeita os toggles:** só notifica se `enabled && osNotifyEnabled` (checado na
  Fase 2). Desligar a extensão silencia tudo, como esperado.
- **Sem duplicação:** a conclusão vem de **um único** sinal (`completion` do som),
  então uma tarefa = uma notificação. O id por `tabId` garante que uma nova tarefa na
  mesma aba substitua o card anterior em vez de empilhar.
- **Erro com prioridade maior** e mensagem distinta, ecoando o chime de erro que já
  existe no áudio.

---

## Fase 4 — Clique → foca a aba/janela de origem

**Arquivo:** `src/background.js`.
**Permissão nova:** nenhuma (`chrome.windows.update` e `chrome.tabs.update{active}` não
exigem `tabs`; o `windowId` vem de `sender.tab`, já disponível para content scripts).

```js
chrome.notifications.onClicked.addListener((id) => {
  if (!id || id.indexOf(NOTIF_PREFIX) !== 0) return;
  const { tabId, windowId } = lastTaskTab;
  if (tabId == null) return;
  try {
    if (windowId != null) chrome.windows.update(windowId, { focused: true });
    chrome.tabs.update(tabId, { active: true });
    chrome.notifications.clear(id);
  } catch (_) {}
});
```

> Com vários projetos abertos, `lastTaskTab` guarda o **último** que disparou. Se
> quisermos no futuro clicar no card certo quando há várias conclusões simultâneas,
> basta extrair o `tabId` do próprio `id` (`id.slice(NOTIF_PREFIX.length)`) em vez de
> usar `lastTaskTab`. Para a v1, `lastTaskTab` é suficiente e mais simples.

---

## Fase 5 — Settings, popup e seed

**Arquivos:** `src/background.js` (seed), `popup/popup.js`, `popup/popup.html`.

Dois novos toggles em `chrome.storage.sync`, default ligado:

| Chave              | Default | Efeito                                            |
|--------------------|:------:|----------------------------------------------------|
| `osNotifyEnabled`  | `true` | Card do SO ao concluir/falhar (Fases 3–4)          |
| `badgeEnabled`     | `true` | Badge ⏳/✓/! no ícone (Fase 2)                      |

### 5.1 `background.js` — `INSTALL_SEED`

```js
const INSTALL_SEED = {
  enabled: true,
  verboseEnabled: false,
  mode: "beginner",
  cueEnabled: true,
  errorAlertEnabled: true,
  osNotifyEnabled: true,   // novo
  badgeEnabled: true       // novo
};
```

### 5.2 `popup/popup.html` — duas linhas de toggle (espelham a linha do waveform)

```html
<div class="soundline-solo" title="Mostra um card do sistema quando o Lovable conclui (mesmo em outra aba).">
  <label for="osNotifyEnabled">🔔 Notificação do sistema</label>
  <div class="switch"><input type="checkbox" id="osNotifyEnabled" /></div>
</div>
<div class="soundline-solo" title="Mostra ⏳/✓ no ícone da extensão enquanto a tarefa roda.">
  <label for="badgeEnabled">🏷️ Badge no ícone</label>
  <div class="switch"><input type="checkbox" id="badgeEnabled" /></div>
</div>
```

### 5.3 `popup/popup.js`

```js
// 1) em DEFAULTS:
osNotifyEnabled: true,
badgeEnabled: true,

// 2) em apply() (junto de waveformEnabled, ~linha 774):
$("osNotifyEnabled").checked = cfg.osNotifyEnabled;
$("badgeEnabled").checked = cfg.badgeEnabled;

// 3) junto dos outros bindToggle (~linha 934):
bindToggle("osNotifyEnabled");
bindToggle("badgeEnabled");
```

> O `content.js` **não** precisa dessas chaves no `DEFAULTS` dele — quem lê é o
> background. Mas convém adicioná-las lá também por consistência (evita ruído no log de
> migração de config).

---

## Ordem de implementação e rollout

| Release | Fases | Permissão | Observação |
|--------|-------|-----------|------------|
| **A** | 1 + 2 + (toggle do badge) | nenhuma nova | Pode ir direto; sem prompt de permissão. Badge e sinais de rede primeiro. |
| **B** | 3 + 4 + (toggle de notificação) | **+`notifications`** | Prompt de re-permissão deliberado; changelog deve explicar o porquê. |

Dentro de cada release, a ordem técnica é a numérica (1→5), porque cada fase depende
dos sinais/relay da anterior.

---

## QA e verificação

**Automatizado (`npm test` → `tests/core.test.js`, `npm run qa` → `scripts/qa.js`):**

- **Manifest consistency** (`core.test.js:17`) — já roda; confirmar que `notifications`
  é aceito e que nenhum arquivo referenciado sumiu.
- **`inject.js`** (`core.test.js:121`) — estender com os dois casos novos: POST de chat
  200 (emite só `taskstart`) e 500 (emite `taskstart` + `taskfail{status:500}`),
  garantindo que `fetch` não-chat segue intacto.
- **`taskBadge(state)`** — novo teste unitário puro: `running→⏳/#cba6f7`,
  `complete→✓/#a6e3a1`, `error→!/#f38ba8`, default→`""`. Sem mock do Chrome.
- **`background` seed** (`core.test.js:162`) — estender a asserção de defaults para
  incluir `osNotifyEnabled` e `badgeEnabled`.
- **CHANGELOG** (`core.test.js:34`) — o teste exige uma entrada com a nova versão;
  bumpar `manifest.json` e adicionar a seção no `CHANGELOG.md` (senão o teste falha).

**Manual (smoke test):**

1. Abrir um projeto, mandar um prompt e **trocar de aba** → badge ⏳ aparece; ao
   concluir, badge ✓ **e** card do SO; clicar no card → volta para a aba/janela certa.
2. Forçar um erro ("Try to fix") → badge ! + card de erro com prioridade maior.
3. Dois projetos em abas diferentes → cada um com seu badge; o card nomeia o projeto.
4. Desligar `osNotifyEnabled` → sem cards; desligar `enabled` → sem badge, sem card,
   sem fala.
5. Voltar para a aba com badge ✓ → badge limpa sozinho.

**Verificação de privacidade/escopo:**
- Diff do `manifest.json`: a única permissão adicionada é `notifications`; nenhum novo
  `host_permissions`; nada de `<all_urls>` nem `webRequest`.
- `scripts/qa.js` deve continuar passando o audit de logging/lint.

---

## Riscos e mitigação

| Risco | Mitigação |
|------|-----------|
| Prompt de re-permissão por `notifications` afasta usuários | Isolar em release B; changelog explica; toggle on/off no popup. |
| Chat via XHR (futuro) não dispara `taskstart`/`taskfail` | Conclusão (som) e erro de DOM são independentes; shim de XHR fica como follow-up. |
| Service worker dormindo perde o sinal | O `sendMessage` acorda o worker; o estado é por evento, não exige worker persistente. |
| Excesso de notificações | Um sinal de conclusão por tarefa; id por `tabId` substitui em vez de empilhar. |
| Badge "preso" após fechar aba | Badge é por `tabId`; ao fechar a aba o Chrome descarta o badge dela automaticamente. |

---

## Resumo de arquivos tocados

| Arquivo | Fase | Mudança |
|--------|------|---------|
| `src/inject.js` | 1 | `signal()`, ramo de chat no wrapper de `fetch` (`taskstart`/`taskfail`) |
| `src/content.js` | 2 | `reportTaskState()`, listener unificado, hook em `onErrorDetected` |
| `src/background.js` | 2–4 | `taskBadge()`, `setBadge()`, `getSettings()`, handler `taskState`, `notifyTask()`, `onClicked`, `onActivated`, `INSTALL_SEED` |
| `manifest.json` | 3 | `+ "notifications"` |
| `popup/popup.html` | 5 | 2 linhas de toggle |
| `popup/popup.js` | 5 | DEFAULTS + apply + bindToggle |
| `tests/core.test.js` | QA | casos de `inject.js`, `taskBadge`, seed |
| `CHANGELOG.md` | QA | entrada da nova versão |
