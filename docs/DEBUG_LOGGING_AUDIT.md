# Yappable — Debug Logging System · QA Audit Report

**Version:** extension 0.2.0 · feature branch "structured diagnostics"
**Author of changes:** assistant (Cowork session)
**Date:** 2026-06-25
**Purpose of this document:** give a second reviewer (human or LLM) everything needed to audit the change end‑to‑end: the goal, the design, every instrumented point, the data contract, the privacy guarantees, the UI surface, known limitations, and a concrete QA checklist with expected outputs.

---

## 1. Objective

The Yappable pipeline degrades **silently** by design — when one stage fails it falls through to a fallback without surfacing an error:

- TTS engine: ElevenLabs → native voice → (drain fallback)
- Spoken‑text generation: Prompt API → Summarizer/Nano → deterministic renderer
- Progress translation: on‑device Prompt API → verbatim (screen language)
- Waveform: real (routed through Web Audio `AnalyserNode`) → simulated bars

Because failures are swallowed, the raw console gives no granularity about **which** link broke, **with what data**, and **where the data came from**. Two concrete symptoms motivated this work:

1. **"I see the waveform but hear nothing."** The waveform can animate (in *simulated* mode) while audio is muted — with no error logged.
2. `[Yappable] translate failed, verbatim: Error: translate create timeout` — a swallowed translation timeout, one of several scattered `console.warn`s.

**Goal:** add a structured diagnostic layer that records every operation/hook (what was attempted, which hook, the result/failure, and the relevant parameters), mirrored to the page console **and** captured so the user can **download** and **clear** logs from the popup — without opening DevTools. Controlled by a single on/off toggle. Secrets must never be logged.

---

## 2. Design overview

A single logger module, `src/logger.js`, exposes `YapLog` on the global object (`self`/`globalThis`). It is loaded into all three extension contexts so every operation across the extension lands in one place:

| Context | How the logger is loaded |
|---|---|
| Content script (lovable.dev pages) | First entry in the `content_scripts` js array (before `content.js`) |
| Service worker (`background.js`) | `importScripts("logger.js")` at top level |
| Popup page | `<script src="../src/logger.js">` before `popup.js` |

**One switch.** All recording is gated by `chrome.storage.local.debug` (boolean). With debug **off**, the logger is fully inert — no recording, no console output, zero overhead. With debug **on**, each event is:

1. Pushed to an in‑memory ring buffer (per context, cap 2000).
2. Mirrored to that context's `console` with the `[Yappable]` tag (level by outcome: `ok`/`info` → `log`, `fallback` → `warn`, `fail` → `error`).
3. Appended (debounced ~700 ms, merge‑append, capped 600) to a single persisted array in `chrome.storage.local.yapLogs`, shared by all three contexts.

**Download path (popup).** The popup merges the **live** in‑memory buffer of the active Lovable tab (freshest pipeline view, pulled via the `LN_GET_LOGS` message) with the **persisted** `yapLogs` array (which also contains background + popup events), de‑duplicates by `ctx|seq|iso`, sorts chronologically, and serializes to a readable `.txt` file. If no Lovable tab responds, it falls back to the persisted array alone.

**Clear path (popup).** Removes `yapLogs` from storage and broadcasts `LN_CLEAR_LOGS` to every `https://lovable.dev/*` tab so their in‑memory buffers reset.

---

## 3. Files changed

| File | Type | Summary |
|---|---|---|
| `src/logger.js` | **new** | The global `YapLog` logger: ring buffer, persistence, console mirror, redaction, timer API. |
| `manifest.json` | edit | Added `src/logger.js` as the first content script in the document_idle array. |
| `src/content.js` | edit | `const L = globalThis.YapLog` (no‑op fallback); instrumented the 4 pipeline stages + warmups + error toast + config load; replaced 6 scattered `console.warn`s; added `LN_GET_LOGS` / `LN_CLEAR_LOGS` message handlers. |
| `src/background.js` | edit | `importScripts("logger.js")` + `L`; logged install, initial language, tab counting. |
| `popup/popup.html` | edit | New **Diagnostics** section in the Settings modal (toggle + Download + Clear + count); `.diag-note` style; load `logger.js`. |
| `popup/popup.js` | edit | `L` ref; `setDebug()`; toggle/download/clear handlers; merge of live+stored logs; instrumented key/voice/narrate; synced the existing 5‑click easter egg and storage listener with the new checkbox. |

