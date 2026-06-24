# PRD Técnico — Atualização da Extensão Chrome de Leitura com ElevenLabs

## 1. Contexto

A aplicação atual é uma extensão do Google Chrome que usa a API da ElevenLabs para converter texto em fala e permitir que o usuário ouça conteúdos do navegador.

Hoje, o fluxo principal parece ser baseado em geração completa de MP3 antes da reprodução. Isso funciona como fallback, mas piora a percepção de velocidade porque o usuário precisa esperar o áudio inteiro ou uma parte substancial dele ser gerada/baixada antes de começar a ouvir.

A nova versão deve migrar o fluxo principal para streaming de áudio, mantendo a capacidade de salvar/reutilizar MP3 como cache, histórico e fallback.

## 2. Objetivo

Reduzir o tempo até o primeiro áudio, diminuir custo operacional por meio de cache e manter rastreabilidade do que foi lido.

A extensão deve permitir que o usuário:

1. selecione ou capture texto de uma página;
2. envie o texto para a ElevenLabs;
3. comece a ouvir rapidamente via streaming;
4. salve o áudio gerado como MP3 quando aplicável;
5. consulte um log de leituras anteriores;
6. reescute áudios já gerados sem nova chamada à ElevenLabs;
7. use fallback para geração tradicional de MP3 quando streaming falhar.

## 3. Decisão técnica principal

O modo padrão passa a ser:

```txt
ElevenLabs HTTP Streaming
→ reprodução progressiva
→ acumulação paralela dos chunks
→ criação de Blob MP3 ao final
→ persistência local ou remota
→ registro no log
```

O modo legado continua disponível como fallback:

```txt
ElevenLabs Create Speech / geração completa
→ recebe arquivo de áudio final
→ toca ou baixa MP3
→ registra no log
```

## 4. Modelo ElevenLabs recomendado

### 4.1 Modelo padrão

```txt
model_id: eleven_flash_v2_5
```

Uso: leitura rápida de textos no navegador, com prioridade em baixo custo e baixa latência.

Razões:

* menor custo por caractere entre os modelos adequados;
* melhor latência;
* limite alto de caracteres por requisição;
* bom equilíbrio entre qualidade e velocidade.

### 4.2 Fallback de qualidade

```txt
model_id: eleven_multilingual_v2
```

Uso: quando Flash 2.5 tiver problemas com naturalidade, pronúncia, números, datas, moedas, siglas ou textos longos com maior exigência de estabilidade.

### 4.3 Modelo excepcional

```txt
model_id: eleven_v3
```

Uso: somente para narração expressiva, emocional, diálogo, performance, conteúdo criativo ou casos onde a qualidade interpretativa é mais importante que custo/latência.

Não deve ser o default da extensão.

## 5. Output format recomendado

Default:

```txt
output_format: mp3_44100_128
```

Alternativa econômica:

```txt
output_format: mp3_22050_32
```

Regra prática:

* `mp3_44100_128`: melhor qualidade geral, bom para reescuta e log.
* `mp3_22050_32`: menor arquivo, útil se o foco for custo de storage e velocidade de transferência.
* evitar WAV/PCM para esta aplicação, salvo necessidade técnica específica, porque aumenta peso e pode exigir plano superior.

## 6. Fluxo principal: streaming com persistência

### 6.1 Sequência funcional

1. Usuário seleciona texto ou aciona leitura.
2. Content script captura o texto mínimo necessário.
3. Texto é enviado ao service worker/background.
4. Service worker normaliza o texto.
5. Sistema calcula `request_hash`.
6. Sistema verifica se já existe áudio salvo para o mesmo hash.
7. Se existir, reproduz o MP3 salvo.
8. Se não existir, chama ElevenLabs Streaming API.
9. O áudio começa a tocar assim que chunks suficientes chegarem.
10. Os chunks são acumulados em paralelo.
11. Ao final do stream, os chunks viram um Blob MP3.
12. Blob é salvo localmente ou remotamente.
13. Log é atualizado com metadados da leitura.
14. UI exibe item no histórico.

