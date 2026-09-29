# Chat sites DOM: claude.ai and chatgpt.com

Live probes run on 2026-09-28 from a logged-in Chrome session, using MutationObservers and a 100–250 ms poller.
This document backs `src/chat-adapters.js` and `src/chat-narrator.js`.
Both sites ship frequent UI changes. If narration stops working, re-run the probes before touching the logic.

## claude.ai

| What | Selector / signal |
|---|---|
| Assistant reply row | `div[data-is-streaming]`. Only assistant rows have it. |
| Generation in progress | `[data-is-streaming="true"]`. Flips to `"false"` when the reply ends. This is the authoritative end signal. |
| Reply text | `.standard-markdown` inside the row. Blocks (`p`, `ul`, code wrapper) are appended while streaming. |
| Code block | A wrapper `div` holding a `<pre>` and a sibling language label (`js`, `python`). Drop the whole wrapper. |
| Citation chip (web search) | `span[data-not-prose]` containing `a[target=_blank]`, inline inside the `<p>`. Its text is the source domain. |
| Message actions | `[data-testid=message-actions]` (appears at the end). Includes a native `action-bar-read-aloud` button. |
| User message | `[data-testid=user-message]` |

Observed timeline for a 900-char reply with a list, code and a paragraph:
- 0 ms: new row appears with `data-is-streaming=true`.
- 0.75–3.5 s: text grows block by block.
- 3.5 s: the flag flips to `false` with the text already final.

A web-search prompt (EUR→BRL) finished in about 21 s, and the same flag worked.

## chatgpt.com

| What | Selector / signal |
|---|---|
| Assistant reply | `div[data-markdown-text-style="assistant-message"]` |
| Message id | `data-chatgpt-selection-message-id` on an ancestor. **Assigned only after streaming ends**, so it can't be used as a key while generating. |
| Generation in progress | The composer stop button (`aria-label="Parar"` in PT-BR, also matched by `Stop` and `data-testid="stop-button"`). It is present for the whole cycle, including the web-search phase. |
| Token rendering | `data-markdown-animated` on the reply, present only while tokens render. It was absent on short replies. |
| Code block | `div[class*=CodeBlock]` (CSS-module class, hash suffix varies). |
| Citation chip (web search) | `a[data-testid=chatgpt-citation]` inside `span[data-search-result-target]`, inline in the `<p>`. |
| Not present anymore | `data-message-author-role` and `data-testid^=conversation-turn`. Older selectors found online don't work. |

Observed timeline for a web-search + calculation prompt:

| t | State |
|---|---|
| 1.4 s | Stop button appears. No reply element exists yet (the model is thinking or searching). |
| ~16–19 s | Reply element appears with `data-markdown-animated`. Text streams quickly (~1–4 s). |
| ~21–22 s | Stop button gone, `data-markdown-animated` gone, message id assigned, text final. |

With a thinking model, the UI also shows "Pensou por 3s" and "Analisado" labels outside the markdown node. They are not read.

## gemini.google.com

Probed 2026-09-28 (Flash, PT-BR UI) with a search + calculation + code prompt. Angular app built from custom elements.
**Gemini does have a native TTS** ("Ouvir"), hidden in the reply's "⋯ Mostrar mais opções" menu.
It is not part of the always-visible action bar.

| What | Selector / signal |
|---|---|
| Reply | `model-response` → `message-content` (id `message-content-id-r_…`). Text in `message-content .markdown` (`p`, `response-element`). |
| Generation in progress | Stop button `aria-label="Parar resposta"`. It is present only for ~3 s at the start. The web-search phase that follows (~7 s, no text) has **no stop button** and no reliable busy flag. |
| End of reply | `<message-actions>` (thumbs up/down, regenerate, copy, ⋯) is added inside `model-response`. Timeline: message actions appeared ~1.1 s after the text became visible. This is the best end signal. |
| Code block | `<code-block>` (contains a `<pre>`) inside a `response-element`. |
| Citations | `<sources-list>` element. No inline chips seen. |
| Disclaimers | `finance-info-disclaimer`, `election-info-disclaimer`, `freemium-rag-disclaimer`. Must be excluded from spoken text. |
| Read aloud | `⋯` (`Mostrar mais opções`) → menu item "Ouvir". Another entry point is `tts-control-v2` (`.response-tts-container.hidden`) whose button (`aria-label` "Ouvir", then "Pausar") only became clickable through the menu. A direct `.click()` on it did nothing. |
| Playback | A **detached `<audio>`** (not in the DOM), `blob:` src, a **complete file** (14.7 s for ~115 chars ×2 + …), seekable, `preservesPitch=true`. Same as ChatGPT: `media-hook.js` adopts it with no changes. |