No existing module logic (renderer, ir‑builder, risk‑detector, speech‑shaping, silence‑monitor) was modified — only call sites were instrumented.

---

## 4. Log entry data contract

Each entry produced by `record()` in `src/logger.js`:

```jsonc
{
  "seq": 12,                       // monotonic ordinal within this context's lifetime
  "t": 1750000000000,              // Date.now() epoch ms (sort key)
  "iso": "2026-06-25T12:00:00.000Z",
  "ctx": "proj:ab12cd34",          // short context tag (project id / pathname / worker)
  "stage": "playback",             // see stage taxonomy below
  "hook": "_wfStartEleven",        // function / call site
  "action": "human-readable attempt description",
  "outcome": "ok|info|fallback|fail",
  "detail": { /* redacted free-form object */ },
  "ms": 134                        // present only for timed events (YapLog.start)
}
```

**Stage taxonomy:** `config`, `dom`, `interpret`, `translate`, `engine`, `playback`, `warmup`, `error`, `install`, `tabs`, `popup`, `misc`.

**API surface (`globalThis.YapLog` / `self.YapLog` in extension contexts):**

- `ok(stage, hook, action, detail)`
- `info(stage, hook, action, detail)`
- `fallback(stage, hook, action, detail)`
- `fail(stage, hook, action, detail)`
- `start(stage, hook, action, detail) → end(outcome, extraDetail)` — measures duration, merges detail.
- `isOn()`, `dump()` (in‑memory snapshot), `clear()`.

---

## 5. Instrumentation inventory

Every call site added, grouped by the four stages the feature targets, plus support stages. Use this as the checklist of "what should appear in a log".

### 5.1 DOM read — *what was read, from where*
| Hook | Outcome(s) | Key detail fields |
|---|---|---|
| `commitNarrate` (content) | ok | `id`, `bodySource` (`data-message-copy-text` \| `.prose-chat innerText`), `taskTitleChars`, `bodyChars`, `reload` |
| `enqueueVerboseLocalized` (content) | info | `chars`, `preview` (progress snippet read from screen), plus a discard event for stale state |

`readMessage` was extended to return `bodySource` so the origin of the narrated body is auditable.

### 5.2 Interpretation — *which engine produced the speech, in→out*
| Hook | Outcome(s) | Key detail fields |
|---|---|---|
| `buildSpeech` (content) | ok / fallback | `mode`, `inChars`, `outChars`, `source` (`prompt`\|`nano`\|`deterministic`), and on fallback `promptReady`, `nanoUsable`, `longEnough` |
| `runMode` (content) | fallback | `mode`, `err` (Prompt API failed) |
| `summarizeWithNano` (content) | fallback | `err` (Nano failed, keeping deterministic) |

### 5.3 Translation — *the user's reported error*
| Hook | Outcome(s) | Key detail fields |
|---|---|---|
| `localizeLine` (content) | ok / fallback | `lang`, `inChars`, `outChars`, `changed`; on failure `err` (e.g. `translate create timeout`) → speaks verbatim |

### 5.4 Engine / connection — *which engine, what request, what result*
| Hook | Outcome(s) | Key detail fields |
|---|---|---|
| `drain` (content) | info / fallback / fail | `engine` chosen, `kind`, `chars`; fallback to native with `err`; double‑failure `fail` |
| `speakEleven` (content) | ok / fail / info | timed POST: `voiceId`, `model`, `format`, `lang`, `chars` → `status`, `bytes`, `ms`; timeout/error variants; **cache hit** logged as info (no network) |
| `loadElevenVoices` (popup) | ok / fail | timed GET `/v1/voices`: `force` → `count`, `ms` |

> **API key:** never logged. The ElevenLabs key travels only in the `xi-api-key` request header (not in any `detail` object), and the logger's `redact()` masks any key matching `/key|token|secret|authorization|xi-api|password|cookie/i` regardless.