### 6.2 Hash de cache

O hash deve considerar todos os parâmetros que afetam o áudio:

```txt
hash_input = {
  normalized_text,
  voice_id,
  model_id,
  output_format,
  voice_settings,
  seed,
  language_code
}
```

Não usar apenas o texto bruto. O mesmo texto com voz, modelo ou configurações diferentes gera áudio diferente.

### 6.3 Cache hit

Se `request_hash` já existir:

```txt
não chamar ElevenLabs
→ tocar MP3 salvo
→ registrar novo evento de playback
→ opcionalmente incrementar contador de reuso
```

### 6.4 Cache miss

Se `request_hash` não existir:

```txt
chamar Streaming API
→ tocar stream
→ salvar áudio final
→ registrar item novo
```

## 7. Reprodução de áudio em extensão Chrome

Como Manifest V3 usa service worker e service workers não têm DOM, a reprodução deve acontecer em um dos seguintes contextos:

### Opção A — Offscreen Document

Recomendado para reprodução persistente/controlada.

Componentes:

```txt
service_worker.js
offscreen.html
offscreen-audio-player.js
```

O service worker coordena a requisição e envia mensagens para o offscreen document controlar áudio.

O offscreen document lida com:

* HTMLAudioElement;
* MediaSource, se necessário;
* URL.createObjectURL;
* play/pause/stop;
* eventos de progresso;
* limpeza de object URLs.

### Opção B — Popup/side panel

Recomendado se o áudio só precisa tocar enquanto a UI da extensão está aberta.

Menos robusto. Se o popup fecha, o controle pode ser perdido.

### Decisão recomendada

Usar Offscreen Document para áudio.

## 8. Estratégia de armazenamento

### 8.1 Settings

Usar `chrome.storage.sync` ou `chrome.storage.local` para:

```txt
selected_voice_id
default_model_id
default_output_format
voice_settings
preferred_language
enable_cache
enable_history
max_cache_size_mb
api_key_mode
```

### 8.2 Log leve

Usar `chrome.storage.local` ou IndexedDB para metadados:

```txt
id
request_hash
created_at
played_at
source_url
source_title
project_id
project_label
text_preview
text_length
normalized_text_length
voice_id
model_id
output_format
duration_seconds
estimated_character_cost
status
audio_storage_ref
```

### 8.3 Áudio

Não salvar MP3 grande como JSON em `chrome.storage`.

Usar uma destas opções:

#### Opção A — IndexedDB local

Boa para MVP local.

Vantagens:

* sem backend;
* funciona offline para reescuta;
* boa para Blob;
* preserva privacidade.

Limitações:

* cache fica preso ao navegador/dispositivo;
* pode crescer demais;
* precisa política de limpeza.

#### Opção B — Backend/Supabase Storage

Boa para produto comercial.

Vantagens:

* cache compartilhável;
* controle de cota;
* melhor auditoria;
* protege API key;
* permite histórico cross-device.

Limitações:

* maior complexidade;
* envolve transmissão e retenção de dados;
* exige política de privacidade mais explícita.

#### Decisão recomendada para MVP

IndexedDB local para áudio + `chrome.storage.local` para settings/log leve.

#### Decisão recomendada para produto público

Backend próprio ou Supabase Edge Function para proteger API key, controlar abuso e habilitar cache remoto.

## 9. Log de leituras

Criar uma aba “Log” ou “Histórico” com registros das leituras.

### 9.1 Campos visíveis

Cada item deve mostrar:

```txt
Título da página
URL/domínio
Data e hora
Projeto
Modelo usado
Voz usada
Número de caracteres
Status: streamed / cached / fallback / failed
Botões: Ouvir, Baixar MP3, Copiar texto, Excluir
```

### 9.2 Campo “Projeto”

O projeto pode ser definido por uma das estratégias:

