# Changelog

All notable changes to **Yappable for Lovable** are documented here.
This project adheres to [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

---

## [1.3.0] — 2026-09-30

### Fixed
- Play/pause and the Alt+K shortcut in a chat tab's player now act only on that tab's own audio.
  Pausing in Gemini no longer pauses Grok (and vice versa): the shared browser speech queue is
  cancelled only while the tab itself is speaking.
- The waveform beside the title (and the top bar) animates only while sound is really coming out.
  A paused, buffering, dropped or finished site audio element freezes it or hides it, instead of
  leaving it moving on its own.

### Changed
- The Platforms panel is now an inline tab next to Narration instead of a modal, with one compact
  row per platform (icon, voice, switch) and a one-line daily-stats strip.
- The Stop button stays grey while nothing plays and turns red only while a Yappable tab is making sound.
- Store short description and manifest description now cover Lovable, ChatGPT, Claude, Gemini and Grok.
- One voice at a time across tabs. Whoever starts playing (a queued reply, or the user's click on the
  site's own read-aloud button) pauses, never stops, the other tabs, which can be resumed from their
  own player. A paused reading keeps its turn for up to 10 minutes, so an automatic reply from another
  LLM waits instead of replacing it.

### Added
- The player shows what plays in other tabs and the queue ("Up next: Gemini · Claude"). With nothing
  playing in the tab, play (or Alt+K) starts the next queued reading; if a queued reading is paused,
  it resumes it.

---

## [1.2.0] — 2026-09-29

### Added
- Every ChatGPT, Claude, Gemini, and Grok narration now starts by identifying the LLM. The
  Platforms panel offers concise and casual introductions, localized to the narration language.
- A deterministic cross-tab FIFO coordinates automatic chat narration. Replies play in completion
  order and never overlap; ElevenLabs audio can be generated while waiting for its turn.
- Optional ElevenLabs voice selection per LLM, with the global ElevenLabs voice as fallback.
- Chat pages now show the same full-width top waveform feedback used by Lovable, in addition to the
  floating player's compact activity indicator.

### Changed
- In Site mode, Claude and Gemini inject the introduction into the site's original TTS request.
  ChatGPT and Grok do not expose text in their TTS requests, so Yappable speaks the introduction
  first and then starts the site's original voice.
- The coordinator uses Chrome's audible-tab signal only as restart recovery; normal ordering is the
  explicit FIFO rather than random retry delays.

---

## [1.1.0] — 2026-09-29

### Fixed
- ElevenLabs setup now saves the API key before remote verification, uses the current v2 voices
  endpoint, and selects a voice actually available to the account instead of assuming a legacy
  default voice ID.
- The settings panel now has an explicit **Save & verify key** action, so saving no longer depends
  on the password field losing focus.
- Flash v2.5 no longer forces the Enterprise-only text-normalization mode, preventing HTTP 400
  followed by an unnoticed fallback to the browser's native voice.

### Added
- A Platforms tab in the popup adds individual on/off controls with local favicons for Lovable,
  ChatGPT, Claude, Gemini, and Grok. Disabling one platform stops its active audio immediately.
- A global Stop button silences native, ElevenLabs, and site-provided audio across supported tabs.
- Chat pages now show the waveform indicator while audio is active.
- Local daily narration statistics retain words, estimated minutes, narration count, and per-platform
  totals for future weekly, monthly, and yearly summaries.
- Eleven v4, v4 Turbo, and v3 Conversational are available in model selection; deprecated Turbo v2.5
  was removed, and expressive v3/v4 models use audio-tag-safe shaping.
- Chat narration on claude.ai and chatgpt.com (`src/chat-adapters.js`, `src/chat-narrator.js`):
  reads each finished assistant reply aloud (code blocks and citation chips stripped).
  Full reply is always spoken (no length cap). Sync keys `chatNarration` (default on) and
  `chatVoiceMode`: "site" clicks the site's own read-aloud, "yappable" runs the on-device
  interpretation layer + ElevenLabs (or system voice).
- Gemini support (gemini.google.com): reply detection and the native "Ouvir" voice.
- Grok support (grok.com): reply detection (its stop button ends before the answer starts, so the
  end is detected by the text settling) and the native "Ler em voz alta". Grok's audio stream is
  not seekable, so the player greys out −15/+15 whenever the element reports no seekable range.
- Spoken prefix before every chat reply ("Resposta do Claude:", "Resposta do Gemini:", localized;
  sync key `chatAnnounce`, default on). On Claude and Gemini `media-hook.js` rewrites the text
  the site sends to its own TTS, so the site's voice also reads the on-device summary when
  `mode` isn't `completo`. ChatGPT sends no text to its TTS, so Site mode reads it unchanged.
- Universal player modal (`src/player-ui.js`) with play/pause, ±15 s, speed 0.5–3×
  (remembered as `playerRate`) and shortcuts Alt+K / Alt+J / Alt+L / Alt+, / Alt+. / Alt+0 / Esc.
- `src/media-hook.js` (MAIN world) makes the sites' native TTS controllable: adopts
  ChatGPT's `<audio>`, captures Claude's Web Audio stream into a seekable WAV player.
  DOM and audio notes in `docs/CHAT-SITES-DOM.md`.

---

## [1.0.0] — 2026-06-29

### Improved

- Extension icon now has a transparent background, looking better on dark themes and in the Chrome toolbar.

### Fixed

- ElevenLabs API key is no longer lost when migrating settings from synced to local storage.
- Network failures during setup, voice list loading, or audio generation no longer leave the extension stuck — each call now has a timeout.
- Native narration no longer silently stalls in Chrome cases where the speech end event is never fired.
- Language flags previously loaded from an external CDN are now bundled locally — the popup works offline and makes no external requests.

### Quality

- Added a dependency-free QA command that checks syntax, manifest references, version consistency, narration modes, risk detection, and completion-sound interception.

---

## What's new in 0.2.0 — *Speaks your language, narrates live*

The biggest update since launch. v0.2.0 turns Yappable from a "read the final
answer" tool into a running commentary on your build — in your language, the
whole way through.

- **🌍 Always in your language.** Lovable often mixes English and your native system language in the same session. Yappable now translates *everything* it says — narration, live progress, and alerts — on-device into the language you pick, no matter what language Lovable replies in.
- **🎬 Live play-by-play.** Verbose mode now reads Lovable's background-task widget in real time: the task label once, then each step as it actually happens — instead of waiting for the final response. Near-duplicate steps are skipped so you don't hear the same thing twice.
- **🔊 Knows what Lovable is doing.** The silence monitor reads the real on-screen status word ("Transcribing", "Generating") with elapsed time and the task label, instead of a generic "in progress."
- **👋 First-run onboarding.** A clean full-screen setup opens on install: drop in an ElevenLabs key (verified on the spot) for premium voice, or continue on the built-in native voice in one click. Your language is set up front.
- **🎚️ Voice & engine overhaul.** A Native / ElevenLabs engine badge right in the popup, a language flag pill in the topbar, native voices filtered to your language, and much better ElevenLabs defaults out of the box.
- **📊 Animated waveform bar.** Optional visual feedback at the top of the page while Yappable is speaking (toggle in the popup).
- **↩ Repeat button & instant stop.** Replay the last narration anytime, and flipping narration off stops speech immediately across every Lovable tab.

---

## [0.2.0] — 2026-06-18

### Added

- **Automatic translation of all speech.** Narration, live progress, and alerts are always spoken in your chosen language — even when Lovable replies in a different one.
- **First-run onboarding.** A guided full-screen setup opens on first install: paste an ElevenLabs key (verified on the spot) or continue with the native voice in one click.
- **Real-time progress narration.** In verbose mode, Yappable now reads what Lovable is doing step by step as it happens — not just at the end.
- **Real status in the silence monitor.** Instead of a generic "working…", the extension now says what Lovable is actually doing ("Transcribing", "Generating", etc.) along with elapsed time.
- **Animated waveform bar.** Optional visual feedback on the page while narration is active (toggleable from the popup).
- **Repeat button.** A ↩ button in the popup to replay the last narration at any time.
- **Engine indicator.** The popup clearly shows which engine is active (Native or ElevenLabs); clicking it jumps to voice settings.
- **Language flag pill.** The selected language appears as a flag pill in the popup topbar.

### Improved

- Turning narration off now stops audio immediately across all open Lovable tabs.
- The popup dims all controls when narration is off, making the active state obvious at a glance.
- The language selector moved from the settings modal to the main topbar, where it's always reachable.
- The sounds section was simplified — no more confusing accordions or state chips.
- Native voices are now filtered to the selected language, prioritizing the most natural options available.
- ElevenLabs defaults tuned for a better out-of-the-box voice (Flash v2.5 model, Jessica voice).

### Fixed

- In verbose mode, near-identical steps are no longer repeated — Yappable compares each step to the last one actually narrated and skips duplicates.
- Language flags that appeared as blank squares on Windows Chrome.

---

## [0.1.0] — 2026-06-05

Initial public release.

### Added

- **Auto-narration.** Yappable detects when Lovable finishes a response and reads it aloud — no clicking required.
- **Four narration modes** — Fast, Beginner (default), Advanced, and Full — to control the level of detail.
- **Response cleanup and restructuring.** Lovable's output is interpreted before being narrated: markdown, code blocks, and file paths are removed; what remains is reorganized into what was done, why it matters, and what to validate.
- **Risk detector.** Alerts you when a response touches unvalidated metrics, UI copy, database changes, or SEO adjustments.
- **On-device AI summarization.** When available, uses Chrome's built-in Gemini Nano to summarize before narrating — no data leaves the browser.
- **Optional premium voice** via ElevenLabs.
- **Silence monitor**, error alert chime, verbose mode, and multi-tab awareness (project name is announced when more than one Lovable tab is open).
- Activates only on `lovable.dev` and makes no unnecessary network requests.

[1.2.0]: https://github.com/lucioamor/yappable-for-lovable
[1.1.0]: https://github.com/lucioamor/yappable-for-lovable
[1.0.0]: https://github.com/lucioamor/yappable-for-lovable
[0.2.0]: https://github.com/lucioamor/yappable-for-lovable
[0.1.0]: https://github.com/lucioamor/yappable-for-lovable