### 5.5 Playback — *the waveform/no‑sound diagnosis*
| Hook | Outcome(s) | Key detail fields |
|---|---|---|
| `_wfStartEleven` (content) | ok / **fallback** / fail | `audioCtxState`, `routed` (true=real waveform), `audioUnlocked`. The **fallback** event fires for the exact "non‑running AudioContext → simulated waveform, audio plays direct" case — i.e. the muted‑but‑animating scenario. |
| `speakEleven` audio element (content) | ok / fail | `onplaying` → `bytes`, `volume`, `muted`; `onerror` → media `code`; `play()` rejection → `err` |
| `speakNative` (content) | ok / fail | `onstart` → `voice`, `lang`, `rate`, `volume`, `chars`; `onerror` → `error` |

**Interpreting the target bug:** if you see `playback/_wfStartEleven … FALLBACK {routed:false, audioCtxState:"suspended"}` followed by **no** `playback/speakEleven … OK "áudio ElevenLabs tocando"`, the audio element itself never played (autoplay blocked) — the fault is the element, not the routing. If you instead see the `onplaying` OK with `muted:false, volume>0` yet hear nothing, the OS/output device or the routed graph is the suspect.

### 5.6 Support stages
| Hook | Stage | Notes |
|---|---|---|
| storage load (content) | `config` | engine, lang, mode, `hasElevenKey`, verbose, waveform, cue, errorAlert |
| `warmupSummarizer`, `warmupPromptModel` (content) | `warmup` | ok when ready; fallback when "not ready yet (retry on first gesture)" |
| `onErrorDetected` (content) | `error` | Lovable "Try to fix" toast detected: `detailChars`, `detailPreview` |
| `onInstalled` (background) | `install` | reason, initial UI language → resolved lang |
| `countLovableTabs` (background) | `tabs` | `count` |
| `elevenKey` change, `triggerNarrateNow` (popup) | `config`/`popup` | key updated (`hasKey`, `changed`); re‑narrate request (`mode`) |

---

## 6. UI surface (popup → ⚙ Settings → Diagnostics)

- **Debug logging** toggle (`#debug`, bound to `storage.local.debug`). Discoverable; the legacy 5‑click‑on‑logo easter egg still works and stays in sync.
- **⬇ Download logs** (`#downloadLogs`) → `yappable-log-<ISO>.txt`. Header + one line per entry: `[ISO] [ctx] stage/hook · action → OUTCOME (ms)  {detail-json}`. Reports `live+stored` vs `stored` origin.
- **🗑 Clear** (`#clearLogs`) → removes `yapLogs` and broadcasts `LN_CLEAR_LOGS`.
- **Count** (`#logCount`) refreshes when the Settings modal opens and after actions.
- The pre‑existing read/observed debug panel (`#debugPanel`) still shows when debug is on.

---

## 7. Privacy & security

- **Single switch, off by default** — no capture unless the user enables debug.
- **Secret redaction** — `redact()` masks values of keys matching `/key|token|secret|authorization|xi-api|password|cookie/i` to `‹redacted:N›`, recursively, depth‑capped (4), array‑capped (30), long strings truncated to 600 chars. The ElevenLabs key is additionally never placed in any `detail`.
- **No new network calls** — the logger only writes to `chrome.storage.local`. It does not transmit anything.
- **Local only** — logs live in the browser; the user explicitly exports via Download.
- **Storage footprint** — persisted copy capped at 600 entries (ring‑trimmed); in‑memory at 2000 per context.

---

## 8. Known limitations / risks (please scrutinize)

1. **Cross‑context persisted merge race.** Three contexts read‑modify‑write `yapLogs` (debounced). Under heavy concurrent writing one flush can overwrite another's append, losing some *persisted* entries. The active tab's *in‑memory* buffer is unaffected and is the primary download source. Acceptable for a single‑active‑tab debug tool; flag if you consider it material.
2. **`createMediaElementSource` is irreversible per element.** The routing decision in `_wfStartEleven` is unchanged behaviorally — only logging was added. Confirm no added log call runs before that decision in a way that changes timing. (It does not; logs are after the branch.)
3. **Service worker lifetime.** Background entries are sparse and may be flushed shortly before the worker sleeps; the debounce (700 ms) could in theory drop the last background event if the worker is killed immediately. Low impact.
4. **`importScripts("logger.js")` path.** Resolves relative to `src/background.js` → `src/logger.js`. Verify in a real MV3 load that the worker registers (classic worker; no `"type":"module"` in manifest, so `importScripts` is valid).
5. **`dedupe key` `ctx|seq|iso`.** `seq` resets per context lifetime; `iso`+`t` disambiguate across reloads. Collisions are improbable but not impossible. Flag if stricter identity is desired.
6. **No log rotation by size in bytes**, only by entry count. Very large `detail` strings are truncated at 600 chars each, bounding worst case.