1. manual pelo usuário;
2. inferido por domínio;
3. inferido pela aba ativa;
4. herdado de um workspace configurado.

Para MVP, usar seleção manual + último projeto usado.

### 9.3 Texto salvo

Configuração recomendada:

```txt
Salvar texto completo: opcional, desativado por padrão.
Salvar preview: ativado por padrão.
Salvar hash: ativado por padrão.
Salvar MP3: ativado se cache estiver ligado.
```

Motivo: reduzir risco de privacidade, especialmente se o usuário lê textos sensíveis.

## 10. Normalização de texto

Antes de enviar para ElevenLabs, aplicar normalização local.

### 10.1 Casos prioritários

```txt
datas
horários
valores em R$
telefones
URLs
siglas
abreviações
números grandes
listas com bullets
emojis
markdown
```

### 10.2 Exemplo

Entrada:

```txt
Reunião em 23/06/2026 às 14:30. Budget: R$ 1.250,90.
```

Saída normalizada:

```txt
Reunião em vinte e três de junho de dois mil e vinte e seis, às quatorze horas e trinta minutos. Budget: mil duzentos e cinquenta reais e noventa centavos.
```

### 10.3 Configuração

Adicionar toggle:

```txt
Normalizar texto antes da leitura: on/off
```

Default:

```txt
on
```

## 11. Fallbacks

### 11.1 Fallback de streaming para MP3 completo

Se streaming falhar:

```txt
usar endpoint de geração completa
→ gerar MP3
→ tocar quando pronto
→ salvar no log como fallback
```

### 11.2 Fallback de modelo

Se Flash 2.5 falhar em qualidade ou pronúncia:

```txt
repetir geração com eleven_multilingual_v2
```

Este fallback deve ser manual no MVP para evitar custo duplicado automático.

### 11.3 Fallback sem cache

Se armazenamento falhar:

```txt
continuar reprodução
→ registrar log sem áudio salvo
→ mostrar aviso discreto
```

## 12. API key e segurança

### 12.1 Não embutir chave global na extensão

A extensão não deve conter uma API key fixa da ElevenLabs no código distribuído.

Motivo: extensões podem ser inspecionadas e a chave seria extraída.

### 12.2 Modos possíveis

#### BYOK — Bring Your Own Key

Usuário informa a própria API key.

Vantagens:

* simples;
* sem backend;
* ideal para uso pessoal ou beta fechado.

Limitações:

* pior UX;
* usuário precisa ter conta ElevenLabs;
* chave fica localmente armazenada.

#### Backend Proxy

Extensão chama backend próprio; backend chama ElevenLabs.

Vantagens:

* protege chave;
* permite rate limit;
* permite billing próprio;
* permite cache central;
* melhor para produto público.

Limitações:

* exige infraestrutura;
* cria responsabilidade de segurança e privacidade.

### Decisão recomendada

MVP: BYOK local.

Produto público: backend proxy.

## 13. Permissões Chrome

Permissões mínimas desejadas:

```json
{
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "offscreen"
  ],
  "host_permissions": [
    "https://api.elevenlabs.io/*"
  ]
}
```

Se usar backend próprio:

```json
{
  "host_permissions": [
    "https://api.seudominio.com/*"
  ]
}
```

Evitar `<all_urls>` no MVP, salvo necessidade explícita.

## 14. UI proposta

### 14.1 Popup principal

Elementos:

```txt
Botão: Ler seleção
Botão: Ler página
Botão: Parar
Dropdown: Voz
Dropdown: Modelo
Toggle: Streaming
Toggle: Salvar no histórico
Toggle: Cache de MP3
Status: Gerando / Tocando / Salvo / Erro
```

### 14.2 Aba Log

Filtros:

```txt
Projeto
Domínio
Data
Modelo
Status
Com áudio salvo / sem áudio salvo
```

Ações por item:

```txt
Ouvir
Baixar MP3
Copiar texto
Abrir página original
Excluir áudio
Excluir registro
```

