# Changelog

All notable changes to **Yappable for Lovable** are documented here.
This project adheres to [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
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

[1.0.0]: https://github.com/lucioamor/yappable-for-lovable
[0.2.0]: https://github.com/lucioamor/yappable-for-lovable
[0.1.0]: https://github.com/lucioamor/yappable-for-lovable