---

## 9. Verification status (important for the auditor)

- `npm run qa` passed on the on-disk files in the Windows workspace on 2026-06-25.
- The QA script runs `node --check` on every JavaScript file under `src/`, `popup/`, `scripts/`, and `tests/`, then runs `node --test tests/*.test.js`.
- Result: 10 tests passed, 0 failed.
- `manifest.json` is internally consistent and references `src/logger.js` as the first document-idle content script.
- Follow-up fixes from this audit: `src/background.js`, `popup/popup.js`, and `src/content.js` now read the logger through `globalThis.YapLog` instead of assuming `self` exists; `src/logger.js` also attaches to `globalThis` when `self` is unavailable.
- Follow-up robustness fix from this audit: the popup live+stored merge now filters malformed log entries before de-duping/sorting, so a corrupted `yapLogs` array cannot crash log download/count rendering.

Canonical checks run:

```bash
npm run qa     # node --check on every src/popup/scripts/tests js + node --test
```

---

## 10. QA test cases (manual, in a real browser)

Load the unpacked extension, open a `lovable.dev/projects/<id>` page, then open the popup → ⚙ → Diagnostics.

| # | Steps | Expected |
|---|---|---|
| T1 | Toggle **Debug logging** OFF, trigger a narration | No `[Yappable]` structured lines in the page console; `Download` says "Turn on Debug logging first." |
| T2 | Toggle ON, send a Lovable prompt, wait for completion | Console shows a sequence: `dom/commitNarrate … OK`, `interpret/buildSpeech … OK`, `engine/drain … INFO`, then either `engine/speakEleven … OK` + `playback/speakEleven … OK "tocando"` (ElevenLabs) or `playback/speakNative … OK` (native) |
| T3 | With ElevenLabs engine + valid key, narrate | `engine/speakEleven … OK {status:200, bytes>0, ms}`; **no** plaintext key anywhere in console or downloaded file |
| T4 | Reproduce muted‑but‑animating (e.g. narrate before clicking the page) | `playback/_wfStartEleven … FALLBACK {routed:false, audioCtxState:"suspended"}`; diagnose per §5.5 |
| T5 | Force a translation timeout (verbose mode, slow model) | `translate/localizeLine … FALLBACK {err:"translate create timeout"}` and speech proceeds verbatim |
| T6 | Click **⬇ Download logs** | A `yappable-log-*.txt` downloads; header present; entries from content **and** background (e.g. `tabs/countLovableTabs`) appear; origin reads `live+stored` |
| T7 | Click **🗑 Clear**, reopen Settings | Count shows "no logs yet"; a fresh narration starts a new log |
| T8 | Open a second Lovable tab, narrate in both, download from each | Logs from both contexts present in the merged store (note the §8.1 race caveat) |
| T9 | Disable debug mid‑session | Recording stops; previously captured logs remain downloadable until cleared |
| T10 | Verify no regression: with debug OFF, full narration still works exactly as before | Identical behavior to pre‑change build |

---

## 11. Reviewer prompt (optional, for the second LLM)

> You are auditing a Chrome MV3 extension change that adds structured debug logging. Verify: (a) the logger is fully inert when `storage.local.debug` is false; (b) the ElevenLabs API key cannot appear in any log entry or downloaded file (check both the redaction regex and every `detail` object passed at call sites in `src/content.js` and `popup/popup.js`); (c) no added log call alters control flow or timing of the audio pipeline (especially `_wfStartEleven`, `speakEleven`, `drain`); (d) `importScripts("logger.js")` is valid for the classic service worker; (e) the live+stored merge in `popup.js` cannot crash on malformed/empty stored data; (f) brace/paren balance and that each file passes `node --check`. Report any path where a secret, page content beyond intended previews, or PII could leak into logs.