### 14.3 Página de Settings

Campos:

```txt
ElevenLabs API Key
Voz padrão
Modelo padrão
Formato de áudio
Normalização de texto
Salvar texto completo
Salvar apenas preview
Tamanho máximo do cache
Limpar cache
Exportar histórico
```

## 15. Critérios de aceite

### 15.1 Streaming

* Ao acionar leitura, o áudio deve começar antes de o arquivo completo estar disponível.
* O usuário deve conseguir parar a reprodução.
* Erros no stream não devem travar a extensão.
* O sistema deve registrar status `failed`, `partial` ou `completed`.

### 15.2 Persistência MP3

* Ao final de uma geração via streaming, o áudio deve ser salvo como MP3 quando cache estiver ativo.
* O botão “Baixar MP3” deve funcionar para itens salvos.
* Reescutar áudio salvo não deve consumir caracteres da ElevenLabs.
* Cache hit deve ser detectado por hash.

### 15.3 Log

* Cada leitura deve gerar registro com data, texto preview, modelo, voz, fonte e status.
* O usuário deve conseguir excluir registros.
* O usuário deve conseguir excluir o áudio sem excluir o metadado.

### 15.4 Fallback

* Se streaming falhar, o usuário deve ter opção de tentar geração completa.
* Se Flash 2.5 não performar bem, o usuário deve conseguir regenerar com Multilingual v2.
* O fallback deve ser explícito para evitar custo duplicado involuntário.

### 15.5 Privacidade

* O texto completo não deve ser salvo por padrão.
* O usuário deve conseguir limpar histórico e cache.
* A UI deve informar que o texto enviado para leitura é transmitido à ElevenLabs ou ao backend configurado.

## 16. Eventos e estados

### Estados da leitura

```txt
idle
preparing_text
checking_cache
cache_hit
streaming
playing
saving_audio
completed
failed
cancelled
fallback_available
```

### Eventos

```txt
READ_REQUESTED
TEXT_NORMALIZED
CACHE_CHECKED
CACHE_HIT
CACHE_MISS
STREAM_STARTED
FIRST_AUDIO_PLAYED
STREAM_COMPLETED
AUDIO_SAVED
PLAYBACK_STOPPED
FALLBACK_TRIGGERED
LOG_CREATED
```

## 17. Métricas internas

Registrar localmente:

```txt
time_to_first_audio_ms
total_generation_time_ms
characters_sent
model_id
cache_hit_rate
fallback_rate
stream_error_rate
average_audio_size_kb
estimated_cost_usd
```

Objetivo:

* medir economia real do cache;
* comparar Flash vs Multilingual;
* detectar textos problemáticos;
* decidir se v3 vale entrar em algum modo premium.

## 18. Riscos técnicos

### 18.1 Áudio parcial

Se o streaming falhar no meio, pode existir áudio incompleto. O item deve ser salvo como `partial` ou descartado, conforme configuração.

Default recomendado:

```txt
não salvar áudio parcial como cache reutilizável
salvar apenas log de falha
```

### 18.2 Cache incorreto

Se o hash não incluir todos os parâmetros relevantes, o usuário pode ouvir áudio com voz/modelo errado.

Mitigação:

```txt
hash deve incluir texto normalizado + voz + modelo + output_format + settings
```

### 18.3 Crescimento de storage

MP3s acumulados podem ocupar muito espaço.

Mitigação:

```txt
limite configurável de cache
limpeza LRU
botão limpar cache
mostrar espaço usado
```

### 18.4 Privacidade

Salvar texto completo pode ser sensível.

Mitigação:

```txt
texto completo off por padrão
preview curto por padrão
hash sempre salvo
MP3 opcional
```

## 19. Roadmap sugerido

### Fase 1 — MVP técnico

* Streaming com `eleven_flash_v2_5`.
* Reprodução via offscreen document.
* Stop/cancel.
* Log simples.
* Cache local em IndexedDB.
* Download MP3 após stream concluído.
* Fallback manual para geração completa.