Verified: `playbackRate=1.75`, seeking (+5 s) and pause/play worked on that element.
The site's own button label stayed "Pausar" while we paused it from outside (cosmetic desync).

Timeline for the search prompt (times from the send click): stop button 0–3 s, silent search phase until ~10 s,
text visible at ~11 s (the whole short reply arrived in one poll tick), message actions at ~12 s.

**Implemented** in `chat-adapters.js`:
1. `lastReply` = last `model-response`. `isBusy` = the stop button, or (6 s after load) no `message-actions` yet on the last reply. The grace period keeps a finished reply that is still rendering at page load from being read as new.
2. `textOf` = `message-content` minus `code-block`, `sources-list`, `message-actions` and the disclaimers.
3. `readAloud` = click `⋯`, wait for the Material menu, click "Ouvir". It found the item after 100 ms.
4. Manifest: `gemini.google.com` added to `host_permissions` and both content scripts. Its `media-src` was not checked, but the site's own audio played.

## grok.com

Probed 2026-09-28 (Fast, PT-BR UI, logged in) with the same search + calculation + code prompt, plus two no-search prompts. **Adapter implemented** in `chat-adapters.js` (see "Grok adapter" below).

| What | Selector / signal |
|---|---|
| Assistant reply | `div[role=article][data-testid=assistant-message]` inside `div#response-<uuid>`. The uuid is the response id and is set at creation (unlike ChatGPT). |
| Text | `.response-content-markdown > .streamdown-chat-md`. **The user's prompt also uses `.response-content-markdown`**, so scope it to `assistant-message`. |
| Generation in progress | Composer stop button `aria-label="Parar a resposta do modelo"`. Timeline (from send): stop button 0–7 s, gone at ~7 s, text arriving from ~10 s (it grows in ~0.6 s for a short reply). **The stop button disappears before the text starts.** A "Trabalhou por 8s" label above the reply summarizes the search phase. So, like Gemini, it needs another busy signal, such as "last `assistant-message` empty or missing" or the action bar appearing. |
| End of reply | The action bar (Copiar, Copiar resposta, Criar link de compartilhamento, Like, Dislike, Regenerate, More actions) inside `#response-<uuid>`. Verified present when the reply was finished, but its appearance time was not measured. |
| Code block | `div.chat-code-block` containing a `<pre>` (with a header "Python" and a "Copiar" button). |
| Citations | `a.no-copy` inline chips whose text is the source name preceded by a word joiner (U+2060), e.g. "MarketWatch". The "5 sources" pill is outside the markdown. |
| WebSocket | `wss://grok.com/ws/mgw/` opened once at load (app messages, not the reply). Reply text streams over HTTP, not that socket (not confirmed). |

**Native TTS exists**: `More actions` (⋯) → menu → "Ler em voz alta" (a `div[role=menuitem]`; the menu is a Radix popover that closes on blur, so open it with a real click).
- Request: no fetch/XHR from the page. The `<audio>` element loads `GET https://grok.com/http/app-chat/read-response-audio-file/<response-uuid>?voiceId=ara` directly.
- **No text in the request** (only the response id and the voice `ara`), so the text can't be rewritten or prefixed. Same case as ChatGPT.
- Playback: a **detached `<audio>`** (`isConnected=false`, `preservesPitch=true`). While streaming, `duration` was `Infinity` and `seekable` was `[0, null]`. After the audio finished, `duration=18.09`.
- Control: `playbackRate=1.75`, `pause()` and `play()` worked, pitch is preserved. **Seeking never works**: `seekable` is `[0,Infinity]` while loading and `[0,0]` even after the audio ended (`duration` then becomes finite, e.g. 66.9 s). Every `currentTime` assignment lands on 0 (tested: set 30, ±15, set 10 → all 0.00). The stream has no range support.
- Grok also has a voice conversation mode (the waveform button in the composer). That is a separate live feature, not a reply reader.

Side effect during the probe: a Grok settings dialog ("Comportamento") opened on its own at some point, and no setting was changed.

### Grok adapter

Two things differ from the other sites, and both were learned the hard way:

