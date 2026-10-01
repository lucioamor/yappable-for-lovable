# Changelog

All notable changes to **Yappable for Lovable** are documented here.
This project adheres to [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

---

## [1.3.0] — 2026-09-30

### Changed
- Yappable for Lovable is Lovable-only again. Reading ChatGPT, Claude, Gemini and Grok replies moved
  to its own extension, **Yappable for your AI**, so this one asks for no chat-site access. Permissions
  are now `lovable.dev` and `api.elevenlabs.io`.
- The daily statistics strip (words, minutes, narrations) now sits on the main popup screen.
- The Stop button stays grey while nothing plays and turns red only while a Lovable tab is making sound.
- Store and manifest descriptions cover Lovable only.

### Fixed
- ElevenLabs setup saves the API key before remote verification, uses the current v2 voices endpoint,
  and selects a voice actually available to the account instead of assuming a legacy default voice ID.
- The settings panel has an explicit **Save & verify key** action, so saving no longer depends on the
  password field losing focus.
- Flash v2.5 no longer forces the Enterprise-only text-normalization mode, preventing HTTP 400
  followed by an unnoticed fallback to the browser's native voice.

### Added
- Eleven v4, v4 Turbo and v3 Conversational are available in model selection; deprecated Turbo v2.5
  was removed, and expressive v3/v4 models use audio-tag-safe shaping.
- Local daily narration statistics (words, estimated minutes, narration count).

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