### Fase 2 — Qualidade e custo

* Normalizador de texto em português.
* Cache por hash.
* Métrica de custo estimado.
* Regenerar com Multilingual v2.
* Filtros no histórico.
* Limpeza automática de cache.

### Fase 3 — Produto público

* Backend proxy.
* Rate limit.
* Cache remoto.
* Autenticação.
* Sincronização entre dispositivos.
* Política de privacidade formal.
* Tela de disclosure para Chrome Web Store.

### Fase 4 — Recursos avançados

* Projetos/workspaces.
* Tags.
* Exportação de histórico.
* Busca semântica no que foi lido.
* Resumo automático do texto lido.
* Integração com Readwise/Notion/Google Drive.
* Vozes por tipo de conteúdo.
* Modo “ler fila”.

## 20. Decisão final recomendada

Implementar streaming como padrão, não como experimento.

Manter geração completa de MP3 apenas como fallback.

Salvar MP3 reconstruído a partir dos chunks do streaming ao final da geração.

Criar log local com metadados e opção de cache.

Usar `eleven_flash_v2_5` como default.

Usar `eleven_multilingual_v2` como fallback de qualidade.

Evitar `eleven_v3` no fluxo principal da extensão.

--

# Referências Técnicas — ElevenLabs + Chrome Extension

## 1. ElevenLabs — Streaming e Text-to-Speech

### Streaming API — visão geral

https://elevenlabs.io/docs/api-reference/streaming

Uso no PRD: justificar que o streaming retorna bytes de áudio progressivos, como MP3, via HTTP chunked transfer, permitindo reprodução incremental e persistência posterior.

### Text to Speech — Streaming endpoint

https://elevenlabs.io/docs/api-reference/text-to-speech/stream

Uso no PRD: endpoint principal recomendado para a extensão. Referência para `POST /v1/text-to-speech/:voice_id/stream`, `model_id`, `output_format`, `voice_settings` e retorno em áudio streamado.

### Text to Speech — Create speech / geração completa

https://elevenlabs.io/docs/api-reference/text-to-speech/convert

Uso no PRD: fallback legado para gerar o MP3 completo antes da reprodução.

### Streaming and caching with Supabase

https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/streaming-and-caching-with-supabase

Uso no PRD: referência direta para arquitetura de streaming com cache, incluindo a ideia de transmitir áudio ao usuário e salvar o arquivo gerado para reuso.

### Understanding audio streaming

https://elevenlabs.io/docs/eleven-api/concepts/audio-streaming

Uso no PRD: explicar a diferença conceitual entre “baixar um arquivo já pronto” e “gerar áudio em tempo real enquanto o modelo sintetiza”.

### WebSocket Text-to-Speech

https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input

Uso no PRD: justificar por que WebSocket não é a primeira escolha quando o texto inteiro já está disponível. Melhor para texto incremental, LLMs em tempo real ou alinhamento palavra-áudio.

### Stream speech with timing

https://elevenlabs.io/docs/api-reference/text-to-speech/stream-with-timestamps

Uso no PRD: possível recurso futuro para highlight sincronizado, karaoke reading, acompanhamento palavra por palavra ou marcação de trechos lidos.

## 2. ElevenLabs — Modelos, qualidade, latência e custo

### Models overview

https://elevenlabs.io/docs/overview/models

Uso no PRD: referência principal para escolha entre `eleven_flash_v2_5`, `eleven_multilingual_v2`, `eleven_turbo_v2_5` e `eleven_v3`.

### Choosing the right model

https://elevenlabs.io/docs/eleven-api/choosing-the-right-model

Uso no PRD: justificar `eleven_flash_v2_5` como default de baixa latência e bom equilíbrio geral.

### Text to Speech best practices

https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices

Uso no PRD: apoiar decisões sobre estabilidade, naturalidade, escolha de modelo, escolha de voz e qualidade final.