1. **The "generating" signals end before the answer starts.** For a reply with a thinking or search phase (timeline of a 150-word prompt): stop button from 8.3 s to 20.3 s, the action bar (Copiar resposta…) present at 20.3 s while the answer text was **still empty**, and the text arriving only after that. The stop button label also varies: `Parar a resposta do modelo` at first, and a bare `Parar` seen during generation and while audio plays. Both are matched. The bare one being up during playback is harmless, because a reply already read is never read again.
   - `isBusy` = the long-label stop button, OR (within 90 s of the last time it was seen) the last `assistant-message` has no text yet. The 90 s tail is what covers the gap; without a recent stop button an empty message is ignored, so history and skeletons at page load or on switching chats are never read.
   - `settleMs` = 2000. After the text starts, the reply is read when it has not changed for 2 s.
2. **Text scope.** `.response-content-markdown` inside `[data-testid=assistant-message]` only. Citations (`a.no-copy`, with a U+2060 prefix), `div.chat-code-block` and the thinking container are excluded. `keyOf` is the `response-<uuid>` id.

`readAloud`: press `More actions` (⋯, `aria-label` is English even in the PT UI) with pointerdown/mousedown/pointerup/mouseup + click (a bare `.click()` doesn't open Radix menus; verified), then click the `[role=menuitem]` "Ler em voz alta". While reading, that item says "Parar de ler", so only the idle label matches and a second run can't stop the audio.

Grok cannot be rewritten (no text in the request), so Site mode reads its full reply with no prefix. The Yappable voice adds "Resposta do Grok:".

Because the audio stream is not seekable, `media-hook.js` now reports `seekable` in its state (a finite `seekable.end(0) > 0`), ignores `seek` commands otherwise, and the player greys out −15/+15. This applies to any site whose element isn't seekable.

Verified live (core adapter code pasted into the page, native flow): a no-search reply fired exactly once (305 characters, correct key), the ⋯ menu opened, "Ler em voz alta" was clicked and the audio started.

## What each site sends to its TTS (can the text be changed?)

Probed 2026-09-28 by wrapping `fetch`, XHR and `WebSocket` in the page and clicking the site's read-aloud.

| Site | Request | Text in the request? |
|---|---|---|
| claude.ai | `wss://claude.ai/api/ws/text_to_speech/text_stream?output_format,voice,tts_speed,client_platform,language,organization_uuid`. Client frames: `{"type":"text_chunk","text":"…"}`, `{"type":"close_stream"}`, `{"type":"keep_alive"}`. Server frames: binary audio. | **Yes.** The whole reply went in one `text_chunk`. |
| gemini.google.com | XHR `POST /_/BardChatUi/data/batchexecute?rpcids=XqA3Ic`, body `f.req=[[["XqA3Ic","[\"eclipse\",\"<text>\",\"en-BR\",null,2]",null,"generic"]]]&at=<token>`. `eclipse` is the voice and `en-BR` the locale. | **Yes.** |
| chatgpt.com | `GET /backend-api/synthesize?conversation_id&message_id&voice&format` | **No.** Only the message id. The server reads the stored message. |
| grok.com | `<audio>` GET `/http/app-chat/read-response-audio-file/<response-id>?voiceId=ara` | **No.** Only the response id and the voice. |

`media-hook.js` rewrites the text on Claude and Gemini (`cmd: "tts"`):
- **prefix** ("Resposta do Claude:") is added to every read, including the user's own clicks on the site's button. It is localized from the extension language (pt, en, es, fr, de, it).
- **override** (the on-device summary, when `mode` isn't `completo`) replaces the text for the next read only, and expires after 60 s. On Claude the extra `text_chunk` frames of a replaced read are dropped. On Gemini the locale becomes the summary language.
- ChatGPT can't be rewritten, so its Site mode reads the full reply with no prefix. Yappable mode adds the prefix on all three.

Verified live: Claude sent `Resposta do Claude: <summary>` and played. Gemini sent `Resposta do Gemini: …` with lang `pt-BR` and produced 10.8 s of audio for the summary. With only the prefix, Gemini's audio grew from 14.7 s to 17.9 s.

## Native read-aloud (site TTS)

| | claude.ai | chatgpt.com |
|---|---|---|
| Button | `[data-testid=action-bar-read-aloud]`. The label toggles between "Ler em voz alta" and "Pausar". | `button[aria-label="Ler em voz alta"]` (localized, no test id). While playing it turns into "Parar leitura em voz alta". |
| Playback | **Web Audio**. A new `AudioContext` per read, with ~100 ms PCM `AudioBuffer`s (48 kHz) scheduled back to back on `AudioBufferSourceNode`s. Chunks arrive **2–3× faster than real time** (8.6 s of audio buffered in ~4 s). Stop closes the context. | A **detached `<audio>`** (not in the DOM) fed by `MediaSource` (`blob:`). Seekable, `preservesPitch=true`. |
| Control from an extension | No element exists, so we capture the chunks in the MAIN world, mute the originals (reroute to a 0-gain node), and replay them through our own `<audio>` built from a WAV blob. The blob is rebuilt while the stream grows. Seeking and pitch-preserving speed both work. | We adopt the element from a `HTMLMediaElement.prototype.play` hook in the MAIN world. `playbackRate`, `currentTime` and `pause()` all work. |
| CSP `media-src` | Allows `blob:` | Allows `blob:` |

Both need **MAIN world** hooks (`src/media-hook.js`, `document_start`), because the isolated world can't see detached elements or page-created audio nodes.

Verified live on 2026-09-28 (Claude, Site mode):
- The reply finished, the button was clicked automatically, and the audio was captured (5 rebuilds) and played in the modal.
- Alt+. twice set 1.5× (pitch preserved), and Alt+J went back 15 s (22.8 → 7.8).
- Alt+K paused and resumed, and Alt+L went forward 15 s.
- Esc stopped playback, and no keystroke leaked into the composer.

On ChatGPT the button lookup mapped 3 of 3 replies to their own buttons. Rate, seek and pause were verified by hand on the element.

## Player and voice modes

- **Site mode:** clicks the site's own read-aloud button for the finished reply. The voice is free, and the controls come from `media-hook.js`.
- **Yappable mode:** runs the on-device Prompt API (`LanguageModel`) with the shared `mode` setting (fast/beginner/advanced; `completo` = full text), then ElevenLabs if a key is set, otherwise the system voice. If the model is missing, not yet downloaded, or fails, the full reply is read. `LanguageDetector` picks the voice language for full-text reads.
- **Modal (`src/player-ui.js`, shadow DOM):** Site/Yappable toggle, −15 / play-pause / +15 / stop, and speed 0.5–3× in 0.25 steps. The speed is persisted as `playerRate` and applies to every source.
- **Shortcuts:** Alt+K (play/pause), Alt+J (−15 s), Alt+L (+15 s), Alt+, (slower), Alt+. (faster), Alt+0 (1×), Esc (stop while playing).
- **System-voice limits:** seeking works at chunk granularity (~220 chars), because speech has no timeline. The position also only moves per chunk when the voice emits no boundary events, as Google voices don't.

## Pitfalls found

1. **Keying by message id while streaming failed.** The ChatGPT id appears only at the end, so the first version never fired on search replies.
2. **The "text grew, so it's live" heuristic re-read old replies.** ChatGPT re-renders previous replies (citation chips, action bar) when a new prompt is sent.
3. **`innerText` on a detached clone glues list items** ("Green teaBlack tea"). Leaf blocks are joined explicitly instead.
4. **Citation chips leak the domain into speech** ("…1,779 BRL. wise"). Both sites' chips are removed.

## Detection design (current)

`watch()` runs a per-tab generation-cycle state machine:

```
idle ──(isBusy seen)──▶ armed ──(!isBusy && text stable ≥ settleMs)──▶ read LAST reply, dedupe by key
```

- `isBusy`: Claude uses any `[data-is-streaming="true"]`. ChatGPT uses the stop button or `[data-markdown-animated]`.
- `settleMs`: 0 for Claude and 1200 ms for ChatGPT, as a guard in case the stop button disappears a beat before the final text.
- History is never read, because no busy phase is observed when a page loads or when you switch conversations in the SPA.
- **Known limit:** if you stop a generation manually, the partial reply is read.

## Verified end-to-end (injected into the pages, native TTS)

- ChatGPT: the conversation reloaded with 3 prior replies and none were spoken. A search prompt was then spoken once, about 1.2 s after it finished, without the citation.
- Claude: the reloaded conversation was not spoken. A search prompt was spoken once. The citation leak was fixed afterwards, and the fix was verified on the same DOM.

## Not yet tested

- Loading the packed extension (tests injected the code into the page's main world with a `chrome.storage` stub).
- ElevenLabs on these sites. The CSP `media-src` of both sites allows `blob:`, so it should play.
- Tables, math (KaTeX), Claude artifacts and tool-use blocks, and Claude "thinking" blocks (all `.standard-markdown` in the row are read).
- Canvas and Projects views, and the Claude desktop or mobile apps.