### API pricing

https://elevenlabs.io/pricing/api

Uso no PRD: justificar decisões de custo por modelo e estimativa de economia com cache.

## 3. Chrome Extension — Arquitetura Manifest V3

### Offscreen API

https://developer.chrome.com/docs/extensions/reference/api/offscreen

Uso no PRD: justificar uso de offscreen document para reprodução de áudio em Manifest V3, já que o service worker não tem DOM.

### Offscreen Documents in Manifest V3

https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3

Uso no PRD: base conceitual para separar service worker e documento oculto responsável por APIs de DOM/window.

### Extension service worker lifecycle

https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

Uso no PRD: entender limitações do background/service worker, idle timer, persistência e impacto de conexões longas.

### Chrome Storage API

https://developer.chrome.com/docs/extensions/reference/api/storage

Uso no PRD: armazenar settings, preferências e metadados leves do log.

### Cross-origin network requests

https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

Uso no PRD: justificar `host_permissions` para chamar ElevenLabs ou backend próprio.

### Declare permissions

https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions

Uso no PRD: orientar permissões mínimas, uso de `activeTab`, `storage`, `offscreen`, `scripting` e evitar permissões amplas sem necessidade.

## 4. Chrome Web Store — Segurança, privacidade e review

### Chrome Web Store Developer Program Policies

https://developer.chrome.com/docs/webstore/program-policies/policies

Uso no PRD: referência principal para privacidade, permissões, disclosure, uso limitado e coleta de dados.

### Limited Use policy

https://developer.chrome.com/docs/webstore/program-policies/limited-use

Uso no PRD: justificar que o texto capturado deve ser usado apenas para a funcionalidade principal de geração de áudio.

### Privacy Policies

https://developer.chrome.com/docs/webstore/program-policies/privacy

Uso no PRD: orientar política de privacidade da extensão, especialmente porque texto da página pode ser enviado a terceiro.

### User Data FAQ

https://developer.chrome.com/docs/webstore/program-policies/user-data-faq

Uso no PRD: reforçar disclosure de uso limitado, transferência de dados e tratamento de dados sensíveis.

### Data Handling Requirements

https://developer.chrome.com/docs/webstore/program-policies/data-handling

Uso no PRD: justificar transmissão segura, proteção de credenciais e não exposição de API keys.

### Additional Requirements for Manifest V3

https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements

Uso no PRD: garantir que comunicação com servidores externos esteja dentro das regras de Manifest V3 e Chrome Web Store.

## 5. Referências auxiliares para implementação web

### ReadableStream.tee()

https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/tee

Uso no PRD: dividir o stream em dois ramos: um para playback e outro para cache/persistência.

### Blob

https://developer.mozilla.org/en-US/docs/Web/API/Blob

Uso no PRD: reconstruir o MP3 final a partir dos chunks recebidos no streaming.

### URL.createObjectURL()

https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static

Uso no PRD: criar URL local temporária para tocar ou baixar o MP3 salvo como Blob.

### IndexedDB API

https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

Uso no PRD: armazenar blobs de áudio localmente sem serializar MP3 dentro de `chrome.storage`.

### MediaSource API

https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API

Uso no PRD: opção avançada caso a reprodução progressiva exija controle fino de buffer; não necessariamente necessário no MVP.

## 6. Links prioritários para o desenvolvedor começar

1. https://elevenlabs.io/docs/api-reference/text-to-speech/stream
2. https://elevenlabs.io/docs/api-reference/streaming
3. https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/streaming-and-caching-with-supabase
4. https://elevenlabs.io/docs/overview/models
5. https://elevenlabs.io/pricing/api
6. https://developer.chrome.com/docs/extensions/reference/api/offscreen
7. https://developer.chrome.com/docs/extensions/reference/api/storage
8. https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
9. https://developer.chrome.com/docs/webstore/program-policies/policies
10. https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/tee
